package am.heraxos.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import java.io.File
import java.io.OutputStream

class MainActivity : Activity() {

    companion object {
        @Volatile var visible = false
        @Volatile private var current: MainActivity? = null
        private val ID_RE = Regex("^[a-f0-9]{8,32}$")
        private const val REQ_FILE = 7
        private const val BG = 0xFFFAF9F5.toInt()
        private const val BG_DARK = 0xFF1A1918.toInt()

        /** Завершить звонок из уведомления: через веб-приложение, если оно открыто */
        fun hangupInPage(): Boolean {
            val a = current ?: return false
            a.runOnUiThread { a.web.evaluateJavascript("window.hxHangup && hxHangup()", null) }
            return true
        }
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var pendingPermission: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val serverHost: String by lazy { Uri.parse(BuildConfig.SERVER).host ?: "" }
    private var insetTop = 0
    private var insetBottom = 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        root = FrameLayout(this).apply { setBackgroundColor(BG) }
        web = WebView(this)
        web.setBackgroundColor(BG)
        // Страница со звонком не должна «засыпать», когда приложение свёрнуто (Яндекс Карты поверх и т.п.)
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        edgeToEdge()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            // метка приложения: сервер отдаёт интерфейс и API только приложениям Ahazang
            userAgentString = "$userAgentString AhazangApp/1.0 (Android)"
        }
        web.addJavascriptInterface(Bridge(), "HeraxosAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == serverHost) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
            override fun onPageFinished(view: WebView, url: String) { pushInsets() }
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

            // Выбор файлов для отправки (без этого кнопка «прикрепить» в WebView ничего не делает)
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try {
                    startActivityForResult(Intent.createChooser(pick, "Выберите файл"), REQ_FILE); true
                } catch (e: Exception) { fileCallback = null; false }
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

    // ---------- экран от края до края: отступы под строку состояния и панель навигации передаём в интерфейс ----------
    @Suppress("DEPRECATION")
    private fun edgeToEdge() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        else window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        root.setOnApplyWindowInsetsListener { _, insets -> onInsets(insets); insets }
        setBars(false)
    }

    @Suppress("DEPRECATION")
    private fun onInsets(insets: WindowInsets) {
        val top: Int; val bars: Int; val ime: Int
        if (Build.VERSION.SDK_INT >= 30) {
            val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            top = b.top; bars = b.bottom; ime = insets.getInsets(WindowInsets.Type.ime()).bottom
        } else {
            top = insets.systemWindowInsetTop; bars = insets.stableInsetBottom
            ime = if (insets.systemWindowInsetBottom > insets.stableInsetBottom) insets.systemWindowInsetBottom else 0
        }
        // открыта клавиатура — уменьшаем страницу на её высоту, иначе оставляем отступ под панель навигации
        val keyboard = ime > bars
        root.setPadding(0, 0, 0, if (keyboard) ime else 0)
        insetTop = top; insetBottom = if (keyboard) 0 else bars
        pushInsets()
    }

    private fun pushInsets() {
        val d = resources.displayMetrics.density
        web.evaluateJavascript(
            "(function(s){s.setProperty('--sat','${insetTop / d}px');s.setProperty('--sab','${insetBottom / d}px')})(document.documentElement.style)", null)
    }

    /** Тёмный экран (звонок, просмотр фото) — светлые значки строки состояния; светлый экран — тёмные */
    @Suppress("DEPRECATION")
    private fun setBars(dark: Boolean) {
        root.setBackgroundColor(if (dark) BG_DARK else BG)
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            var f = window.decorView.systemUiVisibility
            val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            f = if (dark) f and light.inv() else f or light
            window.decorView.systemUiVisibility = f
        }
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

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        val cb = fileCallback ?: return
        fileCallback = null
        if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
        else data.data?.let { uris += it }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
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

    // ---------- сохранение расшифрованных файлов в «Загрузки/Ahazang» ----------
    private class SaveJob(val name: String, val mime: String, val out: OutputStream, val uri: Uri?, val file: File?)
    private val saves = HashMap<String, SaveJob>()

    private fun cleanName(n: String) = n.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(120).ifEmpty { "file" }

