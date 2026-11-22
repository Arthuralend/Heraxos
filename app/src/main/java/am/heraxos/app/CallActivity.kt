package am.heraxos.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * Экран звонка (нативный): входящий, вызов, разговор, видео, группа до 5 человек.
 * Показывается и поверх экрана блокировки. Сам звонок ведёт CallEngine — экран можно закрыть,
 * разговор продолжится (вернуться — через уведомление «Идёт звонок»).
 */
class CallActivity : Activity(), CallEngine.Listener {

    companion object {
        @Volatile var visible = false
        private var ref: java.lang.ref.WeakReference<CallActivity>? = null

        /** Приглашение в игру поверх экрана звонка */
        fun showGameInvite(name: String, title: String) {
            val a = ref?.get() ?: return
            if (!visible || a.isFinishing) return
            a.inviteDialog?.dismiss()
            a.inviteDialog = AlertDialog.Builder(a, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("$name приглашает сыграть")
                .setMessage("🎮 $title\n\nЗвонок продолжится — видео собеседника будет над игрой.")
                .setPositiveButton("Играть") { _, _ -> MainActivity.answerGame(a, true); a.finish() }
                .setNegativeButton("Отказаться") { _, _ -> MainActivity.answerGame(a, false) }
                .show()
        }
    }
    private var inviteDialog: AlertDialog? = null

    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var grid: LinearLayout
    private lateinit var info: LinearLayout
    private lateinit var ava: TextView
    private lateinit var nameView: TextView
    private lateinit var statusView: TextView
    private lateinit var local: SurfaceViewRenderer
    private lateinit var incomingRow: LinearLayout
    private lateinit var activeRow: LinearLayout
    private lateinit var bSpeaker: ImageButton
    private lateinit var bCam: ImageButton
    private lateinit var bFlip: ImageButton
    private lateinit var bMute: ImageButton
    private lateinit var bAdd: ImageButton
    private lateinit var bGames: ImageButton
    private var bVideoAnswer: View? = null

    private val renderers = HashMap<String, Pair<SurfaceViewRenderer, VideoTrack>>()
    private var localTrack: VideoTrack? = null
    private var gridKey = ""
    private var controlsHidden = false
    private var finishing = false
    private var pendingAnswer: Boolean? = null
    private val tick = object : Runnable { override fun run() { updateStatus(); main.postDelayed(this, 1000) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CallEngine.init(this)
        ref = java.lang.ref.WeakReference(this)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        volumeControlStream = AudioManager.STREAM_VOICE_CALL
        build()
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handle(intent) }

    private fun handle(i: Intent?) {
        if (i?.getBooleanExtra("answer", false) == true) {
            i.removeExtra("answer")
            answer(i.getBooleanExtra("video", false))
        }
    }

    override fun onStart() {
        super.onStart()
        visible = true
        CallEngine.listener = this
        main.post(tick)
        onCallUpdate()
    }

    override fun onStop() {
        visible = false
        if (CallEngine.listener === this) CallEngine.listener = null
        main.removeCallbacks(tick)
        super.onStop()
    }

    override fun onDestroy() {
        inviteDialog?.dismiss()
        for ((_, r) in renderers) { runCatching { r.second.removeSink(r.first) }; r.first.release() }
        renderers.clear()
        localTrack?.let { runCatching { it.removeSink(local) } }
        if (local.tag == "init") local.release()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // назад — к чатам, звонок продолжается
        if (CallEngine.busy) startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    // ------------------------------------------------------------------
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun build() {
        root = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(0xFF4A2E22.toInt(), 0xFF2B2A27.toInt(), 0xFF1A1918.toInt()))
            setOnClickListener { toggleControls() }
        }
        grid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(grid, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        info = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        ava = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 52f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
        }
        info.addView(ava, LinearLayout.LayoutParams(dp(130), dp(130)))
        nameView = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 30f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            setPadding(dp(16), dp(20), dp(16), dp(6)); setShadowLayer(8f, 0f, 1f, 0x99000000.toInt())
        }
        info.addView(nameView)
        statusView = TextView(this).apply {
            setTextColor(0xDDFFFFFF.toInt()); textSize = 17f; gravity = Gravity.CENTER; setShadowLayer(8f, 0f, 1f, 0x99000000.toInt())
        }
        info.addView(statusView)
        info.addView(TextView(this).apply {
            text = "🔒 Зашифровано"; setTextColor(0x80FFFFFF.toInt()); textSize = 13f; gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        })
        root.addView(info, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP).apply { topMargin = dp(96) })

