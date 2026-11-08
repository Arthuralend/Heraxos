package am.heraxos.app

import android.app.Activity
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager

/**
 * Куда идёт звук звонка: «earpiece» — разговорный динамик (у уха, экран гаснет при поднесении),
 * «speaker» — громкая связь, «off» — звонок закончен. Если подключена гарнитура/Bluetooth — звук в неё.
 */
object AudioRoute {
    private var prox: PowerManager.WakeLock? = null

    fun set(a: Activity, route: String) {
        val am = a.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (route == "off") {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
            am.mode = AudioManager.MODE_NORMAL
            a.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
            proximity(a, false)
            return
        }
        am.mode = AudioManager.MODE_IN_COMMUNICATION
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
            if (dev != null) am.setCommunicationDevice(dev)
        } else {
            @Suppress("DEPRECATION")
            headset = am.isWiredHeadsetOn || am.isBluetoothScoOn
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = speaker }
        }
        proximity(a, !speaker && !headset)
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
