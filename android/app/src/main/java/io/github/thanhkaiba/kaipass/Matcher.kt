package io.github.thanhkaiba.kaipass

/**
 * A login the autofill service may offer. Published by the web app while the vault is unlocked and
 * kept only in this process's memory. Hosts, sites and labels are worked out by the web app with
 * the Public Suffix List (tldts), so matching here needs no list of its own.
 */
data class Entry(
    val id: String,
    val title: String,
    val username: String,
    val password: String,
    val otp: String,
    /** Saved web addresses' hosts, without "www." (accounts.google.com). */
    val hosts: List<String>,
    /** Their registrable domains (google.com), private suffixes respected (me.github.io). */
    val sites: List<String>,
    /** Their site names without suffix (google, shopee), used to guess an app. */
    val labels: List<String>,
    /** Android package names saved as androidapp:// addresses. */
    val apps: List<String>,
)

/** Where the user is filling: a web page's domain (in a browser) or an app's package. */
data class Target(val domain: String?, val packageName: String) {
    /** Key for remembering which login the user picked here. */
    val key: String get() = if (domain != null) "web:$domain" else "app:$packageName"
    val label: String get() = domain ?: packageName
}

object Matcher {
    /** Browsers fill web pages; without a page domain their package says nothing about the site. */
    val BROWSERS = setOf(
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
        "org.chromium.chrome", "com.google.android.apps.chrome",
        "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
        "com.brave.browser", "com.brave.browser_beta", "com.microsoft.emmx", "com.opera.browser",
        "com.opera.mini.native", "com.opera.gx", "com.sec.android.app.sbrowser", "com.vivaldi.browser",
        "com.duckduckgo.mobile.android", "com.coccoc.trinhduyet", "com.kiwibrowser.browser",
        "com.mi.globalbrowser", "com.UCMobile.intl", "com.yandex.browser",
    )

    private val GENERIC = setOf(
        "com", "org", "net", "io", "vn", "co", "app", "apps", "android", "mobile", "client", "www",
        "prod", "release", "global", "intl", "official", "main", "lite",
    )

    fun normalizeDomain(d: String): String = d.trim().lowercase().trimEnd('.').removePrefix("www.")

    fun score(e: Entry, t: Target, learned: Set<String> = emptySet()): Int {
        var best = if (e.id in learned) 900 else 0
        val d = t.domain
        if (d != null) {
            for (h in e.hosts) {
                best = maxOf(best, when {
                    h == d -> 1000
                    d.endsWith(".$h") -> 600
                    h.endsWith(".$d") -> 400
                    else -> 0
                })
            }
            for (s in e.sites) if (d == s || d.endsWith(".$s")) best = maxOf(best, 100)
            return best
        }
        if (t.packageName in e.apps) return 1000
        if (t.packageName in BROWSERS) return best
        val parts = t.packageName.lowercase().split('.').filter { it.length >= 3 && it !in GENERIC }
        for (l in e.labels) {
            if (l.length < 4) continue
            if (parts.any { it == l || (it.startsWith(l) && it.length - l.length <= 3) }) best = maxOf(best, 50)
        }
        return best
    }

    fun matches(entries: List<Entry>, t: Target, learned: Set<String> = emptySet()): List<Entry> =
        entries.map { it to score(it, t, learned) }
            .filter { it.second > 0 }
            .sortedWith(compareByDescending<Pair<Entry, Int>> { it.second }.thenBy { it.first.title.lowercase() })
            .map { it.first }
}
