package am.heraxos.app

import android.content.Context
import android.content.SharedPreferences

object Prefs {
    fun p(c: Context): SharedPreferences = c.getSharedPreferences("heraxos", Context.MODE_PRIVATE)
    fun token(c: Context): String? = p(c).getString("token", null)
    fun login(c: Context): String? = p(c).getString("login", null)
    fun save(c: Context, token: String, login: String) { p(c).edit().putString("token", token).putString("login", login).apply() }
    fun clear(c: Context) { p(c).edit().remove("token").remove("login").apply() }
}
