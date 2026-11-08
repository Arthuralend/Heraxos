import UIKit
import WebKit

/// Heraxos внутри приложения: тот же интерфейс, что на сайте, плюс нативное управление звуком звонка.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    private var web: WKWebView!

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()

        // Мост к веб-приложению (тот же интерфейс, что у Android-версии)
        let shim = """
        window.HeraxosPlatform = 'ios';
        window.HeraxosAndroid = {
          setSession: function(t, l) { window.webkit.messageHandlers.hx.postMessage({a: 'session', l: String(l)}); },
          clearSession: function() { window.webkit.messageHandlers.hx.postMessage({a: 'clear'}); },
          setAudioRoute: function(r) { window.webkit.messageHandlers.hx.postMessage({a: 'route', r: String(r)}); }
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
        web.load(URLRequest(url: SERVER))
    }

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
        case "route": AudioRoute.set(d["r"] as? String ?? "off")
        case "session": UserDefaults.standard.set(d["l"] as? String, forKey: "login")
        case "clear": UserDefaults.standard.removeObject(forKey: "login")
        default: break
        }
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
