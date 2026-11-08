package am.heraxos.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Кнопка «Отклонить» в уведомлении звонка */
class ActionReceiver : BroadcastReceiver() {
    companion object { const val DECLINE = "am.heraxos.app.DECLINE" }
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == DECLINE) CallService.instance?.decline(i.getStringExtra("id") ?: return)
    }
}

/** Запуск службы после перезагрузки телефона и обновления приложения */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED || i.action == Intent.ACTION_MY_PACKAGE_REPLACED) CallService.start(c)
    }
}
