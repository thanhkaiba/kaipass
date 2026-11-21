package io.github.thanhkaiba.kaipass

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * A passkey: a P-256 key pair made for one site. The same five values the web app keeps on a login
 * (in KeePassXC's fields), so a passkey made here works in the browser extension and the reverse.
 */
data class Passkey(
    /** base64url */
    val credentialId: String,
    /** PKCS#8, PEM */
    val privateKeyPem: String,
    /** The site it belongs to, e.g. "github.com". */
    val rpId: String,
    val username: String,
    /** The site's id for the user, base64url. */
    val userHandle: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("credentialId", credentialId).put("privateKeyPem", privateKeyPem).put("rpId", rpId)
        .put("username", username).put("userHandle", userHandle)

    companion object {
        fun fromJson(o: JSONObject?): Passkey? {
            o ?: return null
            val id = o.optString("credentialId")
            val pem = o.optString("privateKeyPem")
            val rp = o.optString("rpId")
            if (id.isEmpty() || pem.isEmpty() || rp.isEmpty()) return null
            return Passkey(B64.normal(id), pem, rp.lowercase(), o.optString("username"), o.optString("userHandle"))
        }
    }
}

object B64 {
    fun url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    /** Accepts base64url and plain base64, padded or not. */
    fun bytes(s: String): ByteArray = Base64.getUrlDecoder().decode(normal(s))

    /** One spelling for comparing ids: base64url without padding. */
    fun normal(s: String): String = s.trim().replace('+', '-').replace('/', '_').trimEnd('=')
}

/** The little CBOR WebAuthn needs: integers, byte and text strings, lists and maps (keys in the order given). */
object Cbor {
    fun encode(v: Any): ByteArray = ByteArrayOutputStream().also { write(it, v) }.toByteArray()

    private fun head(out: ByteArrayOutputStream, major: Int, n: Long) {
        val m = major shl 5
        when {
            n < 24 -> out.write(m or n.toInt())
            n < 0x100 -> { out.write(m or 24); out.write(n.toInt()) }
            n < 0x10000 -> { out.write(m or 25); out.write((n shr 8).toInt()); out.write((n and 0xff).toInt()) }
            else -> { out.write(m or 26); for (s in intArrayOf(24, 16, 8, 0)) out.write(((n shr s) and 0xff).toInt()) }
        }
    }

    private fun write(out: ByteArrayOutputStream, v: Any) {
        when (v) {
            is Int -> if (v >= 0) head(out, 0, v.toLong()) else head(out, 1, -1L - v)
            is ByteArray -> { head(out, 2, v.size.toLong()); out.write(v) }
            is String -> { val b = v.toByteArray(Charsets.UTF_8); head(out, 3, b.size.toLong()); out.write(b) }
            is List<*> -> { head(out, 4, v.size.toLong()); v.forEach { write(out, it!!) } }
            is Map<*, *> -> { head(out, 5, v.size.toLong()); v.forEach { (k, x) -> write(out, k!!); write(out, x!!) } }
            else -> throw IllegalArgumentException("CBOR: ${v::class}")
        }
    }
}

/** What a site (through a browser or an app) asks when signing in with a passkey. */
data class PasskeyGet(val rpId: String, val challenge: String, val allow: List<String>) {
    companion object {
        fun parse(json: String): PasskeyGet? = try {
            val o = JSONObject(json)
            PasskeyGet(o.optString("rpId").lowercase(), o.getString("challenge"), ids(o.optJSONArray("allowCredentials")))
        } catch (e: Exception) {
            null
        }

        internal fun ids(a: JSONArray?): List<String> =
            (0 until (a?.length() ?: 0)).mapNotNull { i -> a!!.optJSONObject(i)?.optString("id")?.takeIf(String::isNotEmpty)?.let(B64::normal) }
    }
}

/** What a site asks when it wants a new passkey. */
data class PasskeyCreate(
    val rpId: String,
    val rpName: String,
    /** base64url */
    val userId: String,
    val userName: String,
    val displayName: String,
    val challenge: String,
    /** COSE algorithm numbers the site accepts; empty when it did not say. */
    val algs: List<Int>,
    val exclude: List<String>,
) {
    /** KaiPass makes ES256 keys. */
    val supported: Boolean get() = algs.isEmpty() || -7 in algs

    companion object {
        fun parse(json: String): PasskeyCreate? = try {
            val o = JSONObject(json)
            val rp = o.getJSONObject("rp")
            val user = o.getJSONObject("user")
            val params = o.optJSONArray("pubKeyCredParams")
            PasskeyCreate(
                rpId = rp.optString("id").lowercase(),
                rpName = rp.optString("name"),
                userId = B64.normal(user.getString("id")),
                userName = user.optString("name"),
                displayName = user.optString("displayName"),
                challenge = o.getString("challenge"),
                algs = (0 until (params?.length() ?: 0)).mapNotNull { i -> params!!.optJSONObject(i)?.takeIf { it.has("alg") }?.optInt("alg") },
                exclude = PasskeyGet.ids(o.optJSONArray("excludeCredentials")),
            )
        } catch (e: Exception) {
            null
        }
    }
}

/** KaiPass as a WebAuthn authenticator: the key work and the byte formats, nothing Android-specific. */
object WebAuthn {
    /** Identifies KaiPass as the authenticator model ("kaipass-passkeys" in bytes), as in the web app. */
    val AAGUID: ByteArray = "kaipass-passkeys".toByteArray(Charsets.US_ASCII)

    // User present, user verified, backup eligible and backed up (the passkey syncs with the vault).
    private const val FLAGS_GET = 0x01 or 0x04 or 0x08 or 0x10
    private const val FLAGS_CREATE = FLAGS_GET or 0x40

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun authData(rpId: String, flags: Int, attested: ByteArray = ByteArray(0)): ByteArray =
        sha256(rpId.toByteArray(Charsets.UTF_8)) + byteArrayOf(flags.toByte()) + ByteArray(4) + attested

    /** A coordinate as exactly 32 bytes. */
    private fun fixed(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun pem(der: ByteArray): String =
        "-----BEGIN PRIVATE KEY-----\n" + Base64.getEncoder().encodeToString(der).chunked(64).joinToString("\n") + "\n-----END PRIVATE KEY-----"

    private fun der(pem: String): ByteArray =
        Base64.getDecoder().decode(pem.replace(Regex("-----[^-]+-----"), "").replace(Regex("\\s+"), ""))

    class Created(
        val passkey: Passkey,
        val authenticatorData: ByteArray,
        val attestationObject: ByteArray,
        /** SubjectPublicKeyInfo */
        val publicKey: ByteArray,
    )

    fun create(rpId: String, userId: String, userName: String, random: SecureRandom = SecureRandom()): Created {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }.generateKeyPair()
        val id = ByteArray(32).also(random::nextBytes)
        val point = (pair.public as ECPublicKey).w
        val cose = Cbor.encode(linkedMapOf<Any, Any>(1 to 2, 3 to -7, -1 to 1, -2 to fixed(point.affineX), -3 to fixed(point.affineY)))
        val auth = authData(rpId, FLAGS_CREATE, AAGUID + byteArrayOf((id.size shr 8).toByte(), id.size.toByte()) + id + cose)
        val attestation = Cbor.encode(linkedMapOf<Any, Any>("fmt" to "none", "attStmt" to emptyMap<Any, Any>(), "authData" to auth))
        return Created(Passkey(B64.url(id), pem(pair.private.encoded), rpId, userName, userId), auth, attestation, pair.public.encoded)
    }

    class Signed(val authenticatorData: ByteArray, val signature: ByteArray)

    /** Signs a sign-in: the authenticator data followed by the hash of the client data. */
    fun sign(passkey: Passkey, clientDataHash: ByteArray): Signed {
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der(passkey.privateKeyPem)))
        val auth = authData(passkey.rpId, FLAGS_GET)
        val sig = Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(auth)
            update(clientDataHash)
            sign()
        }
        return Signed(auth, sig)
    }

    /**
     * The client data KaiPass writes itself when the caller is an app. (A browser sends the hash of
     * its own client data, and puts its own in the answer.)
     */
    fun clientData(type: String, challenge: String, origin: String, packageName: String?): ByteArray {
        // Written by hand: the standard fixes the order of these fields, and sites compare the
        // origin as plain text (no "\/").
        val q = { v: String -> JSONObject.quote(v).replace("\\/", "/") }
        val app = if (packageName != null) ""","androidPackageName":${q(packageName)}""" else ""
        return """{"type":${q(type)},"challenge":${q(challenge)},"origin":${q(origin)},"crossOrigin":false$app}""".toByteArray(Charsets.UTF_8)
    }

    fun registrationJson(c: Created, clientData: ByteArray): String = JSONObject()
        .put("id", c.passkey.credentialId).put("rawId", c.passkey.credentialId).put("type", "public-key")
        .put("authenticatorAttachment", "platform")
        .put("response", JSONObject()
            .put("clientDataJSON", B64.url(clientData))
            .put("attestationObject", B64.url(c.attestationObject))
            .put("authenticatorData", B64.url(c.authenticatorData))
            .put("publicKey", B64.url(c.publicKey))
            .put("publicKeyAlgorithm", -7)
            .put("transports", JSONArray().put("internal").put("hybrid")))
        .put("clientExtensionResults", JSONObject().put("credProps", JSONObject().put("rk", true)))
        .toString()

    fun assertionJson(p: Passkey, s: Signed, clientData: ByteArray): String {
        val response = JSONObject()
            .put("clientDataJSON", B64.url(clientData))
            .put("authenticatorData", B64.url(s.authenticatorData))
            .put("signature", B64.url(s.signature))
        // Passkeys brought in from elsewhere may not record the site's user id.
        if (p.userHandle.isNotEmpty()) response.put("userHandle", B64.normal(p.userHandle))
        return JSONObject()
            .put("id", p.credentialId).put("rawId", p.credentialId).put("type", "public-key")
            .put("authenticatorAttachment", "platform")
            .put("response", response)
            .put("clientExtensionResults", JSONObject())
            .toString()
    }

    /**
     * Whether a page at `origin` may use passkeys of `rpId`: an https page on that host or below
     * it. (Browsers check this too, with the Public Suffix List, before they ask.)
     */
    fun originAllows(origin: String, rpId: String): Boolean {
        val m = Regex("^https://([^/:?#]+)(:\\d+)?/?$").find(origin.lowercase()) ?: return false
        val host = m.groupValues[1]
        return rpId.contains('.') && (host == rpId || host.endsWith(".$rpId"))
    }

    /** How an Android app is named as the origin of a passkey request. */
    fun appOrigin(certificate: ByteArray): String = "android:apk-key-hash:" + B64.url(sha256(certificate))

    fun fingerprint(certificate: ByteArray): String = sha256(certificate).joinToString(":") { "%02X".format(it) }
}

