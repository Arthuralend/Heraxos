package am.heraxos.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Нативные звонки Ahazang (WebRTC, как в WhatsApp): звук и камера работают при свёрнутом приложении
 * и на заблокированном экране, громкая связь / разговорный динамик переключаются системой Android.
 *
 * Сигнализация — тот же протокол, что у веб-интерфейса (invite / accept / offer / answer / ice / hangup …),
 * через соединение фоновой службы CallService. Поэтому нативные и старые версии звонят друг другу.
 * Групповой звонок — «каждый с каждым», до 5 человек. Всё состояние меняется только в главном потоке.
 */
object CallEngine {

    enum class State { IDLE, OUTGOING, RINGING, CONNECTING, ACTIVE, ENDED }

    class Peer(val login: String, val pc: PeerConnection) {
        var at: RtpTransceiver? = null
        var vt: RtpTransceiver? = null
        val ice = mutableListOf<IceCandidate>()
        var remoteSet = false
        var connected = false
        var lost = 0L
        var restart: Runnable? = null
        var video = false
        var remoteVideo: VideoTrack? = null
    }

    fun interface Listener { fun onCallUpdate() }

    private const val AUDIO_BR = 64_000
    private const val VIDEO_BR = 2_500_000
    private const val VIDEO_START_KBPS = 800
    private const val RECOVER_MS = 60_000L
    private const val MAX_CALL = 5

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private lateinit var app: Context

    var listener: Listener? = null

    // ---- состояние звонка (читает экран звонка) ----
    var state = State.IDLE; private set
    var id: String? = null; private set
    var dir = ""; private set              // out / in / ring / missed / declined
    var title = ""; private set            // имя или номер собеседника
    var firstLogin = ""; private set       // логин, с кем начался звонок
    var offerVideo = false; private set    // входящий видеозвонок
    var status = ""; private set
    var t0 = 0L; private set
    var muted = false; private set
    var camOn = false; private set
    var front = true; private set
    var route = "earpiece"; private set
    private var routeManual = false
    private var video0 = false
    val peers = LinkedHashMap<String, Peer>()
    val pending = LinkedHashMap<String, String>()   // кого вызываем: логин (строчными) → логин
    private val names = HashMap<String, String>()   // логин (строчными) → имя / номер
    private val outbox = mutableListOf<JSONObject>() // сигналы, пока фоновая служба не запущена

    // ---- WebRTC ----
    private var ice: List<PeerConnection.IceServer> = emptyList()
    private var iceAt = 0L
    var egl: EglBase? = null; private set
    private var factory: PeerConnectionFactory? = null
    private var audioSource: org.webrtc.AudioSource? = null
    private var audioTrack: org.webrtc.AudioTrack? = null
    private var videoSource: VideoSource? = null
    var localVideo: VideoTrack? = null; private set
    private var capturer: CameraVideoCapturer? = null
    private var texHelper: SurfaceTextureHelper? = null

    fun init(c: Context) { if (!::app.isInitialized) app = c.applicationContext }

    val busy get() = state != State.IDLE && state != State.ENDED
    private fun me() = (Prefs.login(app) ?: "").lowercase()
    private fun k(l: String) = l.lowercase()
    fun nameOf(login: String) = names[k(login)] ?: login

    private fun notifyUi() { listener?.onCallUpdate() }

