package io.github.thanhkaiba.kaipass

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Unlocking with fingerprint, face or the phone's PIN. The master password is encrypted with a key
 * that lives in Android's hardware-backed keystore and can only be used right after the user passes
 * the phone's check. Only the encrypted copy is stored, on this phone, and it stops working if a
 * new fingerprint is added.
 */
object Bio {
    private const val ALIAS = "kaipass-bio"
    private const val PREFS = "bio"

    private fun authenticators() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG

    fun available(c: Context) = BiometricManager.from(c).canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS

    fun enrolled(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains("data")

    fun disable(c: Context) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS)
        } catch (e: Exception) {
            /* nothing to delete */
        }
    }

    private fun newKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec.build())
            generateKey()
        }
    }

    private fun existingKey(): SecretKey? =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(ALIAS, null) as SecretKey?

    private fun prompt(a: FragmentActivity, title: String, cipher: Cipher, ok: (Cipher) -> Unit, fail: (String) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(authenticators())
            .apply { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) setNegativeButtonText(a.getString(R.string.bio_cancel)) }
            .build()
        val p = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher ?: return fail("Không xác thực được")
                ok(c)
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                fail(if (code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED) "Đã huỷ" else message.toString())
            }
        })
        p.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Asks the user to prove it is them (fingerprint, face or the phone's PIN); nothing is decrypted. */
    fun confirm(a: FragmentActivity, title: String, subtitle: String, ok: () -> Unit, fail: (String) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(authenticators())
            .apply { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) setNegativeButtonText(a.getString(R.string.bio_cancel)) }
            .build()
        BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = ok()
            override fun onAuthenticationError(code: Int, message: CharSequence) = fail(message.toString())
        }).authenticate(info)
    }

    fun enroll(a: FragmentActivity, password: String, ok: () -> Unit, fail: (String) -> Unit) {
        disable(a)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newKey()) }
        prompt(a, a.getString(R.string.bio_enroll_title), cipher, { c ->
            val data = c.doFinal(password.toByteArray(Charsets.UTF_8))
            a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
                .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
                .apply()
            ok()
        }, fail)
    }

    /** Shows the phone's prompt and returns the stored master password. */
    fun unlock(a: FragmentActivity, ok: (String) -> Unit, fail: (String) -> Unit) {
        val prefs = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val iv = prefs.getString("iv", null)
        val data = prefs.getString("data", null)
        val key = try { existingKey() } catch (e: Exception) { null }
        if (iv == null || data == null || key == null) return fail("Chưa bật mở khoá bằng vân tay trên máy này")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        } catch (e: KeyPermanentlyInvalidatedException) {
            disable(a)
            return fail("invalidated")
        }
        prompt(a, a.getString(R.string.bio_title), cipher, { c ->
            try {
                ok(String(c.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8))
            } catch (e: Exception) {
                fail("Không đọc được khoá đã lưu, hãy bật lại mở khoá bằng vân tay")
            }
        }, fail)
    }
}
