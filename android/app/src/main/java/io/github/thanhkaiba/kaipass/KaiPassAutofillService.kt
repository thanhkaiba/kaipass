package io.github.thanhkaiba.kaipass

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.widget.Toast
import android.app.PendingIntent

/**
 * Android's autofill entry point. Suggests saved logins (and OTP codes) for the app or web page
 * being filled, and hands logins the user typed to the web app to save.
 */
class KaiPassAutofillService : AutofillService() {

    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val parsed = try {
            StructureParser.parse(structure)
        } catch (e: RuntimeException) {
            return callback.onSuccess(null)
        }
        // Never fill KaiPass itself, and nothing when the screen has no login fields.
        if (parsed.packageName == packageName || parsed.form.isEmpty) return callback.onSuccess(null)
        val form = FormIds.of(parsed)
        val inlineRequest = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) request.inlineSuggestionsRequest else null
        val specs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) inlineRequest?.inlinePresentationSpecs.orEmpty() else emptyList()
        val maxInline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) inlineRequest?.maxSuggestionCount ?: 0 else 0
        callback.onSuccess(Responses.forRequest(this, form, specs, maxInline))
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess()
        val parsed = StructureParser.parse(structure)
        val password = parsed.valueOf(parsed.form.password)
        if (password.isEmpty() || parsed.packageName == packageName) return callback.onSuccess()
        // Two-step sign-ins show the username on an earlier screen; an earlier context may have it.
        val username = parsed.valueOf(parsed.form.username).ifEmpty {
            request.fillContexts.dropLast(1).asReversed().firstNotNullOfOrNull { ctx ->
                StructureParser.parse(ctx.structure).let { p -> p.valueOf(p.form.username).takeIf(String::isNotEmpty) }
            } ?: ""
        }
        PendingStore.add(this, PendingSave.new(parsed.target, appLabel(this, parsed.packageName), username, password, generated = false))
        val intent = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_SAVE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val pi = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            callback.onSuccess(pi.intentSender)
        } else {
            callback.onSuccess()
            Toast.makeText(this, R.string.save_later, Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        fun appLabel(c: Context, pkg: String): String = try {
            c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            pkg
        }
    }
}
