package am.heraxos.app

import android.app.Activity
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

/**
 * Куда идёт звук звонка: «earpiece» — разговорный динамик (у уха, экран гаснет при поднесении),
 * «speaker» — громкая связь, «off» — звонок закончен. Если подключена гарнитура/Bluetooth — звук в неё.
 *
 * Встроенный браузерный движок (WebView) при старте разговора сам выбирает вывод звука и может
 * перебить наш выбор, поэтому выбор повторяется ещё несколько раз в первые секунды.
 */
object AudioRoute {
    private var prox: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var current = "off"

    fun set(a: Activity, route: String) {
        current = route
        main.removeCallbacksAndMessages(null)
        apply(a, route)
        if (route != "off") for (ms in longArrayOf(400, 1200, 3000, 6000)) {
            main.postDelayed({ if (current == route && !a.isDestroyed) apply(a, route) }, ms)
        }
    }

    private fun apply(a: Activity, route: String) {
        val am = a.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (route == "off") {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
            am.mode = AudioManager.MODE_NORMAL
            a.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
            proximity(a, false)
            return
        }
        if (am.mode != AudioManager.MODE_IN_COMMUNICATION) am.mode = AudioManager.MODE_IN_COMMUNICATION
        a.volumeControlStream = AudioManager.STREAM_VOICE_CALL
        val speaker = route == "speaker"
        var headset = false
        if (Build.VERSION.SDK_INT >= 31) {
            val devs = am.availableCommunicationDevices
            val hs = devs.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            }
            val want = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            val dev = if (!speaker && hs != null) hs else devs.firstOrNull { it.type == want }
            headset = !speaker && hs != null
            if (dev != null && am.communicationDevice?.id != dev.id) am.setCommunicationDevice(dev)
        } else {
            @Suppress("DEPRECATION")
            headset = am.isWiredHeadsetOn || am.isBluetoothScoOn
        }
        // и старый способ: часть телефонов (и WebView) слушает только его
        @Suppress("DEPRECATION")
        if (am.isSpeakerphoneOn != speaker) am.isSpeakerphoneOn = speaker
        proximity(a, !speaker && !headset)
    }

    /** Для журнала: куда на самом деле идёт звук */
    fun describe(c: Context): String {
        val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val dev = if (Build.VERSION.SDK_INT >= 31) am.communicationDevice?.type?.let { typeName(it) } ?: "нет" else "-"
        @Suppress("DEPRECATION")
        return "выбор=$current режим=${am.mode} устройство=$dev громкая=${am.isSpeakerphoneOn}"
    }

    private fun typeName(t: Int) = when (t) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "динамик"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "у уха"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "проводные наушники"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        else -> t.toString()
    }

    private fun proximity(c: Context, on: Boolean) {
        val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (on) {
            if (prox == null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
                prox = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "heraxos:prox")
            prox?.let { if (!it.isHeld) it.acquire(4 * 60 * 60 * 1000L) }
        } else {
            prox?.let { if (it.isHeld) it.release() }
        }
    }
}
