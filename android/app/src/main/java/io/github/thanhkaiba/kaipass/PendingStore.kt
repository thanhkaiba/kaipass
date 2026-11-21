package io.github.thanhkaiba.kaipass

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A login waiting for the web app to put it in the vault: one the user typed into an app or page,
 * or a password KaiPass generated for a sign-up form.
 */
data class PendingSave(
    val id: String,
    val target: Target,
    val appLabel: String,
    val username: String,
    val password: String,
    /** Wall-clock time it was captured. */
    val at: Long,
    /** KaiPass made this password itself, so losing it would lock the user out. */
    val generated: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("domain", target.domain ?: JSONObject.NULL).put("package", target.packageName)
        .put("appLabel", appLabel).put("username", username).put("password", password).put("at", at).put("generated", generated)

    companion object {
        fun new(target: Target, appLabel: String, username: String, password: String, generated: Boolean, now: Long = System.currentTimeMillis()) =
            PendingSave(UUID.randomUUID().toString(), target, appLabel, username, password, now, generated)

        fun fromJson(o: JSONObject) = PendingSave(
            o.getString("id"),
            Target(if (o.isNull("domain")) null else o.getString("domain"), o.getString("package")),
            o.optString("appLabel"), o.optString("username"), o.getString("password"), o.optLong("at"), o.optBoolean("generated"),
        )
    }
}

/** The waiting list itself, without storage, so its rules can be tested. */
object PendingQueue {
    private const val MAX = 20
    private const val KEEP_TYPED_MS = 24 * 3_600_000L
    private const val KEEP_GENERATED_MS = 30 * 24 * 3_600_000L

    /** Adds a login. The same password for the same place is one entry; the newer username wins. */
    fun add(list: List<PendingSave>, item: PendingSave): List<PendingSave> {
        val same = list.firstOrNull { it.target.key == item.target.key && it.password == item.password }
        val merged = if (same == null) list + item else list.map {
            if (it !== same) it
            else it.copy(username = item.username.ifEmpty { it.username }, appLabel = item.appLabel.ifEmpty { it.appLabel }, generated = it.generated || item.generated)
        }
        return merged.takeLast(MAX)
    }

    /** Typed logins are only worth asking about for a day; generated passwords are kept much longer. */
    fun fresh(list: List<PendingSave>, now: Long): List<PendingSave> =
        list.filter { now - it.at < if (it.generated) KEEP_GENERATED_MS else KEEP_TYPED_MS }
}

/** A small piece of text kept on the phone, encrypted with a key in Android's keystore. */
class SealedText(private val alias: String, private val prefsName: String) {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as SecretKey?)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec)
            generateKey()
        }
    }

    /** The text, or null when there is none or it cannot be read (key lost: app data restored on another phone). */
    fun read(c: Context): String? {
        val prefs = c.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val iv = prefs.getString("iv", null) ?: return null
        val data = prefs.getString("data", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    /** Written before returning, so it is there even if the app is closed right after. */
    fun write(c: Context, text: String?) {
        val prefs = c.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        if (text == null) {
            prefs.edit().clear().commit()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val data = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
            .commit()
    }
}

/**
 * Keeps the waiting list on the phone, encrypted with a key in Android's keystore, so a generated
 * password survives the app being closed before it is saved to the vault.
 */
object PendingStore {
    private val sealed = SealedText("kaipass-pending", "pending")

    private fun read(c: Context): List<PendingSave> = try {
        val json = JSONArray(sealed.read(c) ?: "[]")
        PendingQueue.fresh((0 until json.length()).map { PendingSave.fromJson(json.getJSONObject(it)) }, System.currentTimeMillis())
    } catch (e: Exception) {
        emptyList()
    }

    private fun write(c: Context, list: List<PendingSave>) =
        sealed.write(c, if (list.isEmpty()) null else JSONArray(list.map { it.toJson() }).toString())

    @Synchronized
    fun add(c: Context, item: PendingSave) = write(c, PendingQueue.add(read(c), item))

    /** The oldest login still waiting, or null. */
    @Synchronized
    fun next(c: Context): PendingSave? = read(c).firstOrNull()

    @Synchronized
    fun remove(c: Context, id: String) = write(c, read(c).filter { it.id != id })
}

/**
 * Passkeys made on this phone that the vault does not hold yet. They work for signing in from the
 * moment they are made; the web app moves them into the vault the next time it is unlocked. Never
 * dropped by age: the site already counts on them.
 */
object NewPasskeys {
    private val sealed = SealedText("kaipass-passkeys", "passkeys")

    @Synchronized
    fun all(c: Context): List<NewPasskey> = NewPasskey.list(sealed.read(c))

    @Synchronized
    fun add(c: Context, item: NewPasskey) =
        sealed.write(c, JSONArray((all(c).filter { it.passkey.credentialId != item.passkey.credentialId } + item).map { it.toJson() }).toString())

    @Synchronized
    fun remove(c: Context, credentialIds: Set<String>) {
        val left = all(c).filter { it.passkey.credentialId !in credentialIds }
        sealed.write(c, if (left.isEmpty()) null else JSONArray(left.map { it.toJson() }).toString())
    }
}

/** Which sites the vault has passkeys for, kept while locked so KaiPass can offer to unlock. Names only. */
object PasskeySites {
    private fun prefs(c: Context) = c.getSharedPreferences("passkey-sites", Context.MODE_PRIVATE)

    fun set(c: Context, sites: Set<String>) = prefs(c).edit().putStringSet("sites", sites).apply()

    /** Unknown (KaiPass has not been unlocked on this phone since passkeys arrived) counts as "maybe". */
    fun mayHave(c: Context, rpId: String): Boolean = prefs(c).getStringSet("sites", null)?.contains(rpId) ?: true
}
