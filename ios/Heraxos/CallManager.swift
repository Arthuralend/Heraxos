import AVFoundation
import CallKit
import PushKit
import UIKit
import WebRTC

/// Звонки как в WhatsApp: сервер присылает VoIP-сигнал через Apple (PushKit), iOS будит приложение даже
/// закрытым, звонок показывается на системном экране (CallKit), а сам разговор ведёт нативный модуль
/// CallEngine (WebRTC) — со звуком на заблокированном экране, громкой связью и Bluetooth.
final class CallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = CallManager()

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private let controller = CXCallController()
    private var uuid: UUID?                  // текущий звонок на системном экране
    private var reported = Set<UUID>()
    private var outgoing: (login: String, name: String, video: Bool)?
    private var stayOut = false                 // звонок из игры — без экрана звонка
    private var slots: [String: CGRect] = [:]   // окна видео в игре (точки страницы)
    private var vviews: [String: (view: RTCMTLVideoView, track: RTCVideoTrack?)] = [:]
    private var lastCallState = ""
    private var poll: Timer?
    weak var web: WebViewController?
    private(set) var voipToken: String?

    private weak var callVC: CallViewController?
    private var pill: UIButton?
    private var pillTimer: Timer?

    override init() {
        let cfg = CXProviderConfiguration()
        cfg.supportsVideo = true
        cfg.maximumCallGroups = 1
        cfg.maximumCallsPerCallGroup = 1
        cfg.supportedHandleTypes = [.generic]
        cfg.includesCallsInRecents = true
        if let icon = UIImage(named: "CallKitIcon") { cfg.iconTemplateImageData = icon.pngData() }
        provider = CXProvider(configuration: cfg)
        super.init()
        provider.setDelegate(self, queue: nil)

        let engine = CallEngine.shared
        Signaling.shared.onMessage = { m in
            let calls: Set<String> = ["invite", "calling", "error", "room", "ringing", "joined", "offer", "answer", "reneg",
                                      "ice", "media", "declined", "noanswer", "left", "hangup"]
            if let t = m["type"] as? String, calls.contains(t) { engine.onSignal(m) }
        }
        Signaling.shared.onOpen = { engine.onSignalingOpen() }
        engine.onUpdate = { [weak self] in self?.engineUpdated() }
    }

    /// Вызывать при запуске приложения: без этого iOS не доставит VoIP-сигнал закрытому приложению
    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        Signaling.shared.connect()
    }

    /// Приложение снова на экране: соединение и экран идущего звонка
    func appBecameActive() {
        Signaling.shared.kick()
        let e = CallEngine.shared
        if e.busy && e.state != .ringing && callVC == nil { showCallUI() }
        updatePill()
    }

    // MARK: - PushKit

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        voipToken = credentials.token.map { String(format: "%02x", $0) }.joined()
        web?.sendVoipToken()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        voipToken = nil
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        let d = payload.dictionaryPayload
        let id = (d["id"] as? String) ?? ""
        let from = (d["from"] as? String) ?? ""
        let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? CallEngine.shared.fmtNum((d["num"] as? String) ?? from)
        let video = (d["video"] as? Bool) ?? false
        let e = CallEngine.shared
        Signaling.shared.connect()

        // iOS требует показать звонок на КАЖДЫЙ VoIP-сигнал, иначе закроет приложение
        if e.busy && e.id != id {
            let u = CallManager.uuid(for: id)
            provider.reportNewIncomingCall(with: u, update: callUpdate(name, video)) { [weak self] _ in
                self?.provider.reportCall(with: u, endedAt: nil, reason: .unanswered)
                completion()
            }
            CallManager.api("POST", "/api/call/\(id)/reject")
            return
        }
        if !e.busy { e.prepareIncoming(id: id, from: from, name: name, video: video) }
        reportIncoming(id: id, name: name, video: video, completion: completion)
    }

    // MARK: - Системный экран звонка

    private func callUpdate(_ name: String, _ video: Bool) -> CXCallUpdate {
        let u = CXCallUpdate()
        u.remoteHandle = CXHandle(type: .generic, value: name)
        u.localizedCallerName = name
        u.hasVideo = video
        u.supportsHolding = false
        u.supportsGrouping = false
        u.supportsUngrouping = false
        u.supportsDTMF = false
        return u
    }

    /// Показать входящий на системном экране (один раз на звонок)
    func reportIncoming(id: String, name: String, video: Bool, completion: (() -> Void)? = nil) {
        let u = CallManager.uuid(for: id)
        if reported.contains(u) { completion?(); return }
        reported.insert(u)
        uuid = u
        CallEngine.configureAudio()
        provider.reportNewIncomingCall(with: u, update: callUpdate(name, video)) { [weak self] error in
            if error != nil, let self {
                self.reported.remove(u)
                if self.uuid == u { self.uuid = nil }
            }
            completion?()
        }
        startPolling()
    }

    /// Звонок из интерфейса (кнопка в чате / контактах)
    func startOutgoing(login: String, name: String, video: Bool, stay: Bool = false) {
        let e = CallEngine.shared
        if e.busy { if !stay { showCallUI() }; return }
        stayOut = stay
        let wantVideo = video
        let go = { [weak self] in
            guard let self else { return }
            let u = UUID()
            self.uuid = u
            self.outgoing = (login, name, wantVideo)
            let a = CXStartCallAction(call: u, handle: CXHandle(type: .generic, value: name.isEmpty ? login : name))
            a.isVideo = wantVideo
            a.contactIdentifier = login
            self.controller.request(CXTransaction(action: a)) { err in
                DispatchQueue.main.async {
                    if let err {
                        self.uuid = nil; self.outgoing = nil
                        self.toast("Не удалось начать звонок")
                        CallEngine.shared.diag("start-err", err.localizedDescription)
                    }
                }
            }
        }
        // доступ к микрофону (и камере) спрашиваем до звонка
        AVAudioSession.sharedInstance().requestRecordPermission { ok in
            DispatchQueue.main.async {
                guard ok else { self.toast("Нет доступа к микрофону: Настройки → Ahazang → Микрофон"); return }
                if wantVideo { AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { go() } } } else { go() }
            }
        }
    }

    func outgoingStarted(id: String) { _ = id }

    func connected() {
        if let u = uuid, CallEngine.shared.dir == "out" { provider.reportOutgoingCall(with: u, connectedAt: Date()) }
    }

    /// Звонок закончился. reason ≠ nil — закончился не по нашей кнопке, сообщаем системе
    func engineEnded(id: String?, reason: CXEndReasonish?) {
        stopPolling()
        if let u = uuid {
            if let r = reason {
                let cx: CXCallEndedReason
                switch r {
                case .failed: cx = .failed
                case .remoteEnded: cx = .remoteEnded
                case .unanswered: cx = .unanswered
                case .answeredElsewhere: cx = .answeredElsewhere
                }
                provider.reportCall(with: u, endedAt: Date(), reason: cx)
            } else {
                // завершили сами — убираем звонок с системного экрана, если он ещё там
                controller.request(CXTransaction(action: CXEndCallAction(call: u))) { _ in }
            }
        }
        uuid = nil; outgoing = nil
    }

    /// Кнопка «Завершить» на экране звонка
    func requestEnd() {
        if let u = uuid {
            controller.request(CXTransaction(action: CXEndCallAction(call: u))) { err in
                if err != nil { DispatchQueue.main.async { CallEngine.shared.hangup() } }
            }
        } else { CallEngine.shared.hangup() }
    }

    func requestMute(_ on: Bool) {
        if let u = uuid {
            controller.request(CXTransaction(action: CXSetMutedCallAction(call: u, muted: on))) { err in
                if err != nil { DispatchQueue.main.async { CallEngine.shared.setMuted(on) } }
            }
        } else { CallEngine.shared.setMuted(on) }
    }

    // MARK: - CXProviderDelegate

    func providerDidReset(_ provider: CXProvider) {
        CallEngine.shared.hangup()
        uuid = nil
        stopPolling()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let o = outgoing else { action.fail(); return }
        CallEngine.configureAudio()
        CallEngine.shared.startCall(login: o.login, name: o.name, video: o.video)
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
        let up = callUpdate(o.name.isEmpty ? o.login : o.name, o.video)
        provider.reportCall(with: action.callUUID, updated: up)
        if !stayOut { showCallUI() }
        stayOut = false
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let e = CallEngine.shared
        CallEngine.configureAudio()
        // видео сразу — только если приложение открыто (камера не работает на экране блокировки)
        let active = UIApplication.shared.applicationState == .active
        e.accept(video: e.offerVideo && active)
        action.fulfill()
        stopPolling()
        if active { showCallUI() }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if action.callUUID == uuid { uuid = nil; CallEngine.shared.hangup() }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        CallEngine.shared.setMuted(action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) { action.fulfill() }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        CallEngine.shared.audioActivated(audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        CallEngine.shared.audioDeactivated(audioSession)
    }

    // MARK: - Экран звонка и плашка «вернуться к звонку»

    func showCallUI() {
        guard UIApplication.shared.applicationState == .active, callVC == nil,
              let root = UIApplication.shared.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let vc = CallViewController()
        vc.modalPresentationStyle = .fullScreen
        callVC = vc
        top.present(vc, animated: true)
        updatePill()
    }

    /// Экран звонка свернули — звонок идёт, сверху зелёная плашка
    func callUIClosed() { callVC = nil; updatePill(); updateVideoOverlay() }

    /// Приглашение в игру, пока открыт экран звонка: показываем поверх него
    func gameInvite(name: String, title: String) {
        guard let vc = callVC, vc.presentedViewController == nil else { return }
        let ac = UIAlertController(title: "\(name) приглашает сыграть", message: "🎮 \(title)\n\nЗвонок продолжится — видео собеседника будет над игрой.", preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Отказаться", style: .cancel) { [weak self] _ in self?.web?.evaluate("window.hxGameAnswer && hxGameAnswer(false)") })
        ac.addAction(UIAlertAction(title: "Играть", style: .default) { [weak self] _ in
            self?.callVC?.dismiss(animated: true)
            self?.web?.evaluate("window.hxGameAnswer && hxGameAnswer(true)")
        })
        vc.present(ac, animated: true)
    }

    /// Кнопка игр на экране звонка: экран сворачивается, открываются игры с собеседником
    func openGames(peer: String) {
        let safe = peer.filter { $0.isLetter || $0.isNumber || "_.-".contains($0) }
        callVC?.dismiss(animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.web?.evaluate("window.hxOpenGames && hxOpenGames('\(safe)')")
        }
    }

    private func engineUpdated() {
        callVC?.refresh()
        updatePill()
        updateVideoOverlay()
        pushCallState()
    }

    // MARK: - Игры во время звонка: видео над доской

    /// Интерфейс сообщил, где в игре окна видео; пустая строка — убрать
    func setVideoSlots(_ json: String) {
        slots = [:]
        if let d = json.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            for key in ["remote", "local"] {
                if let r = o[key] as? [String: Any], let x = r["x"] as? Double, let y = r["y"] as? Double, let w = r["w"] as? Double, let h = r["h"] as? Double {
                    slots[key] = CGRect(x: x, y: y, width: w, height: h)
                }
            }
        }
        updateVideoOverlay()
        updatePill()
    }

    func gameCamera(_ on: Bool) {
        if !on { CallEngine.shared.gameCamera(false); return }
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                if ok { CallEngine.shared.gameCamera(true) } else { self.toast("Нет доступа к камере: Настройки → Ahazang → Камера") }
            }
        }
    }

    /// Страница перезагрузилась — снова сообщим ей состояние звонка
    func pageLoaded() { lastCallState = ""; pushCallState() }

    private func pushCallState() {
        let e = CallEngine.shared
        let active = e.busy && e.state != .ringing
        let p = e.peers.first
        let st: [String: Any] = ["active": active, "peer": active ? e.peerLogin : "", "camOn": active && e.camOn, "muted": active && e.muted,
                                 "remoteVideo": active && p?.video == true && p?.remoteVideo != nil]
        guard let d = try? JSONSerialization.data(withJSONObject: st, options: [.sortedKeys]), let json = String(data: d, encoding: .utf8),
              json != lastCallState else { return }
        lastCallState = json
        web?.evaluate("window.hxCallState && hxCallState(\(json))")
    }

    private func updateVideoOverlay() {
        let e = CallEngine.shared
        guard let host = web?.view else { return }
        let active = UIApplication.shared.applicationState == .active && e.busy && e.state != .ringing && callVC == nil
        let p = e.peers.first
        let remote = active && p?.video == true ? p?.remoteVideo : nil
        let local = active && !slots.isEmpty ? e.localVideo : nil
        var rr = slots["remote"]
        if rr == nil, slots.isEmpty, remote != nil { // обычная «картинка в картинке» в углу
            rr = CGRect(x: host.bounds.width - 116, y: host.safeAreaInsets.top + 48, width: 104, height: 150)
        }
        place("remote", remote, rr, host, mirror: false)
        place("local", local, slots["local"], host, mirror: e.front)
    }

    private func place(_ key: String, _ track: RTCVideoTrack?, _ rect: CGRect?, _ host: UIView, mirror: Bool) {
        guard let track, let rect, rect.width > 8 else {
            if let v = vviews.removeValue(forKey: key) { v.track?.remove(v.view); v.view.removeFromSuperview() }
            return
        }
        var v = vviews[key] ?? {
            let view = RTCMTLVideoView()
            view.videoContentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.layer.cornerRadius = 14
            view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(pillTap)))
            host.addSubview(view)
            return (view: view, track: nil)
        }()
        if v.track !== track { v.track?.remove(v.view); track.add(v.view); v.track = track }
        v.view.frame = rect
        v.view.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        host.bringSubviewToFront(v.view)
        vviews[key] = v
    }

    private func updatePill() {
        let e = CallEngine.shared
        let show = e.busy && e.state != .ringing && callVC == nil && slots.isEmpty
        guard show, let win = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) else {
            pill?.removeFromSuperview(); pill = nil
            pillTimer?.invalidate(); pillTimer = nil
            return
        }
        if pill == nil {
            let b = UIButton(type: .system)
            b.backgroundColor = UIColor(red: 0.31, green: 0.60, blue: 0.38, alpha: 1)
            b.setTitleColor(.white, for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
            b.layer.cornerRadius = 18
            b.addTarget(self, action: #selector(pillTap), for: .touchUpInside)
            win.addSubview(b)
            b.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                b.topAnchor.constraint(equalTo: win.safeAreaLayoutGuide.topAnchor, constant: 4),
                b.centerXAnchor.constraint(equalTo: win.centerXAnchor),
                b.heightAnchor.constraint(equalToConstant: 36),
                b.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            ])
            b.contentEdgeInsets = UIEdgeInsets(top: 0, left: 18, bottom: 0, right: 18)
            pill = b
            pillTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updatePillText() }
        }
        win.bringSubviewToFront(pill!)
        updatePillText()
    }

    private func updatePillText() {
        let e = CallEngine.shared
        var t = "📞 Вернуться к звонку"
        if let t0 = e.t0 { let s = Int(Date().timeIntervalSince(t0)); t += String(format: " · %d:%02d", s / 60, s % 60) }
        pill?.setTitle(t, for: .normal)
    }

    @objc private func pillTap() { showCallUI() }

    /// Короткая подсказка внизу экрана
    func toast(_ text: String) {
        guard let win = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) else { return }
        let l = PaddedLabel()
        l.text = text
        l.textColor = .white
        l.font = .systemFont(ofSize: 15, weight: .medium)
        l.backgroundColor = UIColor(white: 0.1, alpha: 0.85)
        l.layer.cornerRadius = 14
        l.clipsToBounds = true
        l.numberOfLines = 2
        l.textAlignment = .center
        win.addSubview(l)
        l.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            l.centerXAnchor.constraint(equalTo: win.centerXAnchor),
            l.bottomAnchor.constraint(equalTo: win.safeAreaLayoutGuide.bottomAnchor, constant: -150),
            l.widthAnchor.constraint(lessThanOrEqualTo: win.widthAnchor, constant: -40),
        ])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) {
            UIView.animate(withDuration: 0.25, animations: { l.alpha = 0 }) { _ in l.removeFromSuperview() }
        }
    }

    // MARK: - Пока звонит: проверяем, не сбросил ли звонящий

    private func startPolling() {
        guard poll == nil else { return }
        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkRinging() }
    }

    private func stopPolling() { poll?.invalidate(); poll = nil }

    private func checkRinging() {
        let e = CallEngine.shared
        guard e.state == .ringing, let id = e.id else { stopPolling(); return }
        CallManager.api("GET", "/api/call/\(id)") { json in
            guard let json, (json["ringing"] as? Bool) == false, (json["active"] as? Bool) != true else { return }
            guard e.state == .ringing, e.id == id else { return }
            e.end(notify: false, text: "Пропущенный звонок", report: .unanswered)
        }
    }

    // MARK: - Вспомогательное

    /// Номер звонка (16 hex) → UUID для CallKit
    static func uuid(for id: String) -> UUID {
        let hex = id.lowercased().filter { "0123456789abcdef".contains($0) }
        let h = Array((hex + String(repeating: "0", count: 32)).prefix(32))
        let s = String(h[0..<8]) + "-" + String(h[8..<12]) + "-" + String(h[12..<16]) + "-" + String(h[16..<20]) + "-" + String(h[20..<32])
        return UUID(uuidString: s) ?? UUID()
    }

    /// Запрос к серверу Ahazang от имени вошедшего пользователя (ответ — объект JSON)
    static func api(_ method: String, _ path: String, body: [String: Any]? = nil, done: (([String: Any]?) -> Void)? = nil) {
        apiAny(method, path, body: body) { done?($0 as? [String: Any]) }
    }

    /// То же, ответ — любой JSON (массив или объект)
    static func apiAny(_ method: String, _ path: String, body: [String: Any]? = nil, done: @escaping (Any?) -> Void) {
        guard let url = URL(string: path, relativeTo: SERVER) else { done(nil); return }
        var r = URLRequest(url: url, timeoutInterval: 10)
        r.httpMethod = method
        if let token = UserDefaults.standard.string(forKey: "token") { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        else if path != "/api/diag" { done(nil); return }
        r.setValue("AhazangApp/1.0 (iOS; native)", forHTTPHeaderField: "User-Agent")
        if method == "POST" {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = (try? JSONSerialization.data(withJSONObject: body ?? [:])) ?? Data("{}".utf8)
        }
        URLSession.shared.dataTask(with: r) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async { done(json) }
        }.resume()
    }
}

/// Подпись с отступами (для подсказок)
final class PaddedLabel: UILabel {
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: UIEdgeInsets(top: 8, left: 16, bottom: 8, right: 16))) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + 32, height: s.height + 16)
    }
}
