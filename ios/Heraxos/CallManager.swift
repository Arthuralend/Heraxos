import CallKit
import PushKit
import UIKit

/// Звонки как в WhatsApp: сервер присылает VoIP-сигнал через Apple (PushKit), iOS будит приложение даже
/// закрытым, и мы сразу показываем системный экран входящего звонка (CallKit).
/// Сам разговор идёт во встроенном интерфейсе Ahazang (WebRTC), который открывается при ответе.
final class CallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = CallManager()

    private struct Incoming { let id: String; let video: Bool; var answered = false }

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private var calls: [UUID: Incoming] = [:]
    private var poll: Timer?
    weak var web: WebViewController?
    private(set) var voipToken: String?

    override init() {
        let cfg = CXProviderConfiguration()
        cfg.supportsVideo = true
        cfg.maximumCallGroups = 1
        cfg.maximumCallsPerCallGroup = 1
        cfg.supportedHandleTypes = [.generic]
        cfg.includesCallsInRecents = true
        provider = CXProvider(configuration: cfg)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Вызывать при запуске приложения: без этого iOS не доставит VoIP-сигнал закрытому приложению
    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
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
        let name = (d["name"] as? String) ?? (d["from"] as? String) ?? "Ahazang"
        let video = (d["video"] as? Bool) ?? false
        let uuid = CallManager.uuid(for: id)

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: name)
        update.localizedCallerName = name
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        // iOS требует показать звонок на КАЖДЫЙ VoIP-сигнал, иначе закроет приложение
        let known = calls[uuid] != nil
        if !known { calls[uuid] = Incoming(id: id, video: video) }
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error != nil, !known { self?.calls[uuid] = nil }
            self?.startPolling()
            completion()
        }
    }

    // MARK: - CallKit

    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
        stopPolling()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard var c = calls[action.callUUID] else { action.fail(); return }
        c.answered = true
        calls[action.callUUID] = c
        action.fulfill()
        web?.answerCall(id: c.id, video: c.video)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let c = calls.removeValue(forKey: action.callUUID) {
            if c.answered {
                web?.evaluate("window.hxHangup && hxHangup()")
            } else {
                web?.evaluate("window.hxDecline && hxDecline('\(c.id)')")
                CallManager.api("POST", "/api/call/\(c.id)/reject")
            }
        }
        action.fulfill()
        if calls.isEmpty { stopPolling() }
    }

    // MARK: - Связь со встроенным интерфейсом

    /// Звонок начался/закончился в самом приложении
    func pageCall(on: Bool, id: String) {
        if on {
            // ответили кнопкой в приложении, а системный экран ещё звонит — убираем его
            for (uuid, c) in calls where c.id == id && !c.answered {
                provider.reportCall(with: uuid, endedAt: nil, reason: .answeredElsewhere)
                calls[uuid] = nil
            }
        } else {
            for uuid in calls.keys { provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded) }
            calls.removeAll()
            stopPolling()
        }
    }

    // MARK: - Пока звонит: проверяем, не сбросил ли звонящий

    private func startPolling() {
        guard poll == nil else { return }
        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkRinging() }
    }

    private func stopPolling() { poll?.invalidate(); poll = nil }

    private func checkRinging() {
        let ringing = calls.filter { !$0.value.answered }
        if ringing.isEmpty { if calls.isEmpty { stopPolling() }; return }
        for (uuid, c) in ringing {
            CallManager.api("GET", "/api/call/\(c.id)") { [weak self] json in
                guard let self, let json, (json["ringing"] as? Bool) == false, (json["active"] as? Bool) != true else { return }
                guard let cur = self.calls[uuid], !cur.answered else { return }
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
                self.calls[uuid] = nil
            }
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

    /// Запрос к серверу Ahazang от имени вошедшего пользователя (токен сохраняет встроенный интерфейс)
    static func api(_ method: String, _ path: String, done: (([String: Any]?) -> Void)? = nil) {
        guard let token = UserDefaults.standard.string(forKey: "token"),
              let url = URL(string: path, relativeTo: SERVER) else { done?(nil); return }
        var r = URLRequest(url: url, timeoutInterval: 10)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("AhazangApp/1.0 (iOS; native)", forHTTPHeaderField: "User-Agent")
        if method == "POST" { r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = Data("{}".utf8) }
        URLSession.shared.dataTask(with: r) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { done?(json) }
        }.resume()
    }
}
