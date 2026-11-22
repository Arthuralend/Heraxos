import Foundation

/// Собственное соединение приложения с сервером Ahazang для звонков (WebSocket, тот же протокол, что у
/// веб-интерфейса). Работает и когда приложение свёрнуто / телефон заблокирован во время разговора.
final class Signaling: NSObject, URLSessionWebSocketDelegate {
    static let shared = Signaling()

    /// Сообщение от сервера (главный поток)
    var onMessage: (([String: Any]) -> Void)?
    /// Соединение установлено (главный поток)
    var onOpen: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private var isOpen = false
    private var queue: [String] = []
    private var backoff: TimeInterval = 1
    private var pingTimer: Timer?
    private var reconnect: DispatchWorkItem?
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

    var token: String? { UserDefaults.standard.string(forKey: "token") }

    func connect() {
        guard task == nil, let token else { return }
        reconnect?.cancel(); reconnect = nil
        var c = URLComponents(url: SERVER.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        c.scheme = SERVER.scheme == "http" ? "ws" : "wss"
        c.queryItems = [URLQueryItem(name: "bg", value: "1"), URLQueryItem(name: "token", value: token)]
        guard let url = c.url else { return }
        var r = URLRequest(url: url)
        r.setValue("AhazangApp/1.0 (iOS; native)", forHTTPHeaderField: "User-Agent")
        let t = session.webSocketTask(with: r)
        task = t
        t.resume()
        receive(t)
    }

    /// Выход из аккаунта
    func disconnect() {
        reconnect?.cancel(); reconnect = nil
        queue.removeAll()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil; isOpen = false
        pingTimer?.invalidate(); pingTimer = nil
    }

    /// Отправить сигнал; если соединения сейчас нет — уйдёт сразу после подключения
    func send(_ m: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) else { return }
        if let t = task, isOpen {
            t.send(.string(s)) { [weak self] err in
                if err != nil { DispatchQueue.main.async { self?.queue.append(s); self?.dropped(t) } }
            }
        } else {
            if queue.count < 300 { queue.append(s) }
            connect()
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.task === t else { return }
                switch result {
                case .success(let msg):
                    var data: Data?
                    switch msg {
                    case .string(let s): data = s.data(using: .utf8)
                    case .data(let d): data = d
                    @unknown default: break
                    }
                    if let data, let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { self.onMessage?(m) }
                    self.receive(t)
                case .failure:
                    self.dropped(t)
                }
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        isOpen = true; backoff = 1
        let pending = queue; queue.removeAll()
        for s in pending { webSocketTask.send(.string(s)) { _ in } }
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            guard let self, let t = self.task else { return }
            t.sendPing { err in if err != nil { DispatchQueue.main.async { self.dropped(t) } } }
        }
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if closeCode.rawValue == 4001 { // токен больше не действует
            task = nil; isOpen = false; return
        }
        dropped(webSocketTask)
    }

    func urlSession(_ session: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?) {
        if let ws = t as? URLSessionWebSocketTask { dropped(ws) }
    }

    private func dropped(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        task = nil; isOpen = false
        pingTimer?.invalidate(); pingTimer = nil
        t.cancel(with: .abnormalClosure, reason: nil)
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        reconnect = w
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: w)
        backoff = min(backoff * 2, 15)
    }

    /// Сменилась сеть / приложение вернулось на экран — переподключаемся сразу
    func kick() {
        if task == nil { backoff = 1; connect() }
    }
}