    // =====================================================================
    // Сигналы сервера (из CallService, главный поток)
    // =====================================================================
    fun onSignal(m: JSONObject) {
        init(CallService.instance ?: return)
        val type = m.optString("type")
        val mid = m.optString("id")
        when (type) {
            "invite" -> { onInvite(m); return }
            "calling" -> {
                if (state == State.OUTGOING && id == null) {
                    id = mid; status = "Гудки…"
                    CallService.setCall(app, true, camOn, mid)
                    notifyUi()
                }
                return
            }
            "error" -> {
                if (state == State.OUTGOING && id == null) end(false, m.optString("text").ifEmpty { "Абонент недоступен" })
                return
            }
        }
        if (id == null || id != mid || !busy) return
        val from = m.optString("from")
        when (type) {
            "room" -> {
                status = "Соединение…"
                val arr = m.optJSONArray("members") ?: JSONArray()
                for (i in 0 until arr.length()) offerTo(arr.getString(i))
            }
            "ringing" -> addPending(m.optString("login"))
            "joined" -> { addPending(m.optString("login")); if (peers.none { it.value.connected }) status = "Соединение…" }
            "offer" -> m.optJSONObject("sdp")?.let { answerFrom(from, it) }
            "answer" -> {
                val p = peers[k(from)] ?: return
                if (p.pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) return
                val sdp = m.optJSONObject("sdp") ?: return
                p.pc.setRemoteDescription(obs(onSet = { p.remoteSet = true; flushIce(p) }), desc(sdp))
            }
            "reneg" -> peers[k(from)]?.let { if (it.lost == 0L) it.lost = now(); restartIce(it) }
            "ice" -> {
                val p = peers[k(from)] ?: return
                val c = m.optJSONObject("candidate") ?: return
                val cand = IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate"))
                if (p.remoteSet) p.pc.addIceCandidate(cand) else p.ice += cand
            }
            "media" -> {
                peers[k(from)]?.video = m.optBoolean("video")
                // собеседник включил камеру — переходим на громкую связь (если вы сами не переключали)
                if (m.optBoolean("video") && !routeManual && route != "speaker") setRoute("speaker")
            }
            "declined" -> {
                dropPending(m.optString("login"))
                toast(if (m.optString("reason") == "busy") "${nameOf(m.optString("login"))}: занято" else "${nameOf(m.optString("login"))} отклонил(а) звонок")
            }
            "noanswer" -> { dropPending(m.optString("login")); toast("${nameOf(m.optString("login"))} не отвечает") }
            "left" -> {
                val l = m.optString("login"); closePeer(l); dropPending(l)
                if (peers.isNotEmpty()) toast("${nameOf(l)} вышел(а) из звонка")
            }
            "hangup" -> {
                val r = m.optString("reason")
                if (dir == "ring" && r != "elsewhere") dir = "missed"
                end(false, when (r) {
                    "busy" -> "Занято"; "rejected" -> "Отклонено"; "noanswer" -> "Нет ответа"
                    "elsewhere" -> "Отвечено на другом устройстве"; "gone" -> "Звонок уже завершён"
                    "missed" -> "Пропущенный звонок"; else -> "Звонок завершён"
                }, noLog = r == "elsewhere")
            }
        }
        notifyUi()
    }

    /** Сигнальное соединение вернулось — восстанавливаем связь, если она пропадала */
    fun onSignalingOpen() {
        val s = CallService.instance
        if (s != null && outbox.isNotEmpty()) { for (o in outbox) s.send(o); outbox.clear() }
        if (!busy) return
        for (p in peers.values) if (p.lost > 0 || !p.connected) restartIce(p)
    }

    private fun onInvite(m: JSONObject) {
        val mid = m.optString("id")
        if (busy) {
            if (id != mid) CallService.instance?.send(JSONObject().put("type", "reject").put("id", mid).put("reason", "busy"))
            return
        }
        val from = m.optString("from")
        reset()
        id = mid; dir = "ring"; state = State.RINGING; firstLogin = from
        offerVideo = m.optBoolean("video")
        title = m.optString("fromName").ifEmpty { fmtNum(m.optString("fromNum")).ifEmpty { from } }
        names[k(from)] = title
        val others = (m.optJSONArray("members") ?: JSONArray()).let { a -> (0 until a.length()).map { a.getString(it) } }.filter { k(it) != k(from) }
        status = if (others.isNotEmpty()) "Групповой звонок · ещё ${others.size}" else if (offerVideo) "Видеозвонок Ahazang…" else "Аудиозвонок Ahazang…"
        prefetchIce()
        CallService.instance?.showIncoming(mid, from, title, offerVideo)
        notifyUi()
    }

    // =====================================================================
    // Действия пользователя
    // =====================================================================
    fun startCall(c: Context, login: String, name: String, video: Boolean) {
        init(c)
        if (busy) { openScreen(); return }
        if (!hasMic()) { toast("Нет доступа к микрофону"); return }
        reset()
        dir = "out"; state = State.OUTGOING; firstLogin = login; video0 = video
        title = name.ifEmpty { login }; names[k(login)] = title
        status = "Вызов…"
        addPending(login)
        CallService.start(app)
        openScreen()
        withIce {
            if (state != State.OUTGOING) return@withIce
            startMedia(video)
            setRoute(if (video) "speaker" else "earpiece")
            send(JSONObject().put("type", "invite").put("to", login).put("video", video))
            CallService.setCall(app, true, camOn, "")
            notifyUi()
        }
    }

