package io.github.thanhkaiba.kaipass

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.autofill.AutofillManager
import android.widget.Toast

/**
 * Started, invisibly, when the user taps a login suggestion: builds its values now, so the OTP is
 * fresh. When the form has no OTP field but the login has one, the code is copied instead.
 */
class FillActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val form = FormIds.from(intent)
        val entry = intent.getStringExtra("entry")?.let(FillIndex::find)
        if (form == null || entry == null) {
            Toast.makeText(this, R.string.locked_again, Toast.LENGTH_LONG).show()
            setResult(RESULT_CANCELED)
            return finish()
        }
        FillIndex.touch()
        Usage.used(this, entry.id)
        val dataset = Responses.filled(this, entry, form)
        if (dataset == null) {
            setResult(RESULT_CANCELED)
            return finish()
        }
        copyOtpIfNeeded(this, entry, form)
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
        finish()
    }

    companion object {
        fun copyOtpIfNeeded(a: Activity, entry: Entry, form: FormIds) {
            if (form.otp.isNotEmpty() || form.password.isEmpty()) return
            val code = Totp.now(entry.otp) ?: return
            Clip.copy(a, code, sensitive = true)
            Toast.makeText(a, R.string.otp_copied, Toast.LENGTH_SHORT).show()
        }
    }
}
