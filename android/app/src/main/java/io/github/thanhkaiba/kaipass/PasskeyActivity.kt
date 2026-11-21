package io.github.thanhkaiba.kaipass

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotSupportedError
import androidx.credentials.exceptions.domerrors.SecurityError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderCreateCredentialRequest
import androidx.credentials.provider.ProviderGetCredentialRequest
import androidx.fragment.app.FragmentActivity
import java.net.HttpURLConnection
import java.net.URL

/**
 * Started when the user picks KaiPass on Android's passkey sheet. Checks who is asking, shows the
 * phone's fingerprint prompt, then signs the site's challenge with a passkey, or makes a new
 * passkey. Has no screen of its own.
 */
@RequiresApi(34)
class PasskeyActivity : FragmentActivity() {
    companion object {
        const val ACTION_GET = "io.github.thanhkaiba.kaipass.PASSKEY_GET"
        const val ACTION_CREATE = "io.github.thanhkaiba.kaipass.PASSKEY_CREATE"
        const val EXTRA_CREDENTIAL = "cred"

        /** After unlocking the vault for this very request, the user is not asked to verify again. */
        private const val JUST_UNLOCKED_MS = 30_000L
    }

    /** Who is asking, as the site will see it. */
    private class Caller(val origin: String, val packageName: String?)

