package io.github.thanhkaiba.kaipass

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.slice.Slice
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.graphics.drawable.Icon
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveInfo
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import java.util.concurrent.atomic.AtomicInteger

/** The fields of one autofill request, passed between the service and KaiPass's activities. */
class FormIds(
    val username: ArrayList<AutofillId>,
    val password: ArrayList<AutofillId>,
    val otp: ArrayList<AutofillId>,
    val target: Target,
    /** The fields for a new password (and its confirmation); empty on a sign-in form. */
    val newPassword: ArrayList<AutofillId> = arrayListOf(),
) {
    val all: List<AutofillId> get() = (username + password + otp).distinct()

    fun put(i: Intent): Intent = i
        .putParcelableArrayListExtra("username", username)
        .putParcelableArrayListExtra("password", password)
        .putParcelableArrayListExtra("otp", otp)
        .putParcelableArrayListExtra("newPassword", newPassword)
        .putExtra("domain", target.domain)
        .putExtra("package", target.packageName)

    companion object {
        fun of(p: Parsed) = FormIds(
            ArrayList(p.idsOf(p.form.username)), ArrayList(p.idsOf(p.form.password)), ArrayList(p.idsOf(p.form.otp)), p.target,
            ArrayList(p.idsOf(p.form.newPassword)),
        )

        @Suppress("DEPRECATION")
        fun from(i: Intent): FormIds? {
            val pkg = i.getStringExtra("package") ?: return null
            fun list(k: String) = i.getParcelableArrayListExtra<AutofillId>(k) ?: arrayListOf()
            return FormIds(list("username"), list("password"), list("otp"), Target(i.getStringExtra("domain"), pkg), list("newPassword"))
        }
    }
}

@SuppressLint("NewApi")
object Responses {
    private val requestCodes = AtomicInteger(1)

