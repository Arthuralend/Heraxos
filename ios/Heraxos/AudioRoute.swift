import AVFoundation
import UIKit

/// «earpiece» — разговорный динамик (экран гаснет у уха), «speaker» — громкая связь, «off» — звонок закончен.
///
/// Аудиосессией (категория, режим, микрофон) владеет WebKit: он сам включает её при старте микрофона.
/// Приложение её НЕ перенастраивает — смена категории/режима или setActive во время захвата
/// обрывает микрофон в WebKit (собеседник не слышит; «оживал» только при переключении на громкую связь).
/// Здесь только выбираем, куда идёт звук: разговорный динамик или громкая связь.
enum AudioRoute {
    private static var current = "off"

    static func set(_ route: String) {
        DispatchQueue.main.async {
            current = route
            apply(route)
        }
        // WebKit включает аудиосессию не мгновенно после старта микрофона — повторяем выбор динамика
        if route != "off" {
            for delay in [0.4, 1.2, 2.5] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { if current == route { apply(route) } }
            }
        }
    }

    /// Пока идёт звонок, просим у iOS время на работу в фоне (режим audio в Info.plist держит звук,
    /// это дополнительно страхует сигнальное соединение при сворачивании приложения).
    private static var bgTask: UIBackgroundTaskIdentifier = .invalid
    static func keepAlive(_ on: Bool) {
        DispatchQueue.main.async {
            if on, bgTask == .invalid {
                bgTask = UIApplication.shared.beginBackgroundTask(withName: "ahazang-call") {
                    UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid
                }
            } else if !on, bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid
            }
        }
    }

    private static func apply(_ route: String) {
        let s = AVAudioSession.sharedInstance()
        if route == "off" {
            try? s.overrideOutputAudioPort(.none)
            UIDevice.current.isProximityMonitoringEnabled = false
            UIApplication.shared.isIdleTimerDisabled = false
            return
        }
        let speaker = route == "speaker"
        // Переключать динамик можно только в категории «запись и воспроизведение», которую ставит WebKit
        if s.category == .playAndRecord {
            try? s.overrideOutputAudioPort(speaker ? .speaker : .none)
        }
        let headsetTypes: [AVAudioSession.Port] = [.headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .usbAudio, .carAudio]
        let headset = s.currentRoute.outputs.contains { headsetTypes.contains($0.portType) }
        UIDevice.current.isProximityMonitoringEnabled = !speaker && !headset
        UIApplication.shared.isIdleTimerDisabled = true
    }
}
