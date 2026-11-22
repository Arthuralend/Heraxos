import AVFoundation
import UIKit
import WebRTC

/// Соединение с одним участником звонка
final class CallPeer: NSObject, RTCPeerConnectionDelegate {
    let login: String
    var pc: RTCPeerConnection!
    var at: RTCRtpTransceiver?
    var vt: RTCRtpTransceiver?
    var ice: [RTCIceCandidate] = []
    var remoteSet = false
    var connected = false
    var lost: Date?
    var restart: DispatchWorkItem?
    var video = false
    var remoteVideo: RTCVideoTrack?
    weak var engine: CallEngine?

    init(login: String) { self.login = login }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        DispatchQueue.main.async { self.engine?.localCandidate(self, candidate) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        DispatchQueue.main.async { self.engine?.pcState(self, newState) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        let track = transceiver.receiver.track
        DispatchQueue.main.async {
            if let v = track as? RTCVideoTrack { self.remoteVideo = v; self.engine?.changed() }
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// Нативные звонки Ahazang (WebRTC, как в WhatsApp): разговор идёт и на заблокированном экране,
/// звук — через системную аудиосессию звонка (CallKit), громкая связь / у уха / Bluetooth — как у телефона.
/// Протокол сигналов — тот же, что у веб-интерфейса и Android, поэтому все версии звонят друг другу.
/// Всё состояние меняется только в главном потоке.
final class CallEngine {
    static let shared = CallEngine()

    enum State { case idle, outgoing, ringing, connecting, active, ended }

    private let AUDIO_BR = 64_000
    private let VIDEO_BR = 2_500_000
    private let VIDEO_START_KBPS = 800
    private let RECOVER: TimeInterval = 60
    private let MAX_CALL = 5

    /// Обновить экран звонка
    var onUpdate: (() -> Void)?

    private(set) var state: State = .idle
    private(set) var id: String?
    private(set) var dir = ""            // out / in / ring / missed / declined
    private(set) var title = ""
    private(set) var firstLogin = ""
    private(set) var offerVideo = false
    private(set) var status = ""
    private(set) var t0: Date?
    private(set) var muted = false
    private(set) var camOn = false
    private(set) var front = true
    private(set) var speaker = false
    private var routeManual = false
    private var video0 = false
    private var audioActive = false
    private var wantAccept: Bool?        // ответили на системном экране раньше, чем пришло приглашение

    private(set) var peers: [CallPeer] = []
    private(set) var pending: [String] = []
    private var names: [String: String] = [:]

    private var iceServers: [RTCIceServer] = []
    private var iceAt = Date.distantPast
    private lazy var factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()
    private var audioTrack: RTCAudioTrack?
    private var videoSource: RTCVideoSource?
    private(set) var localVideo: RTCVideoTrack?
    private var capturer: RTCCameraVideoCapturer?

    var busy: Bool { state != .idle && state != .ended }
    private var me: String { (UserDefaults.standard.string(forKey: "login") ?? "").lowercased() }
    private func k(_ l: String) -> String { l.lowercased() }
    func peer(_ l: String) -> CallPeer? { peers.first { k($0.login) == k(l) } }
    func nameOf(_ l: String) -> String { names[k(l)] ?? l }

    init() {
        // звук включает система, когда CallKit активирует аудиосессию звонка
        let s = RTCAudioSession.sharedInstance()
        s.useManualAudio = true
        s.isAudioEnabled = false
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.routeChanged()
        }
    }

    func changed() { onUpdate?() }

    // =====================================================================
    // Сигналы сервера
    // =====================================================================
    func onSignal(_ m: [String: Any]) {
        let type = m["type"] as? String ?? ""
        let mid = m["id"] as? String ?? ""
        switch type {
        case "invite": onInvite(m); return
        case "calling":
            if state == .outgoing && id == nil {
                id = mid; status = "Гудки…"
                CallManager.shared.outgoingStarted(id: mid)
                changed()
            }
            return
        case "error":
            if state == .outgoing && id == nil { end(notify: false, text: (m["text"] as? String) ?? "Абонент недоступен", report: .failed) }
            return
        default: break
        }
        guard busy, let cid = id, cid == mid else { return }
        let from = m["from"] as? String ?? ""
        switch type {
        case "room":
            status = "Соединение…"
            for l in (m["members"] as? [String]) ?? [] { offerTo(l) }
        case "ringing": addPending(m["login"] as? String ?? "")
        case "joined":
            addPending(m["login"] as? String ?? "")
            if !peers.contains(where: { $0.connected }) { status = "Соединение…" }
        case "offer":
            if let sdp = m["sdp"] as? [String: Any] { answerFrom(from, sdp) }
        case "answer":
            guard let p = peer(from), p.pc.signalingState == .haveLocalOffer, let sdp = m["sdp"] as? [String: Any] else { return }
            p.pc.setRemoteDescription(desc(sdp)) { [weak self] err in
                DispatchQueue.main.async { if err == nil { p.remoteSet = true; self?.flushIce(p) } }
            }
        case "reneg":
            if let p = peer(from) { if p.lost == nil { p.lost = Date() }; restartIce(p) }
        case "ice":
            guard let p = peer(from), let c = m["candidate"] as? [String: Any], let s = c["candidate"] as? String else { return }
            let cand = RTCIceCandidate(sdp: s, sdpMLineIndex: Int32((c["sdpMLineIndex"] as? Int) ?? 0), sdpMid: c["sdpMid"] as? String)
            if p.remoteSet { p.pc.add(cand) { _ in } } else { p.ice.append(cand) }
        case "media":
            let v = (m["video"] as? Bool) ?? false
            peer(from)?.video = v
            if v && !routeManual && !speaker { setSpeaker(true) }
        case "declined":
            let l = m["login"] as? String ?? ""
            dropPending(l)
            toast((m["reason"] as? String) == "busy" ? "\(nameOf(l)): занято" : "\(nameOf(l)) отклонил(а) звонок")
        case "noanswer":
            let l = m["login"] as? String ?? ""
            dropPending(l); toast("\(nameOf(l)) не отвечает")
        case "left":
            let l = m["login"] as? String ?? ""
            closePeer(l); dropPending(l)
            if !peers.isEmpty { toast("\(nameOf(l)) вышел(а) из звонка") }
        case "hangup":
            let r = m["reason"] as? String ?? ""
            if dir == "ring" && r != "elsewhere" { dir = "missed" }
            let text: String
            var reason: CXEndReasonish = .remoteEnded
            switch r {
            case "busy": text = "Занято"; reason = .unanswered
            case "rejected": text = "Отклонено"; reason = .unanswered
            case "noanswer": text = "Нет ответа"; reason = .unanswered
            case "elsewhere": text = "Отвечено на другом устройстве"; reason = .answeredElsewhere
            case "gone": text = "Звонок уже завершён"; reason = .remoteEnded
            case "missed": text = "Пропущенный звонок"; reason = .unanswered
            default: text = "Звонок завершён"
            }
            end(notify: false, text: text, noLog: r == "elsewhere", report: reason)
        default: break
        }
        changed()
    }

    /// Сигнальное соединение вернулось — восстанавливаем связь, если она пропадала
    func onSignalingOpen() {
        guard busy else { return }
        for p in peers where p.lost != nil || !p.connected { restartIce(p) }
    }

    private func onInvite(_ m: [String: Any]) {
        let mid = m["id"] as? String ?? ""
        if busy {
            if id != mid { Signaling.shared.send(["type": "reject", "id": mid, "reason": "busy"]) }
            return
        }
        let from = m["from"] as? String ?? ""
        let name = (m["fromName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fmtNum(m["fromNum"] as? String ?? "")
        let members = (m["members"] as? [String]) ?? []
        prepareIncoming(id: mid, from: from, name: name.isEmpty ? from : name, video: (m["video"] as? Bool) ?? false,
                        others: members.filter { k($0) != k(from) }.count)
        CallManager.shared.reportIncoming(id: mid, name: title, video: offerVideo)
        if let v = wantAccept { wantAccept = nil; accept(video: v) }
    }

    /// Входящий звонок (из VoIP-сигнала Apple или из соединения с сервером)
    func prepareIncoming(id mid: String, from: String, name: String, video: Bool, others: Int = 0) {
        guard !busy else { return }
        reset()
        id = mid; dir = "ring"; state = .ringing; firstLogin = from
        offerVideo = video; title = name; names[k(from)] = name
        status = others > 0 ? "Групповой звонок · ещё \(others)" : (video ? "Видеозвонок Ahazang…" : "Аудиозвонок Ahazang…")
        prefetchIce()
        changed()
    }

    // =====================================================================
    // Действия (вызывает CallManager из действий CallKit)
    // =====================================================================
    func startCall(login: String, name: String, video: Bool) {
        guard !busy else { return }
        reset()
        dir = "out"; state = .outgoing; firstLogin = login; video0 = video
        title = name.isEmpty ? login : name; names[k(login)] = title
        status = "Вызов…"
        speaker = video
        addPending(login)
        Signaling.shared.connect()
        withIce { [weak self] in
            guard let self, self.state == .outgoing else { return }
            self.startMedia(video: video)
            Signaling.shared.send(["type": "invite", "to": login, "video": video])
            self.changed()
        }
    }

    func accept(video: Bool) {
        guard state == .ringing, let cid = id else {
            if state == .idle { wantAccept = video } // приглашение ещё не дошло — ответим, как только придёт
            return
        }
        dir = "in"; state = .connecting; status = "Соединение…"
        speaker = video || offerVideo
        changed()
        Signaling.shared.connect()
        withIce { [weak self] in
            guard let self, self.state == .connecting, self.id == cid else { return }
            self.startMedia(video: video)
            Signaling.shared.send(["type": "accept", "id": cid])
            self.changed()
        }
    }

    func decline() {
        guard state == .ringing else { return }
        if let cid = id { Signaling.shared.send(["type": "reject", "id": cid]) }
        dir = "declined"
        end(notify: false, text: "Отклонено", report: nil)
    }

    /// Завершить (кнопка или системный экран)
    func hangup() {
        if state == .ringing { decline(); return }
        wantAccept = nil
        if busy { end(notify: true, text: "Звонок завершён", report: nil) }
    }

    func setMuted(_ on: Bool) {
        muted = on
        audioTrack?.isEnabled = !on
        changed()
    }

    func toggleSpeaker() {
        routeManual = true
        setSpeaker(!speaker)
    }

    func setSpeaker(_ on: Bool) {
        speaker = on
        applyRoute()
        changed()
    }

    func toggleCamera() {
        guard busy else { return }
        if camOn {
            for p in peers { p.vt?.sender.track = nil }
            stopCamera()
        } else {
            guard startCamera() else { toast("Нет доступа к камере"); return }
            for p in peers {
                if let t = p.vt { t.sender.track = localVideo; t.setDirection(.sendRecv, error: nil) }
            }
            applySenderParams(nil)
            if !routeManual && !speaker { setSpeaker(true) }
        }
        if let cid = id { Signaling.shared.send(["type": "media", "id": cid, "video": camOn]) }
        applyRoute()
        changed()
    }

    func flipCamera() {
        guard camOn else { return }
        front.toggle()
        stopCapture()
        startCapture()
        changed()
    }

    func invite(login: String, name: String) {
        guard let cid = id else { return }
        if peers.count + pending.count + 1 >= MAX_CALL { toast("В звонке может быть не больше 5 человек"); return }
        names[k(login)] = name
        Signaling.shared.send(["type": "invite", "id": cid, "to": login, "video": camOn])
        toast("Вызываем \(name)…")
    }

    // =====================================================================
    // Звук: включает CallKit (didActivate), мы выбираем динамик
    // =====================================================================
    /// Перед звонком: категория «разговор» (заранее, до того как CallKit включит звук)
    static func configureAudio() {
        let s = RTCAudioSession.sharedInstance()
        s.lockForConfiguration()
        let c = RTCAudioSessionConfiguration.webRTC()
        c.category = AVAudioSession.Category.playAndRecord.rawValue
        c.mode = AVAudioSession.Mode.voiceChat.rawValue
        c.categoryOptions = [.allowBluetooth]
        try? s.setConfiguration(c)
        s.unlockForConfiguration()
    }

    func audioActivated(_ session: AVAudioSession) {
        let s = RTCAudioSession.sharedInstance()
        s.audioSessionDidActivate(session)
        s.isAudioEnabled = true
        audioActive = true
        applyRoute()
    }

    func audioDeactivated(_ session: AVAudioSession) {
        let s = RTCAudioSession.sharedInstance()
        s.audioSessionDidDeactivate(session)
        s.isAudioEnabled = false
        audioActive = false
    }

    private func applyRoute() {
        let s = RTCAudioSession.sharedInstance()
        if audioActive {
            s.lockForConfiguration()
            try? s.overrideOutputAudioPort(speaker ? .speaker : .none)
            s.unlockForConfiguration()
        }
        // экран гаснет у уха (только в обычном режиме без камеры и наушников)
        UIDevice.current.isProximityMonitoringEnabled = busy && state != .ringing && !speaker && !camOn && !headset()
        UIApplication.shared.isIdleTimerDisabled = busy
    }

    private func headset() -> Bool {
        let types: [AVAudioSession.Port] = [.headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .usbAudio, .carAudio]
        return AVAudioSession.sharedInstance().currentRoute.outputs.contains { types.contains($0.portType) }
    }

    /// Громкую связь переключили на системном экране / подключили наушники
    private func routeChanged() {
        guard busy else { return }
        let outs = AVAudioSession.sharedInstance().currentRoute.outputs
        let spk = outs.contains { $0.portType == .builtInSpeaker }
        if spk != speaker && audioActive { speaker = spk }
        UIDevice.current.isProximityMonitoringEnabled = busy && state != .ringing && !speaker && !camOn && !headset()
        changed()
    }

    // =====================================================================
    // Медиа
    // =====================================================================
    private func startMedia(video: Bool) {
        if audioTrack == nil {
            let src = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            audioTrack = factory.audioTrack(with: src, trackId: "a0")
        }
        audioTrack?.isEnabled = !muted
        if video && !startCamera() { toast("Нет доступа к камере — звонок без видео") }
        applyRoute()
    }

    private func startCamera() -> Bool {
        if localVideo != nil { return true }
        guard AVCaptureDevice.authorizationStatus(for: .video) != .denied, UIApplication.shared.applicationState != .background else { return false }
        let src = factory.videoSource()
        videoSource = src
        capturer = RTCCameraVideoCapturer(delegate: src)
        localVideo = factory.videoTrack(with: src, trackId: "v0")
        camOn = true
        startCapture()
        return true
    }

    private func startCapture() {
        guard let cap = capturer else { return }
        let devs = RTCCameraVideoCapturer.captureDevices()
        guard let dev = devs.first(where: { $0.position == (front ? .front : .back) }) ?? devs.first else { return }
        let fmts = RTCCameraVideoCapturer.supportedFormats(for: dev)
        let target = 1280 * 720
        func px(_ f: AVCaptureDevice.Format) -> Int {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription); return Int(d.width) * Int(d.height)
        }
        guard let fmt = fmts.min(by: { abs(px($0) - target) < abs(px($1) - target) }) else { return }
        let maxFps = fmt.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 30
        cap.startCapture(with: dev, format: fmt, fps: Int(min(30, maxFps)))
    }

    private func stopCapture() { capturer?.stopCapture() }

    private func stopCamera() {
        stopCapture()
        capturer = nil; localVideo = nil; videoSource = nil
        camOn = false
    }

    // =====================================================================
    // Соединения с участниками
    // =====================================================================
    private func newPeer(_ login: String) -> CallPeer? {
        let cfg = RTCConfiguration()
        cfg.iceServers = iceServers
        cfg.sdpSemantics = .unifiedPlan
        cfg.bundlePolicy = .maxBundle
        cfg.rtcpMuxPolicy = .require
        cfg.continualGatheringPolicy = .gatherContinually
        let p = CallPeer(login: login)
        p.engine = self
        guard let pc = factory.peerConnection(with: cfg, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: p) else { return nil }
        p.pc = pc
        pending.removeAll { k($0) == k(login) }
        peers.append(p)
        lookupName(login)
        return p
    }

    private func offerTo(_ login: String) {
        guard let audio = audioTrack else { return }
        closePeer(login)
        guard let p = newPeer(login) else { return }
        let i = RTCRtpTransceiverInit()
        i.direction = .sendRecv
        i.streamIds = ["s"]
        p.at = p.pc.addTransceiver(with: audio, init: i)
        if let v = localVideo { p.vt = p.pc.addTransceiver(with: v, init: i) } else { p.vt = p.pc.addTransceiver(of: .video, init: i) }
        makeOffer(p)
        changed()
    }

    private func makeOffer(_ p: CallPeer) {
        p.pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { [weak self] sdp, _ in
            DispatchQueue.main.async {
                guard let self, let sdp else { return }
                self.setLocal(p, sdp) { local in
                    if let cid = self.id { Signaling.shared.send(["type": "offer", "id": cid, "to": p.login, "sdp": self.sdpJson(local)]) }
                }
            }
        }
    }

    private func answerFrom(_ login: String, _ sdp: [String: Any]) {
        guard let audio = audioTrack else { return }
        guard let p = peer(login) ?? newPeer(login) else { return }
        p.pc.setRemoteDescription(desc(sdp)) { [weak self] err in
            DispatchQueue.main.async {
                guard let self, err == nil else { return }
                p.remoteSet = true
                for t in p.pc.transceivers {
                    t.setDirection(.sendRecv, error: nil)
                    if t.mediaType == .audio { t.sender.track = audio; p.at = t } else { t.sender.track = self.localVideo; p.vt = t }
                    t.sender.streamIds = ["s"]
                }
                p.pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, _ in
                    DispatchQueue.main.async {
                        guard let sdp else { return }
                        self.setLocal(p, sdp) { local in
                            if let cid = self.id { Signaling.shared.send(["type": "answer", "id": cid, "to": login, "sdp": self.sdpJson(local)]) }
                            self.flushIce(p)
                        }
                    }
                }
            }
        }
        changed()
    }

    private func setLocal(_ p: CallPeer, _ d: RTCSessionDescription, then: @escaping (RTCSessionDescription) -> Void) {
        let m = RTCSessionDescription(type: d.type, sdp: mungeVideoStart(mungeOpus(d.sdp)))
        p.pc.setLocalDescription(m) { err in DispatchQueue.main.async { if err == nil { then(m) } } }
    }

    private func flushIce(_ p: CallPeer) {
        for c in p.ice { p.pc.add(c) { _ in } }
        p.ice.removeAll()
    }

    func localCandidate(_ p: CallPeer, _ c: RTCIceCandidate) {
        guard let cid = id, peer(p.login) === p else { return }
        var cand: [String: Any] = ["candidate": c.sdp, "sdpMLineIndex": Int(c.sdpMLineIndex)]
        if let mid = c.sdpMid { cand["sdpMid"] = mid }
        Signaling.shared.send(["type": "ice", "id": cid, "to": p.login, "candidate": cand])
    }

    func pcState(_ p: CallPeer, _ s: RTCPeerConnectionState) {
        guard busy, peer(p.login) === p else { return }
        switch s {
        case .connected:
            p.connected = true; p.lost = nil
            p.restart?.cancel(); p.restart = nil
            if t0 == nil {
                t0 = Date(); state = .active; status = ""
                CallManager.shared.connected()
            }
            if let cid = id { Signaling.shared.send(["type": "media", "id": cid, "video": camOn]) }
            applySenderParams(p)
            applyRoute()
            diag("connected", "\(p.login) громкая=\(speaker) вывод=\(AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ","))")
        case .disconnected, .failed:
            p.connected = false
            if p.lost == nil { p.lost = Date() }
            scheduleRestart(p, s == .failed ? 0 : 2.5)
        default: break
        }
        changed()
    }

    // ---- восстановление связи (ICE restart) ----
    private func scheduleRestart(_ p: CallPeer, _ delay: TimeInterval) {
        guard p.restart == nil else { return }
        let w = DispatchWorkItem { [weak self, weak p] in
            guard let self, let p else { return }
            p.restart = nil
            guard self.busy, self.peer(p.login) === p, !p.connected else { return }
            if let l = p.lost, Date().timeIntervalSince(l) > self.RECOVER {
                self.toast("Связь с \(self.nameOf(p.login)) потеряна")
                self.closePeer(p.login)
                if self.peers.isEmpty && self.pending.isEmpty { self.end(notify: true, text: "Связь потеряна", report: .failed) }
                self.changed()
                return
            }
            self.restartIce(p)
            self.scheduleRestart(p, 8)
        }
        p.restart = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    /// Новое предложение делает тот, у кого логин «меньше»; второй просит его об этом
    private func restartIce(_ p: CallPeer) {
        guard let cid = id else { return }
        if me > k(p.login) { Signaling.shared.send(["type": "reneg", "id": cid, "to": p.login]); return }
        let go = { [weak self] in p.pc.restartIce(); self?.makeOffer(p) }
        switch p.pc.signalingState {
        case .haveLocalOffer:
            p.pc.setLocalDescription(RTCSessionDescription(type: .rollback, sdp: "")) { _ in DispatchQueue.main.async { go() } }
        case .stable: go()
        default: break
        }
    }

    private func closePeer(_ login: String) {
        guard let i = peers.firstIndex(where: { k($0.login) == k(login) }) else { return }
        let p = peers.remove(at: i)
        p.restart?.cancel()
        p.pc.close()
    }

    private func applySenderParams(_ only: CallPeer?) {
        let group = peers.count > 1
        for p in only.map({ [$0] }) ?? peers {
            for sd in p.pc.senders {
                guard let tr = sd.track else { continue }
                let prm = sd.parameters
                guard let e = prm.encodings.first else { continue }
                if tr.kind == "audio" { e.maxBitrateBps = NSNumber(value: AUDIO_BR) }
                else {
                    e.maxBitrateBps = NSNumber(value: group ? 1_000_000 : VIDEO_BR)
                    e.maxFramerate = 30
                    e.scaleResolutionDownBy = NSNumber(value: group ? 720.0 / 540.0 : 1.0)
                }
                sd.parameters = prm
            }
        }
    }

    private func addPending(_ login: String) {
        guard !login.isEmpty, peer(login) == nil, k(login) != me, !pending.contains(where: { k($0) == k(login) }) else { return }
        pending.append(login)
        lookupName(login)
    }

    private func dropPending(_ login: String) { pending.removeAll { k($0) == k(login) } }

    // =====================================================================
    // Завершение
    // =====================================================================
    /// report — сообщить системе (CallKit), что звонок закончился не по нашей кнопке
    func end(notify: Bool, text: String, noLog: Bool = false, report: CXEndReasonish?) {
        guard busy else { return }
        let cid = id
        if notify, let cid { Signaling.shared.send(["type": "hangup", "id": cid]) }
        let logins = peers.map { $0.login }
        if !noLog && dir != "declined" {
            logCall(peer: logins.isEmpty ? firstLogin : logins.joined(separator: ", "), video: video0 || offerVideo,
                    dir: dir == "ring" ? "missed" : dir, dur: t0.map { Int(Date().timeIntervalSince($0)) } ?? 0, group: logins.count > 1)
        }
        for p in peers { p.restart?.cancel(); p.pc.close() }
        peers.removeAll(); pending.removeAll()
        stopCamera()
        audioTrack = nil
        wantAccept = nil
        state = .ended; status = text
        UIDevice.current.isProximityMonitoringEnabled = false
        UIApplication.shared.isIdleTimerDisabled = false
        CallManager.shared.engineEnded(id: cid, reason: report)
        changed()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.state == .ended else { return }
            self.state = .idle; self.id = nil; self.changed()
        }
    }

    private func reset() {
        id = nil; dir = ""; title = ""; firstLogin = ""; offerVideo = false; status = ""; t0 = nil
        muted = false; camOn = false; front = true; speaker = false; routeManual = false; video0 = false
        peers.removeAll(); pending.removeAll()
    }

    // =====================================================================
    // Вспомогательное
    // =====================================================================
    func toast(_ text: String) { CallManager.shared.toast(text) }

    private func desc(_ j: [String: Any]) -> RTCSessionDescription {
        RTCSessionDescription(type: RTCSessionDescription.type(for: (j["type"] as? String) ?? "offer"), sdp: (j["sdp"] as? String) ?? "")
    }
    private func sdpJson(_ d: RTCSessionDescription) -> [String: Any] {
        ["type": RTCSessionDescription.string(for: d.type), "sdp": d.sdp]
    }

    /// Opus: FEC, 64 кбит/с, пакеты по 20 мс
    private func mungeOpus(_ sdp: String) -> String {
        guard let m = firstMatch("a=rtpmap:(\\d+) opus/48000/2", sdp, caseless: true), m.count > 1 else { return sdp }
        let pt = m[1]
        let want = "minptime=20;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxplaybackrate=48000;sprop-maxcapturerate=48000;maxaveragebitrate=\(AUDIO_BR);cbr=0"
        var s = sdp
        if firstMatch("a=fmtp:\(pt) .*", s) != nil {
            s = s.replacingOccurrences(of: "a=fmtp:\(pt) [^\\r\\n]*", with: "a=fmtp:\(pt) \(want)", options: .regularExpression)
        } else {
            s = s.replacingOccurrences(of: m[0], with: "\(m[0])\r\na=fmtp:\(pt) \(want)")
        }
        if s.contains("a=ptime:") { s = s.replacingOccurrences(of: "a=ptime:\\d+", with: "a=ptime:20", options: .regularExpression) }
        else { s = s.replacingOccurrences(of: m[0], with: "\(m[0])\r\na=ptime:20") }
        return s
    }

    private func mungeVideoStart(_ sdp: String) -> String {
        var s = sdp
        let re = try! NSRegularExpression(pattern: "a=rtpmap:(\\d+) (VP8|VP9|H264)/90000", options: .caseInsensitive)
        let ns = sdp as NSString
        let pts = re.matches(in: sdp, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
        for pt in Set(pts) {
            if let line = firstMatch("a=fmtp:\(pt) [^\\r\\n]*", s)?.first {
                if !line.contains("x-google-start-bitrate") {
                    s = s.replacingOccurrences(of: line, with: "\(line);x-google-start-bitrate=\(VIDEO_START_KBPS)")
                }
            } else if let rtp = firstMatch("a=rtpmap:\(pt) [^\\r\\n]+", s)?.first {
                s = s.replacingOccurrences(of: rtp, with: "\(rtp)\r\na=fmtp:\(pt) x-google-start-bitrate=\(VIDEO_START_KBPS)")
            }
        }
        return s
    }

    private func firstMatch(_ pattern: String, _ s: String, caseless: Bool = false) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: caseless ? .caseInsensitive : []) else { return nil }
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    func fmtNum(_ n: String) -> String {
        n.count == 6 && n.allSatisfy({ $0.isNumber }) ? String(n.prefix(3)) + " " + String(n.suffix(3)) : n
    }

    private func prefetchIce() { if Date().timeIntervalSince(iceAt) > 6 * 3600 { withIce {} } }

    /// Адреса STUN/TURN (временный пароль на 12 часов) — потом действие
    private func withIce(_ then: @escaping () -> Void) {
        if !iceServers.isEmpty && Date().timeIntervalSince(iceAt) < 6 * 3600 { then(); return }
        CallManager.apiAny("GET", "/api/ice") { [weak self] json in
            guard let self else { return }
            var list: [RTCIceServer] = []
            for o in (json as? [[String: Any]]) ?? [] {
                let urls: [String] = (o["urls"] as? [String]) ?? ((o["urls"] as? String).map { [$0] } ?? [])
                if urls.isEmpty { continue }
                list.append(RTCIceServer(urlStrings: urls, username: o["username"] as? String, credential: o["credential"] as? String))
            }
            if !list.isEmpty { self.iceServers = list; self.iceAt = Date() }
            then()
        }
    }

    private func lookupName(_ login: String) {
        guard names[k(login)] == nil else { return }
        names[k(login)] = login
        let path = "/api/peer/" + (k(login).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? k(login))
        CallManager.api("GET", path) { [weak self] j in
            guard let self, let j else { return }
            let n = (j["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? self.fmtNum(j["num"] as? String ?? "")
            if !n.isEmpty { self.names[self.k(login)] = n; self.changed() }
        }
    }

    /// Контакты для «Позвать в звонок»: (логин, имя)
    func contacts(_ done: @escaping ([(String, String)]) -> Void) {
        CallManager.api("GET", "/api/contacts") { [weak self] j in
            let arr = (j?["contacts"] as? [[String: Any]]) ?? []
            done(arr.compactMap { o -> (String, String)? in
                guard let l = o["login"] as? String else { return nil }
                let n = (o["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? self?.fmtNum(o["num"] as? String ?? "") ?? l
                return (l, n)
            })
        }
    }

    func diag(_ ev: String, _ info: String) {
        CallManager.apiAny("POST", "/api/diag", body: ["ev": ev, "info": "ios-native \(info)", "ua": "AhazangApp/1.0 (iOS; native)"]) { _ in }
    }

    // ---- журнал звонков: забирает веб-интерфейс (вкладка «Звонки») ----
    private func logCall(peer: String, video: Bool, dir: String, dur: Int, group: Bool) {
        var arr = UserDefaults.standard.array(forKey: "callLog") as? [[String: Any]] ?? []
        arr.append(["peer": peer, "video": video, "dir": dir, "ts": Int(Date().timeIntervalSince1970 * 1000), "dur": dur, "group": group])
        UserDefaults.standard.set(Array(arr.suffix(100)), forKey: "callLog")
        CallManager.shared.web?.pushCallLog()
    }
}

/// Причина окончания для системного экрана звонка
enum CXEndReasonish { case failed, remoteEnded, unanswered, answeredElsewhere }