    fun remote(c: Context, title: String, subtitle: String): RemoteViews =
        RemoteViews(c.packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.title, title)
            setTextViewText(R.id.subtitle, subtitle)
        }

    /** A suggestion shown in the keyboard (Android 11+), or null when the keyboard cannot show one. */
    fun inline(c: Context, spec: InlinePresentationSpec?, title: String, subtitle: String): InlinePresentation? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || spec == null) return null
        if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
        val attribution = PendingIntent.getActivity(
            c, 0, Intent(c, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val content = InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(title)
            .setStartIcon(Icon.createWithResource(c, R.drawable.ic_autofill))
            .setContentDescription("$title $subtitle")
        if (subtitle.isNotEmpty()) content.setSubtitle(subtitle)
        // getSlice() is how Google's own autofill samples hand the slice over; lint flags it wrongly.
        @SuppressLint("RestrictedApi")
        val slice: Slice = content.build().slice
        return InlinePresentation(slice, spec, false)
    }

    /** An activity the autofill framework starts when the user taps a suggestion. */
    fun sender(c: Context, cls: Class<*>, form: FormIds, extras: (Intent) -> Unit = {}): IntentSender {
        val intent = form.put(Intent(c, cls))
        extras(intent)
        // Mutable: the framework adds the screen's structure to it.
        val flags = PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getActivity(c, requestCodes.getAndIncrement(), intent, flags).intentSender
    }

    fun subtitleOf(e: Entry): String = e.username.ifEmpty { if (e.otp.isNotEmpty()) "Mã OTP" else "" }

    /** Logins that can fill this form: OTP-only forms need an OTP secret, others a password or username. */
    fun usable(entries: List<Entry>, form: FormIds): List<Entry> = entries.filter { e ->
        val wantsLogin = form.username.isNotEmpty() || form.password.isNotEmpty()
        (wantsLogin && (e.password.isNotEmpty() || e.username.isNotEmpty())) || (form.otp.isNotEmpty() && e.otp.isNotEmpty())
    }

    /** One login's values for the form, with a fresh OTP. Null when it has nothing to put there. */
    @Suppress("DEPRECATION")
    fun filled(c: Context, e: Entry, form: FormIds, spec: InlinePresentationSpec? = null): Dataset? {
        val b = Dataset.Builder(remote(c, e.title, subtitleOf(e)))
        inline(c, spec, e.title, subtitleOf(e))?.let { b.setInlinePresentation(it) }
        var any = false
        fun put(ids: List<AutofillId>, value: String) {
            if (value.isEmpty()) return
            for (id in ids) b.setValue(id, AutofillValue.forText(value))
            any = any || ids.isNotEmpty()
        }
        put(form.username, e.username)
        put(form.password, e.password)
        if (form.otp.isNotEmpty()) put(form.otp, Totp.now(e.otp) ?: "")
        return if (any) b.build() else null
    }

    /** A suggestion whose values are built only when tapped (fresh OTP, vault still unlocked). */
    @Suppress("DEPRECATION")
    private fun lazy(c: Context, e: Entry, form: FormIds, spec: InlinePresentationSpec?): Dataset {
        val b = Dataset.Builder(remote(c, e.title, subtitleOf(e)))
        inline(c, spec, e.title, subtitleOf(e))?.let { b.setInlinePresentation(it) }
        for (id in form.all) b.setValue(id, null)
        b.setAuthentication(sender(c, FillActivity::class.java, form) { it.putExtra("entry", e.id) })
        return b.build()
    }

    @Suppress("DEPRECATION")
    private fun search(c: Context, form: FormIds, spec: InlinePresentationSpec?): Dataset {
        val title = c.getString(R.string.search_vault)
        val b = Dataset.Builder(remote(c, title, form.target.label))
        inline(c, spec, title, "")?.let { b.setInlinePresentation(it) }
        for (id in form.all) b.setValue(id, null)
        b.setAuthentication(sender(c, PickActivity::class.java, form))
        return b.build()
    }

    /**
     * "Create a strong password", offered where a new password is asked for. The password is made
     * when the suggestion is tapped (GenerateActivity), which also queues it to be saved: Android
     * itself never offers to save a value that autofill put there.
     */
    @Suppress("DEPRECATION")
    private fun generate(c: Context, form: FormIds, spec: InlinePresentationSpec?): Dataset {
        val title = c.getString(R.string.generate_password)
        val b = Dataset.Builder(remote(c, title, c.getString(R.string.generate_password_sub)))
        inline(c, spec, title, "")?.let { b.setInlinePresentation(it) }
        for (id in form.newPassword) b.setValue(id, null)
        b.setAuthentication(sender(c, GenerateActivity::class.java, form))
        return b.build()
    }

    /** "Unlock KaiPass" as one suggestion among others (the locked answer when a generator is offered too). */
    @Suppress("DEPRECATION")
    private fun unlock(c: Context, form: FormIds, specs: List<InlinePresentationSpec>, maxInline: Int, position: Int): Dataset {
        val title = c.getString(R.string.unlock_to_fill)
        val b = Dataset.Builder(remote(c, title, form.target.label))
        inline(c, specAt(specs, position), title, "")?.let { b.setInlinePresentation(it) }
        for (id in form.all) b.setValue(id, null)
        b.setAuthentication(sender(c, AutofillActivity::class.java, form) { i ->
            if (specs.isNotEmpty()) i.putParcelableArrayListExtra("specs", ArrayList(specs))
            i.putExtra("maxInline", maxInline)
        })
        return b.build()
    }

    fun saveInfo(form: FormIds): SaveInfo? {
        if (form.password.isEmpty()) return null
        val type = SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (form.username.isNotEmpty()) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
        return SaveInfo.Builder(type, form.password.toTypedArray())
            .apply { if (form.username.isNotEmpty()) setOptionalIds(form.username.toTypedArray()) }
            .setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
            .build()
    }

    private fun specAt(specs: List<InlinePresentationSpec>, i: Int) = if (specs.isEmpty()) null else specs[minOf(i, specs.size - 1)]

    /**
     * The answer to a fill request. Locked: one "unlock KaiPass" suggestion. Unlocked: the matching
     * logins and "search KaiPass".
     */
    @Suppress("DEPRECATION")
    fun forRequest(c: Context, form: FormIds, specs: List<InlinePresentationSpec>, maxInline: Int): FillResponse {
        val entries = FillIndex.current()
        val r = FillResponse.Builder()
        val wantsNew = form.newPassword.isNotEmpty()
        if (entries == null && wantsNew) {
            // Locked, on a sign-up form: generating needs no vault, so offer it next to "unlock".
            r.addDataset(generate(c, form, specAt(specs, 0)))
            r.addDataset(unlock(c, form, specs, maxInline, position = 1))
        } else if (entries == null) {
            val title = c.getString(R.string.unlock_to_fill)
            val sender = sender(c, AutofillActivity::class.java, form) { i ->
                if (specs.isNotEmpty()) i.putParcelableArrayListExtra("specs", ArrayList(specs))
                i.putExtra("maxInline", maxInline)
            }
            val ids = form.all.toTypedArray()
            val inline = inline(c, specAt(specs, 0), title, form.target.label)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inline != null) {
                r.setAuthentication(ids, sender, remote(c, title, form.target.label), inline)
            } else {
                r.setAuthentication(ids, sender, remote(c, title, form.target.label))
            }
        } else {
            val matches = usable(Matcher.matches(entries, form.target, Learned.get(c, form.target)), form)
            // On a sign-up form the generator comes first; saved logins for the site follow.
            val first = if (wantsNew) 1 else 0
            if (wantsNew) r.addDataset(generate(c, form, specAt(specs, 0)))
            val room = (if (maxInline > 0) maxOf(maxInline - 1, 0) else 6) - first
            matches.take(maxOf(room, 0)).forEachIndexed { i, e -> r.addDataset(lazy(c, e, form, specAt(specs, i + first))) }
            r.addDataset(search(c, form, specAt(specs, minOf(matches.size, maxOf(room, 0)) + first)))
        }
        saveInfo(form)?.let { r.setSaveInfo(it) }
        return r.build()
    }

    /** After unlocking: the matches with their values, plus "search KaiPass". */
    @Suppress("DEPRECATION")
    fun afterUnlock(c: Context, form: FormIds, specs: List<InlinePresentationSpec>, maxInline: Int): FillResponse {
        val entries = FillIndex.current().orEmpty()
        val matches = usable(Matcher.matches(entries, form.target, Learned.get(c, form.target)), form)
        val room = if (maxInline > 0) maxOf(maxInline - 1, 0) else 6
        val r = FillResponse.Builder()
        var n = 0
        if (form.newPassword.isNotEmpty()) {
            r.addDataset(generate(c, form, specAt(specs, 0)))
            n++
        }
        for (e in matches) {
            if (n >= room) break
            filled(c, e, form, specAt(specs, n))?.let { r.addDataset(it); n++ }
        }
        r.addDataset(search(c, form, specAt(specs, n)))
        saveInfo(form)?.let { r.setSaveInfo(it) }
        return r.build()
    }
}
