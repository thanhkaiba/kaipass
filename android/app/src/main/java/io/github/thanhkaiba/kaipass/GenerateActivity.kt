package io.github.thanhkaiba.kaipass

import android.app.Activity
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.Toast

/**
 * Started, invisibly, when the user taps "create a strong password" on a sign-up or
 * change-password form. It makes the password, puts it in the new-password fields, and queues the
 * login to be saved: KaiPass asks to save it the next time it is opened, so it cannot be lost.
 */
class GenerateActivity : Activity() {
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val form = FormIds.from(intent)
        if (form == null || form.newPassword.isEmpty()) {
            setResult(RESULT_CANCELED)
            return finish()
        }
        val password = PasswordGen.generate()
        // Whatever username is already typed on the form goes with it.
        val structure: AssistStructure? = intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        val username = try {
            structure?.let(StructureParser::parse)?.let { it.valueOf(it.form.username) } ?: ""
        } catch (e: RuntimeException) {
            ""
        }
        PendingStore.add(this, PendingSave.new(form.target, KaiPassAutofillService.appLabel(this, form.target.packageName), username, password, generated = true))

        val dataset = Dataset.Builder(Responses.remote(this, getString(R.string.generate_password), ""))
        for (id in form.newPassword) dataset.setValue(id, AutofillValue.forText(password))
        Toast.makeText(this, R.string.generated_toast, Toast.LENGTH_LONG).show()
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset.build()))
        finish()
    }
}
