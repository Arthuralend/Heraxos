package am.heraxos.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {

    companion object {
        @Volatile var visible = false
        private val ID_RE = Regex("^[a-f0-9]{8,32}$")
    }

    private lateinit var web: WebView
    private var pendingPermission: PermissionRequest? = null
    private val serverHost: String by lazy { Uri.parse(BuildConfig.SERVER).host ?: "" }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(0xFF0E0F11.toInt())
        setContentView(web)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            userAgentString = "$userAgentString HeraxosAndroid/1.0"
        }
        web.addJavascriptInterface(Bridge(), "HeraxosAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == serverHost) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val need = mutableListOf<String>()
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !has(Manifest.permission.RECORD_AUDIO))
                        need += Manifest.permission.RECORD_AUDIO
                    if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !has(Manifest.permission.CAMERA))
                        need += Manifest.permission.CAMERA
                    if (need.isEmpty()) request.grant(request.resources)
                    else { pendingPermission = request; requestPermissions(need.toTypedArray(), 2) }
                }
            }
        }

        // Уведомления (Android 13+) и микрофон/камера заранее — чтобы ответ на звонок был мгновенным
        val ask = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33) ask += Manifest.permission.POST_NOTIFICATIONS
        val missing = ask.filter { !has(it) }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)

        handleAnswer(intent)
        web.loadUrl(urlFor(intent))
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun urlFor(i: Intent?): String {
        val base = BuildConfig.SERVER
        val id = i?.getStringExtra("answerCall")
        if (id != null && ID_RE.matches(id)) {
            val v = if (i.getBooleanExtra("video", false)) "video" else "audio"
            return "$base/?answer=$v&call=$id"
        }
        val chat = i?.getStringExtra("chat")
        if (!chat.isNullOrEmpty()) return "$base/?chat=" + Uri.encode(chat)
        return "$base/"
    }

    private fun handleAnswer(i: Intent?) {
        if (i?.getStringExtra("answerCall") != null) {
            CallService.instance?.cancelIncoming(false)
            if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAnswer(intent)
        val id = intent.getStringExtra("answerCall")
        val chat = intent.getStringExtra("chat")
        when {
            id != null && ID_RE.matches(id) -> {
                val v = intent.getBooleanExtra("video", false)
                web.evaluateJavascript("window.hxAnswer && hxAnswer('$id', $v)", null)
            }
            !chat.isNullOrEmpty() -> web.loadUrl(urlFor(intent))
        }
    }

    override fun onResume() {
        super.onResume()
        visible = true
        web.onResume()
        CallService.instance?.clearMessageNotes()
        if (Prefs.token(this) != null) askSystemSettingsOnce()
    }

    override fun onPause() {
        visible = false
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.hxBack ? hxBack() : false") { r ->
            if (r != "true") {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2) {
            val req = pendingPermission ?: return
            pendingPermission = null
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) req.grant(req.resources)
            else req.deny()
        }
    }

    // Один раз просим: показ звонка на весь экран (Android 14+) и работу в фоне без ограничений батареи
    private fun askSystemSettingsOnce() {
        val p = Prefs.p(this)
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent() && !p.getBoolean("askedFsi", false)) {
            p.edit().putBoolean("askedFsi", true).apply()
            runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            }
            return
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName) && !p.getBoolean("askedBattery", false)) {
            p.edit().putBoolean("askedBattery", true).apply()
            runCatching {
                @SuppressLint("BatteryLife")
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                startActivity(i)
            }
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun setSession(token: String, login: String) {
            val changed = Prefs.token(this@MainActivity) != token
            Prefs.save(this@MainActivity, token, login)
            if (changed) CallService.restart(applicationContext) else CallService.start(applicationContext)
            runOnUiThread { askSystemSettingsOnce() }
        }

        @JavascriptInterface
        fun setAudioRoute(route: String) {
            runOnUiThread { AudioRoute.set(this@MainActivity, route) }
        }

        @JavascriptInterface
        fun clearSession() {
            Prefs.clear(this@MainActivity)
            CallService.stop(applicationContext)
        }
    }

    override fun onDestroy() {
        AudioRoute.set(this, "off")
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.visibility = View.GONE
        web.destroy()
        super.onDestroy()
    }
}
