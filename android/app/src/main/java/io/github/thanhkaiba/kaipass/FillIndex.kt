package io.github.thanhkaiba.kaipass

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * The logins autofill may offer, published by the web app while the vault is unlocked. Lives only
 * in this process's memory and expires after the auto-lock time, like the vault itself.
 */
object FillIndex {
    @Volatile private var entries: List<Entry>? = null
    @Volatile private var lockMillis = 0L
    @Volatile private var deadline = 0L
    private val listeners = mutableSetOf<() -> Unit>()

    fun publish(list: List<Entry>, lockMinutes: Int) {
        entries = list
        lockMillis = lockMinutes * 60_000L
        touch()
        synchronized(listeners) { listeners.toList() }.forEach { it() }
    }

    fun touch() {
        deadline = if (lockMillis > 0) SystemClock.elapsedRealtime() + lockMillis else Long.MAX_VALUE
    }

    fun clear() {
        entries = null
    }

    /** The unlocked list, or null when the vault is locked (or its auto-lock time has passed). */
    fun current(): List<Entry>? {
        val e = entries ?: return null
        if (SystemClock.elapsedRealtime() > deadline) {
            clear()
            return null
        }
        return e
    }

    fun find(id: String): Entry? = current()?.firstOrNull { it.id == id }

    fun onPublish(l: () -> Unit) = synchronized(listeners) { listeners += l }
    fun offPublish(l: () -> Unit) = synchronized(listeners) { listeners -= l }

    fun parse(json: JSONArray): List<Entry> = (0 until json.length()).map { i ->
        val o = json.getJSONObject(i)
        Entry(
            id = o.getString("id"),
            title = o.optString("title"),
            username = o.optString("username"),
            password = o.optString("password"),
            otp = o.optString("otp"),
            hosts = strings(o, "hosts"),
            sites = strings(o, "sites"),
            labels = strings(o, "labels"),
            apps = strings(o, "apps"),
        )
    }

    private fun strings(o: JSONObject, key: String): List<String> {
        val a = o.optJSONArray(key) ?: return emptyList()
        return (0 until a.length()).map { a.getString(it) }
    }
}

/** Which login the user picked for an app or page nothing matched. Ids and names only, no secrets. */
object Learned {
    private fun prefs(c: Context) = c.getSharedPreferences("learned", Context.MODE_PRIVATE)

    fun get(c: Context, t: Target): Set<String> = prefs(c).getStringSet(t.key, emptySet()) ?: emptySet()

    fun add(c: Context, t: Target, id: String) {
        prefs(c).edit().putStringSet(t.key, get(c, t) + id).apply()
    }
}