    private fun startSave(sid: String, name: String, mime: String): Boolean {
        val n = cleanName(name)
        if (Build.VERSION.SDK_INT >= 29) {
            val v = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, n)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Ahazang")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: return false
            val out = contentResolver.openOutputStream(uri) ?: return false
            saves[sid] = SaveJob(n, mime, out, uri, null)
            return true
        }
        if (!has(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            runOnUiThread { requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 3) }
            return false
        }
        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Ahazang").apply { mkdirs() }
        var f = File(dir, n); var k = 1
        while (f.exists()) { f = File(dir, n.substringBeforeLast('.') + " ($k)" + (if (n.contains('.')) "." + n.substringAfterLast('.') else "")); k++ }
        saves[sid] = SaveJob(f.name, mime, f.outputStream(), null, f)
        return true
    }

    private fun finishSave(sid: String) {
        val j = saves.remove(sid) ?: return
        runCatching { j.out.close() }
        val open = { uri: Uri? ->
            runOnUiThread {
                val ok = uri != null && runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, j.mime)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                }.isSuccess
                Toast.makeText(this, if (ok) "Сохранено в «Загрузки/Ahazang»" else "Сохранено в «Загрузки/Ahazang»: ${j.name}", Toast.LENGTH_LONG).show()
            }
        }
        if (j.uri != null) {
            if (Build.VERSION.SDK_INT >= 29) contentResolver.update(j.uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            open(j.uri)
        } else if (j.file != null) {
            MediaScannerConnection.scanFile(this, arrayOf(j.file.absolutePath), arrayOf(j.mime)) { _, uri -> open(uri) }
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

        /** Звонок начался / изменился (камера) / закончился */
        @JavascriptInterface
        fun callState(active: Boolean, video: Boolean, id: String) {
            runOnUiThread { CallService.setCall(applicationContext, active, video, if (ID_RE.matches(id)) id else "") }
        }

        @JavascriptInterface
        fun setBars(dark: Boolean) { runOnUiThread { this@MainActivity.setBars(dark) } }

        /** Приложение свернули во время входящего — дальше звонит система (полноэкранный вызов и рингтон) */
        @JavascriptInterface
        fun ringNative(id: String, from: String, title: String, video: Boolean) {
            if (!ID_RE.matches(id)) return
            runOnUiThread { CallService.instance?.ringFromPage(id, from, title, video) }
        }

        /** Страница на экране сама показывает входящий и звонит — системный рингтон этого вызова выключаем */
        @JavascriptInterface
        fun pageRinging(id: String) {
            runOnUiThread { CallService.instance?.let { if (it.currentCall == id) it.cancelIncoming(false) } }
        }

        @JavascriptInterface
        fun appVersion(): Int = BuildConfig.VERSION_CODE

        /** Сохранение файла частями: fileBegin → fileChunk (base64) … → fileEnd */
        @JavascriptInterface
        fun fileBegin(sid: String, name: String, mime: String): Boolean = runCatching { startSave(sid, name, mime) }.getOrDefault(false)

        @JavascriptInterface
        fun fileChunk(sid: String, b64: String) {
            val j = saves[sid] ?: return
            runCatching { j.out.write(Base64.decode(b64, Base64.DEFAULT)) }.onFailure { saves.remove(sid); runCatching { j.out.close() } }
        }

        @JavascriptInterface
        fun fileEnd(sid: String) { runCatching { finishSave(sid) } }

        @JavascriptInterface
        fun clearSession() {
            Prefs.clear(this@MainActivity)
            CallService.stop(applicationContext)
        }
    }

    override fun onDestroy() {
        if (current === this) current = null
        // приложение закрыли во время звонка — сообщаем собеседнику сразу, а не через минуту
        if (CallService.callActive) {
            CallService.callId?.let { CallService.instance?.send(org.json.JSONObject().put("type", "hangup").put("id", it)) }
            CallService.setCall(applicationContext, false, false, "")
        }
        AudioRoute.set(this, "off")
        for (j in saves.values) runCatching { j.out.close() }
        saves.clear()
        (web.parent as? ViewGroup)?.removeView(web)
        web.visibility = View.GONE
        web.destroy()
        super.onDestroy()
    }
}
