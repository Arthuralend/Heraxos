package am.heraxos.app

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.lang.ref.WeakReference

/** Полноэкранный входящий звонок (поверх блокировки). Рингтон и вибрацию даёт уведомление звонка. */
class IncomingCallActivity : Activity() {

    companion object {
        private var ref: WeakReference<IncomingCallActivity>? = null
        fun finishIfOpen() { ref?.get()?.let { if (!it.isFinishing) it.finish() } }
    }

    private var callId = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ref = WeakReference(this)
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
        bind(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); bind(intent) }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun bind(i: Intent) {
        callId = i.getStringExtra("id") ?: ""
        val from = i.getStringExtra("from") ?: "Heraxos"
        val video = i.getBooleanExtra("video", false)
        if (CallService.instance?.currentCall != callId) { finish(); return }

        val root = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(0xFF3A1D0C.toInt(), 0xFF1A1410.toInt(), 0xFF0B0B0D.toInt()))
        }

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        val ava = TextView(this).apply {
            text = from.take(1).uppercase()
            setTextColor(Color.WHITE); textSize = 52f; typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(avatarColor(from)) }
            startAnimation(AlphaAnimation(1f, .65f).apply { duration = 900; repeatMode = Animation.REVERSE; repeatCount = Animation.INFINITE })
        }
        top.addView(ava, LinearLayout.LayoutParams(dp(130), dp(130)))
        top.addView(TextView(this).apply {
            text = from; setTextColor(Color.WHITE); textSize = 32f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            setPadding(0, dp(22), 0, dp(6))
        })
        top.addView(TextView(this).apply {
            text = if (video) "Видеозвонок Heraxos…" else "Аудиозвонок Heraxos…"
            setTextColor(0xCCFFFFFF.toInt()); textSize = 17f; gravity = Gravity.CENTER
        })
        top.addView(TextView(this).apply {
            text = "🔒 Зашифровано"; setTextColor(0x80FFFFFF.toInt()); textSize = 13f; gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        })
        root.addView(top, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP).apply { topMargin = dp(110) })

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        row.addView(button("✕", "Отклонить", 0xFFFF4D55.toInt()) { decline() })
        row.addView(button("📞", "Ответить", 0xFF2FD36F.toInt()) { answer(false) })
        if (video) row.addView(button("📹", "Видео", 0xFF2FD36F.toInt()) { answer(true) })
        root.addView(row, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = dp(70) })

        setContentView(root)
    }

    private fun button(icon: String, label: String, color: Int, onClick: () -> Unit): LinearLayout {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        val b = TextView(this).apply {
            text = icon; textSize = 30f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
            elevation = dp(8).toFloat()
            setOnClickListener { onClick() }
        }
        col.addView(b, LinearLayout.LayoutParams(dp(76), dp(76)))
        col.addView(TextView(this).apply {
            text = label; setTextColor(0xE6FFFFFF.toInt()); textSize = 14f; gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0)
        })
        col.layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        return col
    }

    private fun avatarColor(s: String): Int {
        val colors = intArrayOf(0xFFE57373.toInt(), 0xFFBA68C8.toInt(), 0xFF7986CB.toInt(), 0xFF4FC3F7.toInt(),
            0xFF4DB6AC.toInt(), 0xFF81C784.toInt(), 0xFFFFB74D.toInt(), 0xFF90A4AE.toInt(), 0xFFFF6A1A.toInt())
        var h = 0; for (c in s) h = h * 31 + c.code
        return colors[Math.floorMod(h, colors.size)]
    }

    private fun decline() {
        CallService.instance?.decline(callId)
        finish()
    }

    private fun answer(video: Boolean) {
        val id = callId
        CallService.instance?.cancelIncoming(false)
        val open = {
            startActivity(Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("answerCall", id); putExtra("video", video)
            })
            finish()
        }
        val km = getSystemService(KeyguardManager::class.java)
        if (km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() { open() }
                override fun onDismissCancelled() { open() }
                override fun onDismissError() { open() }
            })
        } else open()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { /* звонок закрывается только кнопками */ }

    override fun onDestroy() { if (ref?.get() === this) ref = null; super.onDestroy() }
}