    fun accept(video: Boolean) {
        if (state != State.RINGING) return
        val cid = id ?: return
        if (!hasMic()) { toast("Нет доступа к микрофону"); return }
        CallService.instance?.cancelIncoming(false)
        dir = "in"; state = State.CONNECTING; status = "Соединение…"
        notifyUi()
        withIce {
            if (state != State.CONNECTING || id != cid) return@withIce
            startMedia(video)
            setRoute(if (video || offerVideo) "speaker" else "earpiece")
            CallService.setCall(app, true, camOn, cid)
            send(JSONObject().put("type", "accept").put("id", cid))
            notifyUi()
        }
    }

    fun decline() {
        if (state != State.RINGING) return
        id?.let { send(JSONObject().put("type", "reject").put("id", it)) }
        dir = "declined"
        end(false, "Отклонено")
    }

    fun hangup() {
        if (state == State.RINGING) return decline()
        if (busy) end(true, "Звонок завершён")
    }

    fun toggleMute() {
        muted = !muted
        audioTrack?.setEnabled(!muted)
        notifyUi()
    }

    fun toggleSpeaker() {
        routeManual = true
        setRoute(if (route == "speaker") "earpiece" else "speaker")
        toast(if (route == "speaker") "Громкая связь" else "Обычный режим (у уха)")
    }

    fun toggleCamera() {
        if (!busy) return
        if (camOn) {
            for (p in peers.values) p.vt?.sender?.setTrack(null, false)
            stopCamera()
        } else {
            if (!startCamera()) { toast("Нет доступа к камере"); return }
            for (p in peers.values) p.vt?.let { it.sender.setTrack(localVideo, false); it.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV }
            applySenderParams(null)
            if (!routeManual && route != "speaker") setRoute("speaker")
        }
        id?.let { send(JSONObject().put("type", "media").put("id", it).put("video", camOn)) }
        CallService.setCall(app, true, camOn, id ?: "")
        notifyUi()
    }

