package io.github.thanhkaiba.kaipass

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.annotation.RequiresApi
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.PendingIntentHandler

/**
 * Opened from Android's passkey sheet while the vault is locked: shows KaiPass's lock screen, and as
 * soon as the web app unlocks and publishes the vault's logins, returns the site's passkeys.
 */
@RequiresApi(34)
class PasskeyUnlockActivity : WebHostActivity() {
    private var request: BeginGetCredentialRequest? = null
    private var done = false
    private val onPublish: () -> Unit = {
        runOnUiThread {
            // The user has just proved who they are; the passkey they pick next needs no second check.
            FillIndex.unlockedForPasskeyAt = SystemClock.elapsedRealtime()
            finishWithPasskeys()
        }
    }

    private fun site(): String =
        request?.beginGetCredentialOptions.orEmpty().filterIsInstance<BeginGetPublicKeyCredentialOption>()
            .firstNotNullOfOrNull { PasskeyGet.parse(it.requestJson)?.rpId?.takeIf(String::isNotEmpty) } ?: "passkey"

    override fun startPath(): String = "/index.html?for=passkey&autofill=" + Uri.encode(site())

    override fun onCreate(savedInstanceState: Bundle?) {
        request = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent)
        super.onCreate(savedInstanceState)
        if (request == null) return finish()
        FillIndex.onPublish(onPublish)
        if (FillIndex.current() != null) finishWithPasskeys()
    }

    override fun onDestroy() {
        FillIndex.offPublish(onPublish)
        super.onDestroy()
    }

    private fun finishWithPasskeys() {
        if (done || FillIndex.current() == null) return
        done = true
        val result = Intent()
        PendingIntentHandler.setBeginGetCredentialResponse(result, PasskeyOffers.forRequest(this, request))
        setResult(RESULT_OK, result)
        finish()
    }
}
