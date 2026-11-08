import AVFoundation
import UIKit

/// «earpiece» — разговорный динамик (экран гаснет у уха), «speaker» — громкая связь, «off» — звонок закончен.
enum AudioRoute {
    static func set(_ route: String) {
        DispatchQueue.main.async { apply(route) }
        // WebKit сам настраивает аудиосессию при старте микрофона — повторяем выбор чуть позже
        if route != "off" { DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { apply(route) } }
    }

    private static func apply(_ route: String) {
        let s = AVAudioSession.sharedInstance()
        if route == "off" {
            try? s.overrideOutputAudioPort(.none)
            UIDevice.current.isProximityMonitoringEnabled = false
            UIApplication.shared.isIdleTimerDisabled = false
            return
        }
        try? s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP])
        try? s.setActive(true)
        let speaker = route == "speaker"
        try? s.overrideOutputAudioPort(speaker ? .speaker : .none)
        let headsetTypes: [AVAudioSession.Port] = [.headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .usbAudio, .carAudio]
        let headset = s.currentRoute.outputs.contains { headsetTypes.contains($0.portType) }
        UIDevice.current.isProximityMonitoringEnabled = !speaker && !headset
        UIApplication.shared.isIdleTimerDisabled = true
    }
}
