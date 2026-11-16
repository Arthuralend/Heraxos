import UIKit

/// Адрес сервера Ahazang
let SERVER = URL(string: "https://82-26-86-235.sslip.io:8445/")!

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.backgroundColor = Theme.bg
        window?.rootViewController = WebViewController()
        window?.makeKeyAndVisible()
        return true
    }
}

enum Theme {
    /// Кремовый фон (светлая тема Ahazang)
    static let bg = UIColor(red: 0.980, green: 0.976, blue: 0.961, alpha: 1)   // #FAF9F5
}
