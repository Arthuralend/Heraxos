import UIKit

/// Адрес сервера Ahazang
let SERVER = URL(string: "https://ahazang.klegal.ru/")!

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // звонки при закрытом приложении: регистрация VoIP-сигналов Apple (должна быть при каждом запуске)
        CallManager.shared.start()
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.backgroundColor = Theme.bg
        window?.rootViewController = WebViewController()
        window?.makeKeyAndVisible()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        CallManager.shared.appBecameActive()
    }
}

enum Theme {
    /// Кремовый фон (светлая тема Ahazang)
    static let bg = UIColor(red: 0.980, green: 0.976, blue: 0.961, alpha: 1)   // #FAF9F5
}