        local = SurfaceViewRenderer(this).apply {
            setZOrderMediaOverlay(true)
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            visibility = View.GONE
            setOnClickListener { CallEngine.flipCamera() }
        }
        root.addView(local, FrameLayout.LayoutParams(dp(104), dp(150), Gravity.TOP or Gravity.END).apply { topMargin = dp(44); marginEnd = dp(14) })

        bAdd = roundButton(R.drawable.ic_addp, 0x33FFFFFF, 46) { addParticipant() }
        root.addView(bAdd, FrameLayout.LayoutParams(dp(46), dp(46), Gravity.TOP or Gravity.START).apply { topMargin = dp(44); marginStart = dp(14) })
        // игры во время звонка: экран звонка сворачивается, видео собеседника — над доской
        bGames = roundButton(R.drawable.ic_game, 0x33FFFFFF, 46) { openGames() }
        bGames.contentDescription = "Игры"
        root.addView(bGames, FrameLayout.LayoutParams(dp(46), dp(46), Gravity.TOP or Gravity.START).apply { topMargin = dp(100); marginStart = dp(14) })

        // входящий: отклонить / ответить / видео
        incomingRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        incomingRow.addView(labeled(roundButton(R.drawable.ic_end, 0xFFC8463D.toInt(), 76) { CallEngine.decline() }, "Отклонить"))
        incomingRow.addView(labeled(roundButton(R.drawable.ic_call, 0xFF4F9A62.toInt(), 76) { answer(false) }, "Ответить"))
        bVideoAnswer = labeled(roundButton(R.drawable.ic_video, 0xFF4F9A62.toInt(), 76) { answer(true) }, "Видео")
        incomingRow.addView(bVideoAnswer)
        root.addView(incomingRow, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = dp(64) })

        // разговор
        activeRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            setPadding(dp(10), dp(12), dp(10), dp(12))
            background = GradientDrawable().apply { cornerRadius = dp(40).toFloat(); setColor(0x8C1A1918.toInt()) }
        }
        bSpeaker = roundButton(R.drawable.ic_spk, 0x33FFFFFF, 58) { CallEngine.toggleSpeaker() }
        bCam = roundButton(R.drawable.ic_video, 0x33FFFFFF, 58) { askCameraThen { CallEngine.toggleCamera() } }
        bFlip = roundButton(R.drawable.ic_flip, 0x33FFFFFF, 58) { CallEngine.flipCamera() }
        bMute = roundButton(R.drawable.ic_mic, 0x33FFFFFF, 58) { CallEngine.toggleMute() }
        val bHang = roundButton(R.drawable.ic_end, 0xFFC8463D.toInt(), 58) { CallEngine.hangup() }
        for (b in listOf(bSpeaker, bCam, bFlip, bMute, bHang)) activeRow.addView(b, LinearLayout.LayoutParams(dp(58), dp(58)).apply { marginStart = dp(5); marginEnd = dp(5) })
        root.addView(activeRow, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(40) })

        bSpeaker.contentDescription = "Громкая связь"; bCam.contentDescription = "Камера"
        bFlip.contentDescription = "Сменить камеру"; bMute.contentDescription = "Микрофон"; bHang.contentDescription = "Завершить"
        bAdd.contentDescription = "Добавить участника"
        setContentView(root)
    }

    private fun roundButton(icon: Int, color: Int, size: Int, onClick: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon)
        scaleType = ImageView.ScaleType.CENTER_INSIDE
        setPadding(dp(size / 4), dp(size / 4), dp(size / 4), dp(size / 4))
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        imageTintList = ColorStateList.valueOf(Color.WHITE)
        setOnClickListener { onClick() }
    }

    private fun labeled(b: View, label: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
        addView(b, LinearLayout.LayoutParams(dp(76), dp(76)))
        addView(TextView(this@CallActivity).apply {
            text = label; setTextColor(0xE6FFFFFF.toInt()); textSize = 14f; gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0)
        })
        layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
    }

    /** Включено (громкая, камера, микрофон выключен) — белая кнопка с тёмным значком */
    private fun setOn(b: ImageButton, on: Boolean) {
        (b.background as GradientDrawable).setColor(if (on) Color.WHITE else 0x33FFFFFF)
        b.imageTintList = ColorStateList.valueOf(if (on) 0xFF1A1918.toInt() else Color.WHITE)
    }

    // ------------------------------------------------------------------
    private fun answer(video: Boolean) {
        val need = mutableListOf<String>()
        if (!has(Manifest.permission.RECORD_AUDIO)) need += Manifest.permission.RECORD_AUDIO
        if (video && !has(Manifest.permission.CAMERA)) need += Manifest.permission.CAMERA
        if (need.isNotEmpty()) { pendingAnswer = video; requestPermissions(need.toTypedArray(), 5); return }
        CallEngine.accept(video)
    }

    private var afterCamera: (() -> Unit)? = null
    private fun askCameraThen(f: () -> Unit) {
        if (CallEngine.camOn || has(Manifest.permission.CAMERA)) { f(); return }
        afterCamera = f; requestPermissions(arrayOf(Manifest.permission.CAMERA), 6)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 5) {
            val v = pendingAnswer ?: return; pendingAnswer = null
            if (has(Manifest.permission.RECORD_AUDIO)) CallEngine.accept(v && has(Manifest.permission.CAMERA))
            else CallEngine.toast("Без доступа к микрофону ответить нельзя")
        } else if (requestCode == 6) {
            val f = afterCamera; afterCamera = null
            if (has(Manifest.permission.CAMERA)) f?.invoke()
        }
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun addParticipant() {
        CallEngine.contacts { list ->
            if (isFinishing) return@contacts
            val inCall = (CallEngine.peers.keys + CallEngine.pending.keys).toSet()
            val free = list.filter { it.first.lowercase() !in inCall }
            if (free.isEmpty()) { CallEngine.toast("Все ваши контакты уже в звонке"); return@contacts }
            AlertDialog.Builder(this, AlertDialog.THEME_DEVICE_DEFAULT_DARK)
                .setTitle("Позвать в звонок")
                .setItems(free.map { it.second.ifEmpty { it.first } }.toTypedArray()) { _, i -> CallEngine.invite(free[i].first, free[i].second) }
                .setNegativeButton("Отмена", null)
                .show()
        }
    }

    private fun openGames() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("games", CallEngine.peerLogin))
        finish()
    }

    private fun toggleControls() {
        if (!anyVideo()) return
        controlsHidden = !controlsHidden
        val v = if (controlsHidden) View.INVISIBLE else View.VISIBLE
        activeRow.visibility = v; info.visibility = v; bAdd.visibility = v; bGames.visibility = v
    }

    private fun anyVideo() = CallEngine.camOn || CallEngine.peers.values.any { it.video && it.remoteVideo != null }

    // ------------------------------------------------------------------
    override fun onCallUpdate() {
        val e = CallEngine
        if (e.state == CallEngine.State.IDLE) { if (!finishing) { finishing = true; finish() }; return }
        val ringing = e.state == CallEngine.State.RINGING
        val ended = e.state == CallEngine.State.ENDED
        incomingRow.visibility = if (ringing) View.VISIBLE else View.GONE
        bVideoAnswer?.visibility = if (e.offerVideo) View.VISIBLE else View.GONE
        activeRow.visibility = if (ringing || ended || controlsHidden) View.GONE else View.VISIBLE
        bAdd.visibility = if (ringing || ended || e.id == null || controlsHidden) View.GONE else View.VISIBLE
        bGames.visibility = if (ringing || ended || controlsHidden || e.peers.size > 1) View.GONE else View.VISIBLE

        setOn(bSpeaker, e.route == "speaker")
        setOn(bCam, e.camOn)
        setOn(bMute, e.muted)
        bFlip.visibility = if (e.camOn) View.VISIBLE else View.GONE

        // собеседники: имя и аватар (один) или сетка (группа / видео)
        val who = e.peers.keys.toList() + e.pending.keys.filter { it !in e.peers.keys }
        val first = who.firstOrNull() ?: e.firstLogin
        val title = if (who.size <= 1) (if (first.isEmpty()) e.title else nameOf(first)) else who.joinToString(", ") { nameOf(it) }
        nameView.text = title
        ava.text = title.take(1).uppercase()
        ava.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(avatarColor(first.ifEmpty { title })) }

        val remoteVideo = e.peers.values.any { it.video && it.remoteVideo != null }
        ava.visibility = if (remoteVideo || who.size > 1) View.GONE else View.VISIBLE
        rebuildGrid(who)

        // своя камера
        val lt = e.localVideo
        if (lt !== localTrack) {
            localTrack?.let { runCatching { it.removeSink(local) } }
            localTrack = lt
            if (lt != null) { ensureInit(local); lt.addSink(local) }
        }
        local.visibility = if (lt != null && !ringing) View.VISIBLE else View.GONE
        local.setMirror(e.front)
        if (!anyVideo() && controlsHidden) { controlsHidden = false; info.visibility = View.VISIBLE }

        updateStatus()
        if (ended && !finishing) { finishing = true; main.postDelayed({ finish() }, 1300) }
    }

    private fun nameOf(k: String) = CallEngine.nameOf(k)

    private fun updateStatus() {
        val e = CallEngine
        statusView.text = when {
            e.state == CallEngine.State.ACTIVE && e.peers.values.any { it.lost > 0 } -> "Переподключение…"
            e.state == CallEngine.State.ACTIVE && e.t0 > 0 -> {
                val s = ((System.currentTimeMillis() - e.t0) / 1000).toInt()
                "%d:%02d".format(s / 60, s % 60)
            }
            else -> e.status
        }
    }

    private fun ensureInit(r: SurfaceViewRenderer) {
        if (r.tag == "init") return
        CallEngine.egl?.let { r.init(it.eglBaseContext, null); r.tag = "init" }
    }

    /** Сетка участников: видео — на всю плитку, без видео — инициал и имя */
    private fun rebuildGrid(who: List<String>) {
        val e = CallEngine
        val showGrid = who.size > 1 || e.peers.values.any { it.video && it.remoteVideo != null }
        val key = if (!showGrid) "" else who.joinToString("|") { k ->
            val p = e.peers[k]; "$k:${p?.video == true && p.remoteVideo != null}:${p?.connected}"
        }
        if (key == gridKey) return
        gridKey = key
        for ((_, r) in renderers) { runCatching { r.second.removeSink(r.first) }; r.first.release() }
        renderers.clear()
        grid.removeAllViews()
        if (!showGrid) return
        val cols = if (who.size <= 2) 1 else 2
        var row: LinearLayout? = null
        who.forEachIndexed { i, k ->
            if (i % cols == 0) {
                row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                grid.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            }
            val tile = FrameLayout(this).apply { setPadding(dp(1), dp(1), dp(1), dp(1)) }
            val p = e.peers[k]
            val track = p?.remoteVideo
            if (p != null && p.video && track != null) {
                val r = SurfaceViewRenderer(this)
                ensureInit(r)
                r.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                track.addSink(r)
                renderers[k] = r to track
                tile.addView(r, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            } else {
                tile.background = GradientDrawable().apply { setColor(0x22FFFFFF) }
                val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
                val n = nameOf(k)
                col.addView(TextView(this).apply {
                    text = n.take(1).uppercase(); setTextColor(Color.WHITE); textSize = 30f; gravity = Gravity.CENTER
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(avatarColor(k)) }
                    alpha = if (p?.connected == true) 1f else 0.55f
                }, LinearLayout.LayoutParams(dp(76), dp(76)))
                tile.addView(col, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            }
            if (who.size > 1) tile.addView(TextView(this).apply {
                text = nameOf(k) + if (p?.connected == true) "" else " · вызов…"
                setTextColor(Color.WHITE); textSize = 13f; setShadowLayer(6f, 0f, 1f, Color.BLACK)
                setPadding(dp(10), dp(6), dp(10), dp(8))
            }, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.START))
            row!!.addView(tile, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
        }
        // в группе имя/статус сверху не загораживают плитки
        info.visibility = if (who.size > 1 || controlsHidden) View.INVISIBLE else View.VISIBLE
    }

    private fun avatarColor(s: String): Int {
        val colors = intArrayOf(0xFFC96442.toInt(), 0xFFB5835A.toInt(), 0xFF8B6F47.toInt(), 0xFF6A8A82.toInt(),
            0xFF7E8FB8.toInt(), 0xFFA26B8F.toInt(), 0xFF5E8C61.toInt(), 0xFFB8875A.toInt(), 0xFF8C7AA9.toInt())
        var h = 0; for (c in s.lowercase()) h = h * 31 + c.code
        return colors[Math.floorMod(h, colors.size)]
    }
}
