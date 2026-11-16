package io.github.thanhkaiba.kaipass

import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** The KaiPass app. Also receives logins to save from autofill, and shared KaiPass links. */
class MainActivity : WebHostActivity() {
    companion object {
        const val ACTION_SAVE = "io.github.thanhkaiba.kaipass.SAVE"
    }

    private var openedForSave = false

    override fun startPath(): String = "/index.html" + (shareFragment(intent)?.let { "#$it" } ?: "")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openedForSave = intent?.action == ACTION_SAVE
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == ACTION_SAVE) {
            openedForSave = true
            emit("pendingSave")
        }
        shareFragment(intent)?.let { web.loadUrl("$ORIGIN/index.html#$it") }
    }

    override fun onResume() {
        super.onResume()
        emit("resume")
    }

    /** Back to the app the login came from once it is saved (or declined). */
    override fun onSaveDone() {
        if (openedForSave) {
            openedForSave = false
            moveTaskToBack(true)
        }
    }

    /** The "#share=…" part of a KaiPass link shared to this app. */
    private fun shareFragment(i: Intent?): String? {
        if (i?.action != Intent.ACTION_SEND) return null
        val text = i.getStringExtra(Intent.EXTRA_TEXT) ?: return null
        val link = Regex("https?://\\S+#share=\\S+").find(text)?.value ?: return null
        return Uri.parse(link).encodedFragment?.takeIf { it.startsWith("share=") }
    }
}
