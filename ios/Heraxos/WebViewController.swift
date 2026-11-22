import UIKit
import WebKit

/// Ahazang внутри приложения: чаты — встроенный интерфейс, звонки — нативные (CallEngine + CallKit).
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    private var web: WKWebView!
    private var darkBars = false
    private var saves: [String: (url: URL, handle: FileHandle)] = [:]

    override var preferredStatusBarStyle: UIStatusBarStyle {
        if #available(iOS 13.0, *) { return darkBars ? .lightContent : .darkContent }
        return darkBars ? .lightContent : .default
    }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        // метка приложения: сервер отдаёт интерфейс и API только приложениям Ahazang
        cfg.applicationNameForUserAgent = "Mobile/15E148 AhazangApp/1.0 (iOS)"

        // Мост к веб-приложению (тот же интерфейс, что у Android-версии)
        let shim = """
        window.HeraxosPlatform = 'ios';
        window.HeraxosAndroid = {
          setSession: function(t, l) { window.webkit.messageHandlers.hx.postMessage({a: 'session', l: String(l), t: String(t)}); },
          clearSession: function() { window.webkit.messageHandlers.hx.postMessage({a: 'clear'}); },
          nativeCalls: function() { return true; },
          startCall: function(l, t, v) { window.webkit.messageHandlers.hx.postMessage({a: 'startCall', l: String(l), t: String(t || ''), v: !!v}); },
          openCall: function() { window.webkit.messageHandlers.hx.postMessage({a: 'openCall'}); },
          inCall: function() { return false; },
          callLogReady: function() { window.webkit.messageHandlers.hx.postMessage({a: 'callLog'}); },
          setVideoSlots: function(j) { window.webkit.messageHandlers.hx.postMessage({a: 'slots', j: String(j || '')}); },
          gameCamera: function(on) { window.webkit.messageHandlers.hx.postMessage({a: 'gameCam', on: !!on}); },
          startCallStay: function(l, t, v) { window.webkit.messageHandlers.hx.postMessage({a: 'startCall', l: String(l), t: String(t || ''), v: !!v, stay: true}); },
          setBars: function(dark) { window.webkit.messageHandlers.hx.postMessage({a: 'bars', dark: !!dark}); },
          fileBegin: function(sid, name, type) { window.webkit.messageHandlers.hx.postMessage({a: 'fileBegin', sid: String(sid), name: String(name)}); },
          fileChunk: function(sid, b64) { window.webkit.messageHandlers.hx.postMessage({a: 'fileChunk', sid: String(sid), b64: String(b64)}); },
          fileEnd: function(sid) { window.webkit.messageHandlers.hx.postMessage({a: 'fileEnd', sid: String(sid)}); }
        };
        """
        cfg.userContentController.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "hx")

        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = Theme.bg
        web.scrollView.backgroundColor = Theme.bg
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        CallManager.shared.web = self
        web.load(URLRequest(url: SERVER))
    }

    // ---- звонки с системного экрана (CallKit) ----
    func evaluate(_ js: String) { web.evaluateJavaScript(js, completionHandler: nil) }

    /// Журнал нативных звонков → вкладка «Звонки» (удаляем отданные записи, только если интерфейс их принял)
    func pushCallLog() {
        let arr = UserDefaults.standard.array(forKey: "callLog") as? [[String: Any]] ?? []
        guard !arr.isEmpty, let d = try? JSONSerialization.data(withJSONObject: arr), let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.hxNativeLog ? hxNativeLog(\(json)) : false") { r, _ in
            guard (r as? Bool) == true else { return }
            let now = UserDefaults.standard.array(forKey: "callLog") as? [[String: Any]] ?? []
            UserDefaults.standard.set(Array(now.dropFirst(arr.count)), forKey: "callLog")
        }
    }

    /// VoIP-токен этого iPhone — интерфейс отправит его на сервер после входа
    func sendVoipToken() {
        guard let t = CallManager.shared.voipToken else { return }
        evaluate("window.hxSetVoip && hxSetVoip('\(t)')")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { sendVoipToken(); CallManager.shared.pageLoaded() }

    // Микрофон и камера для нашего сервера — без лишних вопросов (системный запрос iOS показывает один раз)
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == SERVER.host ? .grant : .prompt)
    }

    // Внешние ссылки — в Safari
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // почта и телефон — в системные приложения
        if let u = navigationAction.request.url, let scheme = u.scheme?.lowercased(), ["mailto", "tel"].contains(scheme) {
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        if let u = navigationAction.request.url, let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != SERVER.host {
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLater() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLater() }
    private func retryLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.web.url == nil || self.web.isLoading == false else { return }
            if self.web.url == nil { self.web.load(URLRequest(url: SERVER)) }
        }
    }

    // ---- мост из JS ----
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let a = d["a"] as? String else { return }
        switch a {
        case "startCall":
            CallManager.shared.startOutgoing(login: d["l"] as? String ?? "", name: d["t"] as? String ?? "", video: d["v"] as? Bool ?? false,
                                             stay: d["stay"] as? Bool ?? false)
        case "slots": CallManager.shared.setVideoSlots(d["j"] as? String ?? "")
        case "gameCam": CallManager.shared.gameCamera(d["on"] as? Bool ?? false)
        case "openCall": CallManager.shared.showCallUI()
        case "callLog": pushCallLog()
        case "bars":
            darkBars = d["dark"] as? Bool ?? false
            setNeedsStatusBarAppearanceUpdate()
        case "fileBegin": fileBegin(d["sid"] as? String ?? "", d["name"] as? String ?? "file")
        case "fileChunk":
            if let sid = d["sid"] as? String, let b64 = d["b64"] as? String, let s = saves[sid], let data = Data(base64Encoded: b64) {
                s.handle.write(data)
            }
        case "fileEnd": fileEnd(d["sid"] as? String ?? "")
        case "session":
            UserDefaults.standard.set(d["l"] as? String, forKey: "login")
            let changed = UserDefaults.standard.string(forKey: "token") != d["t"] as? String
            UserDefaults.standard.set(d["t"] as? String, forKey: "token")
            sendVoipToken()
            if changed { Signaling.shared.disconnect() }
            Signaling.shared.connect()
        case "clear":
            UserDefaults.standard.removeObject(forKey: "login")
            UserDefaults.standard.removeObject(forKey: "token")
            Signaling.shared.disconnect()
        default: break
        }
    }

    // ---- сохранение расшифрованного файла: временный файл → меню «Поделиться» (Сохранить в Файлы / Фото) ----
    private func fileBegin(_ sid: String, _ rawName: String) {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|")
        var name = rawName.components(separatedBy: bad).joined(separator: "_").trimmingCharacters(in: .whitespaces)
        if name.isEmpty { name = "file" }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ahazang", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(String(name.prefix(120)))
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: url.path, contents: nil),
              let h = try? FileHandle(forWritingTo: url) else { return }
        saves[sid] = (url, h)
    }

    private func fileEnd(_ sid: String) {
        guard let s = saves.removeValue(forKey: sid) else { return }
        s.handle.closeFile()
        let share = UIActivityViewController(activityItems: [s.url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 40, width: 1, height: 1)
        present(share, animated: true)
    }

    // ---- alert / confirm / prompt из веб-приложения ----
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let ac = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        ac.addTextField { $0.text = defaultText }
        ac.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(ac.textFields?.first?.text) })
        present(ac, animated: true)
    }
}
