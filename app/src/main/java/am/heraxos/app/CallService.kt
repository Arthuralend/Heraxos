package am.heraxos.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Фоновая служба: держит соединение с сервером Ahazang и показывает входящие звонки на весь экран. */
class CallService : Service() {

    companion object {
        const val CH_SERVICE = "hx_service"
        const val CH_CALL = "hx_call_v2"
        const val CH_MSG = "hx_msg"
        const val CH_ONGOING = "hx_ongoing"
        const val NID_SERVICE = 1
        const val NID_CALL = 2
        const val NID_MISSED = 3
        val RING = longArrayOf(0, 900, 600, 900, 600, 900, 600)

        @Volatile var instance: CallService? = null

        // Состояние текущего звонка (сообщает веб-приложение через мост)
        @Volatile var callActive = false; private set
        @Volatile var callVideo = false; private set
        @Volatile var callId: String? = null; private set
        private var callStarted = 0L

        /** Звонок начался / изменился / закончился. Вызывается, пока приложение на экране. */
        fun setCall(c: Context, active: Boolean, video: Boolean, id: String) {
            if (active && !callActive) callStarted = System.currentTimeMillis()
            callActive = active; callVideo = active && video
            callId = if (active) id.ifEmpty { callId } else null
            val s = instance
            if (s != null) s.onCallChanged() else if (active) start(c)
        }

        fun start(c: Context) {
            if (Prefs.token(c) == null) return
            val i = Intent(c, CallService::class.java)
            runCatching { c.startForegroundService(i) }
        }

        fun restart(c: Context) {
            instance?.reconnectNow() ?: start(c)
        }

        fun stop(c: Context) { c.stopService(Intent(c, CallService::class.java)) }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var backoff = 1000L
    private var stopped = false
    private var gen = 0

    var currentCall: String? = null; private set
    private var currentFrom: String? = null      // логин (для открытия чата)
    private var currentTitle: String? = null     // как показать: имя из контактов или номер
    private var currentVideo = false
    private val nm by lazy { getSystemService(NotificationManager::class.java) }
    private var cpuLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannels()
        applyForeground()
        if (callActive) holdLocks(true)
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun serviceNote(): Notification {
        if (!callActive) return Notification.Builder(this, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Ahazang")
            .setContentText("Готов принимать звонки")
            .setOngoing(true)
            .setContentIntent(openApp(null, 10))
            .build()
        val hang = PendingIntent.getBroadcast(this, 24,
            Intent(this, ActionReceiver::class.java).setAction(ActionReceiver.HANGUP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(if (callVideo) "Идёт видеозвонок Ahazang" else "Идёт звонок Ahazang")
            .setContentText("Нажмите, чтобы вернуться к звонку")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(callStarted)
            .setShowWhen(true)
            .setColor(0xFFC96442.toInt())
            .setContentIntent(openApp(null, 11))
            .addAction(Notification.Action.Builder(null, "Завершить", hang).build())
            .build()
    }

    /**
     * Тип фоновой службы. Во время звонка добавляем «микрофон» (и «камеру» при видео): без этого Android
     * глушит микрофон и закрывает камеру, как только вы переключаетесь на другое приложение.
     */
    private fun applyForeground() {
        val n = serviceNote()
        if (Build.VERSION.SDK_INT < 30) { startForeground(NID_SERVICE, n); return }
        val base = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        var type = base
        if (callActive && has(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (callActive && callVideo && has(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        try { startForeground(NID_SERVICE, n, type) }
        catch (e: Exception) {
            // например, камеру нельзя запросить из фона — оставляем хотя бы микрофон / базовый режим
            val mic = if (callActive && has(Manifest.permission.RECORD_AUDIO)) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
            runCatching { startForeground(NID_SERVICE, n, base or mic) }.onFailure { runCatching { startForeground(NID_SERVICE, n, base) } }
        }
    }

    fun onCallChanged() {
        applyForeground()
        holdLocks(callActive)
    }

    /** Во время звонка процессор и Wi-Fi не засыпают (экран гаснет у уха, приложение может быть свёрнуто) */
    @Suppress("DEPRECATION")
    private fun holdLocks(on: Boolean) {
        if (on) {
            if (cpuLock == null) cpuLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "heraxos:incall").apply { setReferenceCounted(false) }
            cpuLock?.acquire(4 * 60 * 60 * 1000L)
            if (wifiLock == null) runCatching {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wifiLock = wm.createWifiLock(mode, "heraxos:incall").apply { setReferenceCounted(false) }
            }
            runCatching { wifiLock?.acquire() }
        } else {
            runCatching { cpuLock?.let { if (it.isHeld) it.release() } }
            runCatching { wifiLock?.let { if (it.isHeld) it.release() } }
        }
    }

    /** Кнопка «Завершить» в уведомлении о звонке */
    fun hangupFromNotification() {
        val id = callId
        if (MainActivity.hangupInPage()) return
        if (id != null) send(JSONObject().put("type", "hangup").put("id", id))
        setCall(this, false, false, "")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Prefs.token(this) == null) { stopSelf(); return START_NOT_STICKY }
        stopped = false
        if (ws == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
        holdLocks(false)
        ws?.close(1000, "bye"); ws = null
        main.removeCallbacksAndMessages(null)
        cancelIncoming(false)
        instance = null
        super.onDestroy()
    }

    fun reconnectNow() {
        ws?.close(1000, "relogin"); ws = null
        backoff = 1000L
        connect()
    }

    private fun connect() {
        val token = Prefs.token(this) ?: return stopSelf()
        val myGen = ++gen
        val url = BuildConfig.SERVER.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
            "/ws?bg=1&token=" + Uri.encode(token)
        val req = Request.Builder().url(url).header("User-Agent", "AhazangApp/1.0 (Android; service)").build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { backoff = 1000L }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                main.post { handle(m) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                if (code == 4001) main.post { Prefs.clear(this@CallService); stopSelf() }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { main.post { retry(myGen) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { main.post { retry(myGen) } }
        })
    }

    private fun retry(myGen: Int) {
        if (stopped || myGen != gen) return
        ws = null
        main.postDelayed({ if (!stopped && ws == null) connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(30_000L)
    }

    fun send(json: JSONObject) { ws?.send(json.toString()) }

    private fun handle(m: JSONObject) {
        val type = m.optString("type")
        val id = m.optString("id")
        when (type) {
            "invite" -> if (!MainActivity.visible) showIncoming(id, m.optString("from"), m.optString("fromName").ifEmpty { m.optString("from") }, m.optBoolean("video"))
            "hangup", "reject" -> if (id == currentCall) {
                val reason = m.optString("reason")
                cancelIncoming(missed = reason != "elsewhere")
            }
            "msg" -> {
                val from = m.optString("f")
                val title = m.optString("fn").ifEmpty { from }
                if (!MainActivity.visible && !from.equals(Prefs.login(this), true)) notifyText(title, "🔒 Новое сообщение", from)
            }
            "contacts" -> {
                val r = m.optString("request")
                val a = m.optString("accepted")
                if (!MainActivity.visible && r.isNotEmpty()) notifyText("Ahazang", "$r хочет добавить вас в контакты", null)
                if (!MainActivity.visible && a.isNotEmpty()) notifyText("Ahazang", "$a принял(а) вашу заявку", a)
            }
        }
    }

    // ---------- входящий звонок ----------
    /** Вызов, который уже звонил в открытом приложении, после сворачивания продолжает звонить через систему */
    fun ringFromPage(id: String, from: String, title: String, video: Boolean) {
        if (currentCall != id) showIncoming(id, from, title.ifEmpty { from }, video)
    }

    private fun showIncoming(id: String, from: String, title: String, video: Boolean) {
        if (id.isEmpty()) return
        currentCall = id; currentFrom = from; currentTitle = title; currentVideo = video
        wake()

        val full = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            putExtra("id", id); putExtra("from", title); putExtra("video", video)
        }
        val fullPi = PendingIntent.getActivity(this, 20, full, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val decline = PendingIntent.getBroadcast(this, 21,
            Intent(this, ActionReceiver::class.java).setAction(ActionReceiver.DECLINE).putExtra("id", id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val answer = answerIntent(id, false, 22)

        val b = Notification.Builder(this, CH_CALL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title)
            .setContentText(if (video) "Входящий видеозвонок Ahazang" else "Входящий звонок Ahazang")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullPi, true)
            .setContentIntent(fullPi)
            .setColor(0xFFC96442.toInt())
            .setTimeoutAfter(50_000)
            .addAction(Notification.Action.Builder(null, "Отклонить", decline).build())
            .addAction(Notification.Action.Builder(null, "Ответить", answer).build())
        if (video) b.addAction(Notification.Action.Builder(null, "Видео", answerIntent(id, true, 23)).build())

        val n = b.build()
        n.flags = n.flags or Notification.FLAG_INSISTENT // рингтон и вибрация повторяются, пока не ответите
        nm.notify(NID_CALL, n)
    }

    fun answerIntent(id: String, video: Boolean, code: Int): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("answerCall", id); putExtra("video", video)
        }
        return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun decline(id: String) {
        if (id == currentCall) {
            send(JSONObject().put("type", "reject").put("id", id))
            cancelIncoming(false)
        }
    }

    fun cancelIncoming(missed: Boolean) {
        val from = currentFrom
        val title = currentTitle ?: from
        val wasRinging = currentCall != null
        currentCall = null; currentFrom = null; currentTitle = null
        nm.cancel(NID_CALL)
        IncomingCallActivity.finishIfOpen()
        if (missed && wasRinging && from != null) {
            val n = Notification.Builder(this, CH_MSG)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Пропущенный звонок")
                .setContentText("от $title")
                .setAutoCancel(true)
                .setColor(0xFFC96442.toInt())
                .setContentIntent(openApp(from, 30))
                .build()
            nm.notify(NID_MISSED, n)
        }
    }

    // ---------- сообщения ----------
    private fun notifyText(title: String, text: String, chat: String?) {
        val n = Notification.Builder(this, CH_MSG)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setColor(0xFFC96442.toInt())
            .setContentIntent(openApp(chat, 40 + (chat?.hashCode() ?: 0) % 1000))
            .build()
        nm.notify(100 + ((chat ?: title).hashCode() and 0xffff), n)
    }

    fun clearMessageNotes() {
        for (s in nm.activeNotifications) if (s.id >= 100 || s.id == NID_MISSED) nm.cancel(s.id)
    }

    private fun openApp(chat: String?, code: Int): PendingIntent {
        val i = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (chat != null) putExtra("chat", chat)
        }
        return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun wake() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        val wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "heraxos:call")
        wl.acquire(10_000)
    }

    private fun createChannels() {
        val service = NotificationChannel(CH_SERVICE, "Фоновая работа", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Нужно, чтобы звонки приходили, когда приложение закрыто"
            setShowBadge(false)
        }
        val call = NotificationChannel(CH_CALL, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Звонок на весь экран с рингтоном и вибрацией"
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            enableVibration(true)
            vibrationPattern = RING
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(false)
        }
        val msg = NotificationChannel(CH_MSG, "Сообщения", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Новые сообщения, заявки и пропущенные звонки"
            enableVibration(true)
        }
        val ongoing = NotificationChannel(CH_ONGOING, "Текущий звонок", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Показывается, пока идёт разговор"
            setShowBadge(false)
        }
        nm.createNotificationChannels(listOf(service, call, msg, ongoing))
    }
}
