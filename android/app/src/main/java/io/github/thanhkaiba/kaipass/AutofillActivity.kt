package io.github.thanhkaiba.kaipass

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.autofill.AutofillManager
import android.widget.inline.InlinePresentationSpec

/**
 * Opened by autofill while the vault is locked: shows KaiPass's lock screen, and as soon as the
 * web app unlocks and publishes its logins, returns the matching suggestions to the app or page.
 */
class AutofillActivity : WebHostActivity() {
    private var form: FormIds? = null
    private var specs: List<InlinePresentationSpec> = emptyList()
    private var maxInline = 0
    private var done = false
    private val onPublish: () -> Unit = { runOnUiThread { finishWithSuggestions() } }

    override fun startPath(): String =
        "/index.html?autofill=" + Uri.encode(FormIds.from(intent)?.target?.label ?: "")

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        form = FormIds.from(intent)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            specs = intent.getParcelableArrayListExtra<InlinePresentationSpec>("specs").orEmpty()
        }
        maxInline = intent.getIntExtra("maxInline", 0)
        super.onCreate(savedInstanceState)
        if (form == null) return finish()
        FillIndex.onPublish(onPublish)
        // Unlocked in the meantime (for example in the main app): answer straight away.
        if (FillIndex.current() != null) finishWithSuggestions()
    }

    override fun onDestroy() {
        FillIndex.offPublish(onPublish)
        super.onDestroy()
    }

    private fun finishWithSuggestions() {
        val f = form ?: return
        if (done || FillIndex.current() == null) return
        done = true
        val response = Responses.afterUnlock(this, f, specs, maxInline)
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response))
        finish()
    }
}
