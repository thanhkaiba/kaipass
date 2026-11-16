package io.github.thanhkaiba.kaipass

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle

/** Copies text; secrets are marked sensitive (hidden in the clipboard preview) and cleared after a minute. */
object Clip {
    private val handler = Handler(Looper.getMainLooper())

    fun copy(c: Context, text: String, sensitive: Boolean) {
        val cm = c.getSystemService(ClipboardManager::class.java) ?: return
        val clip = ClipData.newPlainText("KaiPass", text)
        if (sensitive) {
            clip.description.extras = PersistableBundle().apply {
                val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
                putBoolean(key, true)
            }
        }
        cm.setPrimaryClip(clip)
        handler.removeCallbacksAndMessages(null)
        if (sensitive) {
            handler.postDelayed({
                // Only clear what we put there.
                val now = try { cm.primaryClip?.getItemAt(0)?.text?.toString() } catch (e: SecurityException) { null }
                if (now == text) {
                    if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }, 60_000)
        }
    }
}