    fun flipCamera() {
        val c = capturer ?: return
        c.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) { main.post { front = isFront; notifyUi() } }
            override fun onCameraSwitchError(e: String?) { main.post { toast("Не удалось переключить камеру") } }
        })
    }

    /** Позвать ещё одного участника в текущий звонок */
    fun invite(login: String, name: String) {
        val cid = id ?: return
        if (peers.size + pending.size + 1 >= MAX_CALL) { toast("В звонке может быть не больше 5 человек"); return }
        names[k(login)] = name
        send(JSONObject().put("type", "invite").put("id", cid).put("to", login).put("video", camOn))
        toast("Вызываем $name…")
    }

    fun openScreen() {
        runCatching {
            app.startActivity(Intent(app, CallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
    }

    // =====================================================================
    // Звук
    // =====================================================================
    private fun setRoute(r: String) {
        route = r
        AudioRoute.set(app, r)
        notifyUi()
    }

    /** Наушники подключили/отключили — система уже переключила звук, обновляем выбор */
    fun refreshRoute() { if (busy && state != State.RINGING) AudioRoute.set(app, route) }

    // =====================================================================
    // Медиа
    // =====================================================================
    private fun hasMic() = app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun ensureFactory() {
        if (factory != null) return
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
        val e = EglBase.create()
        egl = e
        val adm = JavaAudioDeviceModule.builder(app)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun startMedia(video: Boolean) {
        ensureFactory()
        val f = factory!!
        if (audioTrack == null) {
            val c = MediaConstraints().apply {
                mandatory += MediaConstraints.KeyValuePair("googEchoCancellation", "true")
                mandatory += MediaConstraints.KeyValuePair("googNoiseSuppression", "true")
                mandatory += MediaConstraints.KeyValuePair("googAutoGainControl", "true")
                mandatory += MediaConstraints.KeyValuePair("googHighpassFilter", "true")
            }
            audioSource = f.createAudioSource(c)
            audioTrack = f.createAudioTrack("a0", audioSource)
        }
        audioTrack?.setEnabled(!muted)
        if (video && !startCamera()) toast("Нет доступа к камере — звонок без видео")
    }

    private fun startCamera(): Boolean {
        if (localVideo != null) return true
        if (app.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return false
        ensureFactory()
        return runCatching {
            val en = Camera2Enumerator(app)
            val dev = en.deviceNames.firstOrNull { en.isFrontFacing(it) == front } ?: en.deviceNames.firstOrNull() ?: return false
            front = en.isFrontFacing(dev)
            val cap = en.createCapturer(dev, null) ?: return false
            val helper = SurfaceTextureHelper.create("cam", egl!!.eglBaseContext)
            val src = factory!!.createVideoSource(false)
            cap.initialize(helper, app, src.capturerObserver)
            cap.startCapture(1280, 720, 30)
            capturer = cap; texHelper = helper; videoSource = src
            localVideo = factory!!.createVideoTrack("v0", src)
            camOn = true
            true
        }.getOrDefault(false)
    }

    private fun stopCamera() {
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }; capturer = null
        runCatching { localVideo?.dispose() }; localVideo = null
        runCatching { videoSource?.dispose() }; videoSource = null
        runCatching { texHelper?.dispose() }; texHelper = null
        camOn = false
    }

    // =====================================================================
    // Соединения с участниками
    // =====================================================================
    private fun newPeer(login: String): Peer {
        val cfg = PeerConnection.RTCConfiguration(ice).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        lateinit var p: Peer
        val pc = factory!!.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                main.post {
                    val cid = id ?: return@post
                    if (peers[k(login)] !== p) return@post
                    send(JSONObject().put("type", "ice").put("id", cid).put("to", login).put("candidate",
                        JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)))
                }
            }
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) { main.post { onPcState(p, s) } }
            override fun onTrack(t: RtpTransceiver) {
                main.post {
                    val tr = t.receiver.track()
                    if (tr is VideoTrack && peers[k(login)] === p) { p.remoteVideo = tr; notifyUi() }
                }
            }
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        }) ?: throw IllegalStateException("pc")
        p = Peer(login, pc)
        pending.remove(k(login))
        peers[k(login)] = p
        lookupName(login)
        return p
    }

    private fun offerTo(login: String) {
        if (factory == null || audioTrack == null) return
        closePeer(login)
        val p = newPeer(login)
        val init = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV, listOf("s"))
        p.at = p.pc.addTransceiver(audioTrack, init)
        p.vt = localVideo?.let { p.pc.addTransceiver(it, init) }
            ?: p.pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, init)
        makeOffer(p)
        notifyUi()
    }

    private fun makeOffer(p: Peer) {
        p.pc.createOffer(obs(onCreate = { d ->
            setLocal(p, d) { local -> id?.let { send(JSONObject().put("type", "offer").put("id", it).put("to", p.login).put("sdp", sdpJson(local))) } }
        }), MediaConstraints())
    }

    private fun answerFrom(login: String, sdp: JSONObject) {
        if (factory == null || audioTrack == null) return
        val p = peers[k(login)] ?: newPeer(login)
        p.pc.setRemoteDescription(obs(onSet = {
            p.remoteSet = true
            for (t in p.pc.transceivers) {
                t.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                if (t.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO) { t.sender.setTrack(audioTrack, false); p.at = t }
                else { t.sender.setTrack(localVideo, false); p.vt = t }
                runCatching { t.sender.setStreams(listOf("s")) }
            }
            p.pc.createAnswer(obs(onCreate = { d ->
                setLocal(p, d) { local ->
                    id?.let { send(JSONObject().put("type", "answer").put("id", it).put("to", login).put("sdp", sdpJson(local))) }
                    flushIce(p)
                }
            }), MediaConstraints())
        }), desc(sdp))
        notifyUi()
    }

    private fun setLocal(p: Peer, d: SessionDescription, then: (SessionDescription) -> Unit) {
        val m = SessionDescription(d.type, mungeVideoStart(mungeOpus(d.description)))
        p.pc.setLocalDescription(obs(onSet = { then(m) }), m)
    }

    private fun flushIce(p: Peer) { for (c in p.ice) p.pc.addIceCandidate(c); p.ice.clear() }

    private fun onPcState(p: Peer, s: PeerConnection.PeerConnectionState) {
        if (peers[k(p.login)] !== p || !busy) return
        when (s) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                p.connected = true; p.lost = 0
                p.restart?.let { main.removeCallbacks(it) }; p.restart = null
                if (t0 == 0L) { t0 = now(); state = State.ACTIVE; status = "" }
                setRoute(route) // разговор соединился — ещё раз выбираем динамик
                id?.let { send(JSONObject().put("type", "media").put("id", it).put("video", camOn)) }
                applySenderParams(p)
                diag("connected", "${p.login} маршрут=$route ${AudioRoute.describe(app)}")
            }
            PeerConnection.PeerConnectionState.DISCONNECTED, PeerConnection.PeerConnectionState.FAILED -> {
                p.connected = false
                if (p.lost == 0L) p.lost = now()
                scheduleRestart(p, if (s == PeerConnection.PeerConnectionState.FAILED) 0 else 2500)
            }
            else -> {}
        }
        notifyUi()
    }

    // ---- восстановление связи (смена сети, лифт): ICE restart, как в веб-версии ----
    private fun scheduleRestart(p: Peer, delay: Long) {
        if (p.restart != null) return
        val r = Runnable {
            p.restart = null
            if (!busy || peers[k(p.login)] !== p || p.connected) return@Runnable
            if (now() - p.lost > RECOVER_MS) {
                toast("Связь с ${nameOf(p.login)} потеряна")
                closePeer(p.login)
                if (peers.isEmpty() && pending.isEmpty()) end(true, "Связь потеряна")
                notifyUi()
                return@Runnable
            }
            restartIce(p)
            scheduleRestart(p, 8000)
        }
        p.restart = r
        main.postDelayed(r, delay)
    }

    /** Новое предложение делает тот, у кого логин «меньше»; второй просит его об этом (как в веб-версии) */
    private fun restartIce(p: Peer) {
        val cid = id ?: return
        if (me() > k(p.login)) { send(JSONObject().put("type", "reneg").put("id", cid).put("to", p.login)); return }
        val go = { p.pc.restartIce(); makeOffer(p) }
        when (p.pc.signalingState()) {
            PeerConnection.SignalingState.HAVE_LOCAL_OFFER ->
                p.pc.setLocalDescription(obs(onSet = { go() }), SessionDescription(SessionDescription.Type.ROLLBACK, ""))
            PeerConnection.SignalingState.STABLE -> go()
            else -> {}
        }
    }

    private fun closePeer(login: String) {
        val p = peers.remove(k(login)) ?: return
        p.restart?.let { main.removeCallbacks(it) }
        runCatching { p.pc.dispose() }
    }

    private fun applySenderParams(only: Peer?) {
        val group = peers.size > 1
        for (p in if (only != null) listOf(only) else peers.values.toList()) for (sd in p.pc.senders) {
            val tr = sd.track() ?: continue
            runCatching {
                val prm = sd.parameters
                if (prm.encodings.isEmpty()) return@runCatching
                val e = prm.encodings[0]
                if (tr.kind() == "audio") e.maxBitrateBps = AUDIO_BR
                else {
                    e.maxBitrateBps = if (group) 1_000_000 else VIDEO_BR
                    e.maxFramerate = 30
                    e.scaleResolutionDownBy = if (group) 720.0 / 540.0 else 1.0
                }
                sd.parameters = prm
            }
        }
    }

    private fun addPending(login: String) {
        if (login.isEmpty() || peers.containsKey(k(login)) || k(login) == me()) return
        pending[k(login)] = login
        lookupName(login)
    }

    private fun dropPending(login: String) { pending.remove(k(login)) }

    // =====================================================================
    // Завершение
    // =====================================================================
    private fun end(notify: Boolean, text: String, noLog: Boolean = false) {
        if (!busy) return
        val cid = id
        if (notify && cid != null) send(JSONObject().put("type", "hangup").put("id", cid))
        val wasRing = state == State.RINGING
        val logins = peers.values.map { it.login }
        if (!noLog && dir != "declined") logCall(
            if (logins.isNotEmpty()) logins.joinToString(", ") else firstLogin,
            video0 || offerVideo, if (dir == "ring") "missed" else dir,
            if (t0 > 0) ((now() - t0) / 1000).toInt() else 0, logins.size > 1
        )
        for (p in peers.values) { p.restart?.let { main.removeCallbacks(it) }; runCatching { p.pc.dispose() } }
        peers.clear(); pending.clear(); outbox.clear()
        stopCamera()
        runCatching { audioTrack?.dispose() }; audioTrack = null
        runCatching { audioSource?.dispose() }; audioSource = null
        AudioRoute.set(app, "off")
        CallService.setCall(app, false, false, "")
        CallService.instance?.cancelIncoming(wasRing && dir == "missed")
        state = State.ENDED; status = text
        notifyUi()
        main.postDelayed({ if (state == State.ENDED) { state = State.IDLE; id = null; notifyUi() } }, 1500)
    }

    private fun reset() {
        id = null; dir = ""; title = ""; firstLogin = ""; offerVideo = false; status = ""; t0 = 0
        muted = false; camOn = false; front = true; route = "earpiece"; routeManual = false; video0 = false
        peers.clear(); pending.clear(); outbox.clear()
    }

    // =====================================================================
    // Вспомогательное
    // =====================================================================
    /** Пока фоновая служба запускается, сигналы ждут в очереди */
    private fun send(m: JSONObject) {
        val s = CallService.instance
        if (s == null) outbox.add(m) else s.send(m)
    }

    private fun now() = System.currentTimeMillis()

    fun toast(text: String) = main.post { android.widget.Toast.makeText(app, text, android.widget.Toast.LENGTH_SHORT).show() }

    private fun desc(j: JSONObject) = SessionDescription(SessionDescription.Type.fromCanonicalForm(j.optString("type")), j.optString("sdp"))
    private fun sdpJson(d: SessionDescription) = JSONObject().put("type", d.type.canonicalForm()).put("sdp", d.description)

    private fun obs(onCreate: (SessionDescription) -> Unit = {}, onSet: () -> Unit = {}) = object : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription) { main.post { onCreate(d) } }
        override fun onSetSuccess() { main.post { onSet() } }
        override fun onCreateFailure(e: String?) { diag("sdp-err", "create $e") }
        override fun onSetFailure(e: String?) { diag("sdp-err", "set $e") }
    }

    /** Opus: FEC, 64 кбит/с, пакеты по 20 мс — речь не «булькает» при потерях в мобильной сети */
    private fun mungeOpus(sdp: String): String {
        val m = Regex("a=rtpmap:(\\d+) opus/48000/2", RegexOption.IGNORE_CASE).find(sdp) ?: return sdp
        val pt = m.groupValues[1]
        val want = "minptime=20;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxplaybackrate=48000;sprop-maxcapturerate=48000;maxaveragebitrate=$AUDIO_BR;cbr=0"
        val re = Regex("a=fmtp:$pt .*")
        var s = if (re.containsMatchIn(sdp)) sdp.replace(re, "a=fmtp:$pt $want") else sdp.replace(m.value, "${m.value}\r\na=fmtp:$pt $want")
        s = if (s.contains("a=ptime:")) s.replace(Regex("a=ptime:\\d+"), "a=ptime:20")
        else s.replaceFirst(Regex("(a=rtpmap:\\d+ opus/48000/2[^\\r\\n]*)", RegexOption.IGNORE_CASE), "$1\r\na=ptime:20")
        return s
    }

    private fun mungeVideoStart(sdp: String): String {
        var s = sdp
        val pts = Regex("a=rtpmap:(\\d+) (VP8|VP9|H264)/90000", RegexOption.IGNORE_CASE).findAll(sdp).map { it.groupValues[1] }.toList()
        for (pt in pts) {
            val f = Regex("a=fmtp:$pt (.*)")
            s = if (f.containsMatchIn(s)) s.replace(f) { r -> if (r.value.contains("x-google-start-bitrate")) r.value else "${r.value};x-google-start-bitrate=$VIDEO_START_KBPS" }
            else s.replaceFirst(Regex("(a=rtpmap:$pt [^\\r\\n]+)"), "$1\r\na=fmtp:$pt x-google-start-bitrate=$VIDEO_START_KBPS")
        }
        return s
    }

    fun fmtNum(n: String) = if (Regex("^\\d{6}$").matches(n)) n.substring(0, 3) + " " + n.substring(3) else n

    // ---- запросы к серверу ----
    private fun request(path: String, body: JSONObject? = null): String? {
        val token = Prefs.token(app) ?: return null
        val b = Request.Builder().url(BuildConfig.SERVER + path)
            .header("Authorization", "Bearer $token")
            .header("User-Agent", "AhazangApp/1.0 (Android; native)")
        if (body != null) b.post(body.toString().toRequestBody("application/json".toMediaType()))
        return runCatching { http.newCall(b.build()).execute().use { if (it.isSuccessful) it.body?.string() else null } }.getOrNull()
    }

    private fun prefetchIce() { if (now() - iceAt > 6 * 3600_000L) withIce {} }

    /** Адреса STUN/TURN (временный пароль на 12 часов) — потом действие */
    private fun withIce(then: () -> Unit) {
        if (ice.isNotEmpty() && now() - iceAt < 6 * 3600_000L) { then(); return }
        io.execute {
            val list = mutableListOf<PeerConnection.IceServer>()
            request("/api/ice")?.let { txt ->
                runCatching {
                    val arr = JSONArray(txt)
                    for (i in 0 until arr.length()) {
                        val o = arr.getJSONObject(i)
                        val u = o.get("urls")
                        val urls = if (u is JSONArray) (0 until u.length()).map { u.getString(it) } else listOf(u.toString())
                        val b = PeerConnection.IceServer.builder(urls)
                        if (o.has("username")) b.setUsername(o.getString("username")).setPassword(o.optString("credential"))
                        list += b.createIceServer()
                    }
                }
            }
            main.post {
                if (list.isNotEmpty()) { ice = list; iceAt = now() }
                then()
            }
        }
    }

    /** Имя участника из вашей телефонной книги (или его номер) */
    private fun lookupName(login: String) {
        if (names.containsKey(k(login))) return
        names[k(login)] = login
        io.execute {
            val j = request("/api/peer/" + android.net.Uri.encode(k(login)))?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return@execute
            val n = j.optString("name").ifEmpty { fmtNum(j.optString("num")) }
            if (n.isNotEmpty()) main.post { names[k(login)] = n; notifyUi() }
        }
    }

    /** Список контактов для «Добавить в звонок» */
    fun contacts(done: (List<Pair<String, String>>) -> Unit) {
        io.execute {
            val out = mutableListOf<Pair<String, String>>()
            request("/api/contacts")?.let { t ->
                runCatching {
                    val a = JSONObject(t).getJSONArray("contacts")
                    for (i in 0 until a.length()) {
                        val o = a.getJSONObject(i)
                        out += o.getString("login") to o.optString("name").ifEmpty { fmtNum(o.optString("num")) }
                    }
                }
            }
            main.post { done(out) }
        }
    }

    /** Запись для журнала сервера (journalctl -u ahazang | grep diag) */
    fun diag(ev: String, info: String) {
        if (!::app.isInitialized) return
        io.execute {
            runCatching {
                val b = JSONObject().put("ev", ev).put("info", "android-native $info").put("ua", "AhazangApp/1.0 (Android; native)")
                http.newCall(Request.Builder().url(BuildConfig.SERVER + "/api/diag")
                    .header("User-Agent", "AhazangApp/1.0 (Android; native)")
                    .post(b.toString().toRequestBody("application/json".toMediaType())).build()).execute().close()
            }
        }
    }

    // ---- журнал звонков: забирает веб-интерфейс (вкладка «Звонки») ----
    private fun logCall(peer: String, video: Boolean, d: String, dur: Int, group: Boolean) {
        val p = Prefs.p(app)
        val arr = runCatching { JSONArray(p.getString("callLog", "[]")) }.getOrDefault(JSONArray())
        arr.put(JSONObject().put("peer", peer).put("video", video).put("dir", d).put("ts", now()).put("dur", dur).put("group", group))
        p.edit().putString("callLog", arr.toString()).apply()
        MainActivity.callLogChanged()
    }

    fun takeCallLog(c: Context): String {
        val p = Prefs.p(c)
        val s = p.getString("callLog", "[]") ?: "[]"
        p.edit().remove("callLog").apply()
        return s
    }
}
