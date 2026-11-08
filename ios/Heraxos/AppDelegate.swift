import UIKit

/// Адрес сервера Heraxos
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
    static let bg = UIColor(red: 0.055, green: 0.059, blue: 0.067, alpha: 1)
}