    private sealed class Check {
        class Ok(val caller: Caller) : Check()
        class Refused(val message: String) : Check()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val get = if (intent.action == ACTION_GET) PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) else null
        val create = if (intent.action == ACTION_CREATE) PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) else null
        try {
            when {
                get != null -> signIn(get)
                create != null -> register(create)
                else -> finish()
            }
        } catch (e: Exception) {
            if (create != null) failCreate(CreateCredentialUnknownException(e.message)) else failGet(GetCredentialUnknownException(e.message))
        }
    }

    // ---- signing in ----

    private fun signIn(request: ProviderGetCredentialRequest) {
        val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull()
            ?: return failGet(GetCredentialUnknownException("no passkey request"))
        val ask = PasskeyGet.parse(option.requestJson) ?: return failGet(GetCredentialUnknownException("bad request"))
        val id = intent.getStringExtra(EXTRA_CREDENTIAL)
        val held = PasskeyOffers.held(this).firstOrNull { it.passkey.credentialId == id && it.passkey.rpId == ask.rpId }
        if (held == null || (ask.allow.isNotEmpty() && held.passkey.credentialId !in ask.allow)) {
            // The vault locked itself between the list and the tap.
            Toast.makeText(this, R.string.passkey_locked, Toast.LENGTH_LONG).show()
            return failGet(NoCredentialException(getString(R.string.passkey_locked)))
        }
        whoAsks(request.callingAppInfo, ask.rpId) { check ->
            val who = when (check) {
                is Check.Refused -> return@whoAsks failGet(GetPublicKeyCredentialDomException(SecurityError(), check.message), check.message)
                is Check.Ok -> check.caller
            }
            verify(getString(R.string.passkey_use_title), listOf(held.passkey.username, ask.rpId).filter(String::isNotEmpty).joinToString(" · ")) {
                val client = WebAuthn.clientData("webauthn.get", ask.challenge, who.origin, who.packageName)
                // A browser sends the hash of its own client data; an app leaves that to KaiPass.
                val signed = WebAuthn.sign(held.passkey, option.clientDataHash ?: WebAuthn.sha256(client))
                FillIndex.touch()
                held.entryId?.let { Usage.used(this, it) }
                val result = Intent()
                PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(PublicKeyCredential(WebAuthn.assertionJson(held.passkey, signed, client))))
                setResult(RESULT_OK, result)
                finish()
            }
        }
    }

    private fun failGet(e: GetCredentialException, toast: String? = null) {
        if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_LONG).show()
        val result = Intent()
        PendingIntentHandler.setGetCredentialException(result, e)
        setResult(RESULT_OK, result)
        finish()
    }

    // ---- a new passkey ----

    private fun register(request: ProviderCreateCredentialRequest) {
        val call = request.callingRequest as? CreatePublicKeyCredentialRequest ?: return failCreate(CreateCredentialUnknownException("no passkey request"))
        val ask = PasskeyCreate.parse(call.requestJson) ?: return failCreate(CreateCredentialUnknownException("bad request"))
        if (!ask.supported || ask.rpId.isEmpty()) {
            return failCreate(CreatePublicKeyCredentialDomException(NotSupportedError(), getString(R.string.passkey_unsupported)), getString(R.string.passkey_unsupported))
        }
        if (PasskeyOffers.held(this).any { it.passkey.rpId == ask.rpId && it.passkey.credentialId in ask.exclude }) {
            return failCreate(CreatePublicKeyCredentialDomException(InvalidStateError(), getString(R.string.passkey_exists)), getString(R.string.passkey_exists))
        }
        whoAsks(request.callingAppInfo, ask.rpId) { check ->
            val who = when (check) {
                is Check.Refused -> return@whoAsks failCreate(CreatePublicKeyCredentialDomException(SecurityError(), check.message), check.message)
                is Check.Ok -> check.caller
            }
            val name = ask.userName.ifEmpty { ask.displayName }
            verify(getString(R.string.passkey_save_title), listOf(name, ask.rpId).filter(String::isNotEmpty).joinToString(" · ")) {
                val made = WebAuthn.create(ask.rpId, ask.userId, name)
                // Kept on the phone first, so it exists before the site hears about it.
                NewPasskeys.add(this, NewPasskey(made.passkey, ask.rpName, if (who.packageName == null) who.origin else "https://${ask.rpId}", System.currentTimeMillis()))
                val client = WebAuthn.clientData("webauthn.create", ask.challenge, who.origin, who.packageName)
                val result = Intent()
                PendingIntentHandler.setCreateCredentialResponse(result, CreatePublicKeyCredentialResponse(WebAuthn.registrationJson(made, client)))
                setResult(RESULT_OK, result)
                Toast.makeText(this, R.string.passkey_saved, Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    private fun failCreate(e: CreateCredentialException, toast: String? = null) {
        if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_LONG).show()
        val result = Intent()
        PendingIntentHandler.setCreateCredentialException(result, e)
        setResult(RESULT_OK, result)
        finish()
    }

    // ---- who is asking, and is it really the user ----

    /**
     * A browser (or Google Play services, for a sign-in on another device) names the web page it
     * asks for; only the browsers on Google's published list may do that. Any other app asks for
     * itself, and must be listed by the site in its Digital Asset Links.
     */
    private fun whoAsks(app: CallingAppInfo, rpId: String, then: (Check) -> Unit) {
        if (!Regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$").matches(rpId)) return then(Check.Refused(getString(R.string.passkey_unsupported)))
        if (app.isOriginPopulated()) {
            val origin = try {
                app.getOrigin(resources.openRawResource(R.raw.passkey_browsers).bufferedReader().use { it.readText() })
            } catch (e: RuntimeException) {
                null
            }
            return then(
                if (origin != null && WebAuthn.originAllows(origin, rpId)) Check.Ok(Caller(origin.trimEnd('/'), null))
                else Check.Refused(getString(R.string.passkey_browser_refused)),
            )
        }
        val signers = app.signingInfo.apkContentsSigners
        if (signers.size != 1) return then(Check.Refused(getString(R.string.passkey_app_refused, rpId)))
        val certificate = signers[0].toByteArray()
        Thread {
            val links = fetchAssetLinks(rpId)
            val check = when {
                links == null -> Check.Refused(getString(R.string.passkey_app_unchecked, rpId))
                AssetLinks.allows(links, app.packageName, WebAuthn.fingerprint(certificate)) -> Check.Ok(Caller(WebAuthn.appOrigin(certificate), app.packageName))
                else -> Check.Refused(getString(R.string.passkey_app_refused, rpId))
            }
            runOnUiThread { if (!isFinishing && !isDestroyed) then(check) }
        }.start()
    }

    private fun fetchAssetLinks(rpId: String): String? = try {
        val c = URL("https://$rpId/.well-known/assetlinks.json").openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.connectTimeout = 6000
        c.readTimeout = 6000
        try {
            if (c.responseCode != 200) null
            else c.inputStream.use { s ->
                val buf = ByteArray(512 * 1024)
                var n = 0
                while (n < buf.size) {
                    val r = s.read(buf, n, buf.size - n)
                    if (r < 0) break
                    n += r
                }
                String(buf, 0, n, Charsets.UTF_8)
            }
        } finally {
            c.disconnect()
        }
    } catch (e: Exception) {
        null
    }

    /** The phone's fingerprint, face or PIN check, unless the user unlocked the vault for this a moment ago. */
    private fun verify(title: String, subtitle: String, then: () -> Unit) {
        val unlockedAt = FillIndex.unlockedForPasskeyAt
        val justUnlocked = unlockedAt != 0L && SystemClock.elapsedRealtime() - unlockedAt < JUST_UNLOCKED_MS
        FillIndex.unlockedForPasskeyAt = 0L
        if (justUnlocked || !Bio.available(this)) return then()
        Bio.confirm(this, title, subtitle, {
            try {
                then()
            } catch (e: Exception) {
                // For example a key in the vault that cannot be read.
                Toast.makeText(this, R.string.passkey_failed, Toast.LENGTH_LONG).show()
                setResult(RESULT_CANCELED)
                finish()
            }
        }) {
            // Cancelled: back to Android's sheet, where the user can pick something else.
            setResult(RESULT_CANCELED)
            finish()
        }
    }
}
