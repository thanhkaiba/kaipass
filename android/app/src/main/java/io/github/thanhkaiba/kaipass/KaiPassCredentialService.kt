package io.github.thanhkaiba.kaipass

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry

/**
 * Android's passkey entry point (Android 14+). An app, a browser, or Google Play services on behalf
 * of another device (the QR code flow) asks through Android; this lists KaiPass's passkeys for the
 * site, and offers KaiPass as a place to keep a new one. The signing itself happens in
 * PasskeyActivity, after the phone's fingerprint check.
 */
@RequiresApi(34)
class KaiPassCredentialService : CredentialProviderService() {

    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        callback.onResult(PasskeyOffers.forRequest(this, request))
    }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        val b = BeginCreateCredentialResponse.Builder()
        val ask = (request as? BeginCreatePublicKeyCredentialRequest)?.let { PasskeyCreate.parse(it.requestJson) }
        if (ask != null && ask.supported && ask.rpId.isNotEmpty()) {
            val intent = Intent(this, PasskeyActivity::class.java).setAction(PasskeyActivity.ACTION_CREATE).setData(Uri.parse("kaipass://passkey/new"))
            b.addCreateEntry(CreateEntry.Builder(getString(R.string.passkey_vault), PasskeyOffers.pending(this, intent)).build())
        }
        callback.onResult(b.build())
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        // KaiPass keeps no "signed in to this app" state to forget.
        callback.onResult(null)
    }
}

/** A passkey KaiPass can use right now, and the login it sits on. */
data class HeldPasskey(val passkey: Passkey, val title: String, val entryId: String?)

@RequiresApi(34)
object PasskeyOffers {
    /** The unlocked vault's passkeys, and the ones made on this phone that are not in the vault yet. */
    fun held(c: Context): List<HeldPasskey> =
        FillIndex.current().orEmpty().mapNotNull { e -> e.passkey?.let { HeldPasskey(it, e.title, e.id) } } +
            NewPasskeys.all(c).map { HeldPasskey(it.passkey, it.rpName, null) }

    fun pending(c: Context, intent: Intent): PendingIntent =
        // Mutable: Android adds the request to it when the user picks the entry.
        PendingIntent.getActivity(c, 0, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun forRequest(c: Context, request: BeginGetCredentialRequest?): BeginGetCredentialResponse {
        val b = BeginGetCredentialResponse.Builder()
        val locked = FillIndex.current() == null
        val held = held(c)
        var offerUnlock = false
        for (option in request?.beginGetCredentialOptions.orEmpty()) {
            if (option !is BeginGetPublicKeyCredentialOption) continue
            val ask = PasskeyGet.parse(option.requestJson) ?: continue
            if (ask.rpId.isEmpty()) continue
            val found = PasskeyPick.matching(held.map { it.passkey }, ask.rpId, ask.allow)
            for (p in found) {
                val h = held.first { it.passkey.credentialId == p.credentialId }
                val intent = Intent(c, PasskeyActivity::class.java).setAction(PasskeyActivity.ACTION_GET)
                    .setData(Uri.parse("kaipass://passkey/use/${p.credentialId}"))
                    .putExtra(PasskeyActivity.EXTRA_CREDENTIAL, p.credentialId)
                val entry = PublicKeyCredentialEntry.Builder(c, p.username.ifEmpty { h.title.ifEmpty { p.rpId } }, pending(c, intent), option)
                if (h.title.isNotEmpty() && p.username.isNotEmpty()) entry.setDisplayName(h.title)
                b.addCredentialEntry(entry.build())
            }
            // Locked, and the vault has passkeys for this site that are not on the list yet.
            if (locked && PasskeySites.mayHave(c, ask.rpId) && (ask.allow.isEmpty() || found.size < ask.allow.size)) offerUnlock = true
        }
        if (offerUnlock) {
            val intent = Intent(c, PasskeyUnlockActivity::class.java).setData(Uri.parse("kaipass://passkey/unlock"))
            b.addAuthenticationAction(AuthenticationAction(c.getString(R.string.passkey_unlock), pending(c, intent)))
        }
        return b.build()
    }
}