/**
 * Digital Asset Links: a site lists, at /.well-known/assetlinks.json, the Android apps that may
 * sign in with its accounts. An app that is not listed gets no passkey of that site.
 */
object AssetLinks {
    private val RELATIONS = setOf("delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls")

    fun allows(json: String, packageName: String, fingerprint: String): Boolean = try {
        val list = JSONArray(json)
        (0 until list.length()).any { i ->
            val s = list.optJSONObject(i) ?: return@any false
            val target = s.optJSONObject("target") ?: return@any false
            val relations = s.optJSONArray("relation")
            val prints = target.optJSONArray("sha256_cert_fingerprints")
            target.optString("namespace") == "android_app" &&
                target.optString("package_name") == packageName &&
                (0 until (relations?.length() ?: 0)).any { relations!!.optString(it) in RELATIONS } &&
                (0 until (prints?.length() ?: 0)).any { prints!!.optString(it).equals(fingerprint, ignoreCase = true) }
        }
    } catch (e: Exception) {
        false
    }
}

/** A passkey made on this phone, waiting for the web app to put it in the vault. */
data class NewPasskey(
    val passkey: Passkey,
    /** The site's own name for itself, for the login's title. */
    val rpName: String,
    /** Where it was made: "https://site" or "androidapp://package". */
    val origin: String,
    val at: Long,
) {
    fun toJson(): JSONObject = JSONObject().put("passkey", passkey.toJson()).put("rpName", rpName).put("origin", origin).put("at", at)

    companion object {
        fun fromJson(o: JSONObject): NewPasskey? =
            Passkey.fromJson(o.optJSONObject("passkey"))?.let { NewPasskey(it, o.optString("rpName"), o.optString("origin"), o.optLong("at")) }

        fun list(json: String?): List<NewPasskey> = try {
            val a = JSONArray(json ?: "[]")
            (0 until a.length()).mapNotNull { fromJson(a.getJSONObject(it)) }
        } catch (e: Exception) {
            emptyList()
        }
    }
}

/** Choosing which passkeys answer a request. */
object PasskeyPick {
    /** Passkeys of `rpId`, limited to the ones the site named when it named any; no id twice. */
    fun matching(all: List<Passkey>, rpId: String, allow: List<String>): List<Passkey> =
        all.filter { it.rpId == rpId && (allow.isEmpty() || it.credentialId in allow) }.distinctBy { it.credentialId }
}
