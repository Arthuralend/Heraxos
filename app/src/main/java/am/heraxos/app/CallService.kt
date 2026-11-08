package am.heraxos.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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

/** Фоновая служба: держит соединение с сервером Heraxos и показывает входящие звонки на весь экран. */
class CallService : Service() {

    companion object {
        const val CH_SERVICE = "hx_service"
        const val CH_CALL = "hx_call_v2"
        const val CH_MSG = "hx_msg"
        const val NID_SERVICE = 1
        const val NID_CALL = 2
        const val NID_MISSED = 3
        val RING = longArrayOf(0, 900, 600, 900, 600, 900, 600)

        @Volatile var instance: CallService? = null

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
    private var currentFrom: String? = null
    private var currentVideo = false
    private val nm by lazy { getSystemService(NotificationManager::class.java) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannels()
        val n = Notification.Builder(this, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("Heraxos")
            .setContentText("Готов принимать звонки")
            .setOngoing(true)
            .setContentIntent(openApp(null, 10))
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(NID_SERVICE, n)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Prefs.token(this) == null) { stopSelf(); return START_NOT_STICKY }
        stopped = false
        if (ws == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        stopped = true
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
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
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
            "invite" -> if (!MainActivity.visible) showIncoming(id, m.optString("from"), m.optBoolean("video"))
            "hangup", "reject" -> if (id == currentCall) {
                val reason = m.optString("reason")
                cancelIncoming(missed = reason != "elsewhere")
            }
            "msg" -> {
                val from = m.optString("f")
                if (!MainActivity.visible && !from.equals(Prefs.login(this), true)) notifyText(from, "🔒 Новое сообщение", from)
            }
            "contacts" -> {
                val r = m.optString("request")
                val a = m.optString("accepted")
                if (!MainActivity.visible && r.isNotEmpty()) notifyText("Heraxos", "$r хочет добавить вас в контакты", null)
                if (!MainActivity.visible && a.isNotEmpty()) notifyText("Heraxos", "$a принял(а) вашу заявку", a)
            }
        }
    }

    // ---------- входящий звонок ----------
    private fun showIncoming(id: String, from: String, video: Boolean) {
        if (id.isEmpty()) return
        currentCall = id; currentFrom = from; currentVideo = video
        wake()

        val full = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            putExtra("id", id); putExtra("from", from); putExtra("video", video)
        }
        val fullPi = PendingIntent.getActivity(this, 20, full, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val decline = PendingIntent.getBroadcast(this, 21,
            Intent(this, ActionReceiver::class.java).setAction(ActionReceiver.DECLINE).putExtra("id", id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val answer = answerIntent(id, false, 22)

        val b = Notification.Builder(this, CH_CALL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(from)
            .setContentText(if (video) "Входящий видеозвонок Heraxos" else "Входящий звонок Heraxos")
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullPi, true)
            .setContentIntent(fullPi)
            .setColor(0xFFFF6A1A.toInt())
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
        val wasRinging = currentCall != null
        currentCall = null; currentFrom = null
        nm.cancel(NID_CALL)
        IncomingCallActivity.finishIfOpen()
        if (missed && wasRinging && from != null) {
            val n = Notification.Builder(this, CH_MSG)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Пропущенный звонок")
                .setContentText("от $from")
                .setAutoCancel(true)
                .setColor(0xFFFF6A1A.toInt())
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
            .setColor(0xFFFF6A1A.toInt())
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
        nm.createNotificationChannels(listOf(service, call, msg))
    }
}
