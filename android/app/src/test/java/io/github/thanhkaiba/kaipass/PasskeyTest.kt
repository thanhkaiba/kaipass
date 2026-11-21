package io.github.thanhkaiba.kaipass

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class PasskeyTest {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    // A key pair made by the web app's side (WebCrypto), as it sits in the vault.
    private val webPem = "-----BEGIN PRIVATE KEY-----\n" +
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0LdOClc0E04x1KQN\n3H/41Is6PQEGPNvMaMyRKuX1HXOhRANCAASm7VBhJaKvqS3CIZi+UBvYJ9bDv/v7\nuGVd0PshpITwIQmoWF1xMQhI8ZMOo96FRqgZoICM3k3HP8CIooR6be3O\n" +
        "-----END PRIVATE KEY-----"
    private val webSpki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpu1QYSWir6ktwiGYvlAb2CfWw7/7+7hlXdD7IaSE8CEJqFhdcTEISPGTDqPehUaoGaCAjN5Nxz/AiKKEem3tzg=="

    private fun verifies(spki: ByteArray, signed: WebAuthn.Signed, clientHash: ByteArray): Boolean =
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)))
            update(signed.authenticatorData)
            update(clientHash)
            verify(signed.signature)
        }

    @Test fun cborMatchesTheStandard() {
        assertEquals("00", hex(Cbor.encode(0)))
        assertEquals("17", hex(Cbor.encode(23)))
        assertEquals("1818", hex(Cbor.encode(24)))
        assertEquals("1903e8", hex(Cbor.encode(1000)))
        assertEquals("26", hex(Cbor.encode(-7)))
        assertEquals("3863", hex(Cbor.encode(-100)))
        assertEquals("6449455446", hex(Cbor.encode("IETF")))
        assertEquals("4401020304", hex(Cbor.encode(byteArrayOf(1, 2, 3, 4))))
        assertEquals("a201020304", hex(Cbor.encode(linkedMapOf<Any, Any>(1 to 2, 3 to 4))))
        assertEquals("a0", hex(Cbor.encode(emptyMap<Any, Any>())))
        assertEquals("83010203", hex(Cbor.encode(listOf(1, 2, 3))))
    }

    @Test fun aNewPasskeyHasTheRightShape() {
        val made = WebAuthn.create("example.com", "dXNlci0x", "alice@example.com")
        val a = made.authenticatorData
        assertArrayEquals(WebAuthn.sha256("example.com".toByteArray()), a.copyOfRange(0, 32))
        // present, verified, backup eligible, backed up, attested credential data follows
        assertEquals(0x5d, a[32].toInt() and 0xff)
        assertArrayEquals(ByteArray(4), a.copyOfRange(33, 37))
        assertEquals("kaipass-passkeys", String(a.copyOfRange(37, 53)))
        assertEquals(32, ((a[53].toInt() and 0xff) shl 8) or (a[54].toInt() and 0xff))
        assertEquals(made.passkey.credentialId, B64.url(a.copyOfRange(55, 87)))
        // COSE key: EC2, ES256, P-256, then x and y as 32 bytes each
        assertEquals("a5010203262001215820", hex(a.copyOfRange(87, 97)))
        assertEquals(87 + 10 + 32 + 3 + 32, a.size)
        assertTrue(made.passkey.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n"))
        assertEquals("example.com", made.passkey.rpId)
        assertEquals("dXNlci0x", made.passkey.userHandle)
        assertNotEquals(made.passkey.credentialId, WebAuthn.create("example.com", "dXNlci0x", "alice").passkey.credentialId)
    }

    @Test fun signaturesVerifyWithThePublicKey() {
        val made = WebAuthn.create("example.com", "dXNlci0x", "alice")
        repeat(20) { n ->
            val hash = WebAuthn.sha256("client data $n".toByteArray())
            val signed = WebAuthn.sign(made.passkey, hash)
            assertEquals(37, signed.authenticatorData.size)
            assertEquals(0x1d, signed.authenticatorData[32].toInt() and 0xff)
            assertTrue(verifies(made.publicKey, signed, hash))
            assertFalse(verifies(made.publicKey, signed, WebAuthn.sha256("something else".toByteArray())))
        }
    }

    @Test fun signsWithAPasskeyMadeByTheWebApp() {
        val p = Passkey("aWQ", webPem, "example.com", "alice", "dQ")
        val hash = WebAuthn.sha256("x".toByteArray())
        assertTrue(verifies(Base64.getDecoder().decode(webSpki), WebAuthn.sign(p, hash), hash))
    }

    @Test fun clientDataIsWhatSitesExpect() {
        assertEquals(
            """{"type":"webauthn.get","challenge":"abc-_","origin":"https://example.com","crossOrigin":false}""",
            String(WebAuthn.clientData("webauthn.get", "abc-_", "https://example.com", null)),
        )
        val app = JSONObject(String(WebAuthn.clientData("webauthn.create", "c", "android:apk-key-hash:x", "com.example.app")))
        assertEquals("com.example.app", app.getString("androidPackageName"))
        assertEquals("android:apk-key-hash:x", app.getString("origin"))
    }

    @Test fun answersCarryEveryField() {
        val made = WebAuthn.create("example.com", "dXNlci0x", "alice")
        val reg = JSONObject(WebAuthn.registrationJson(made, "{}".toByteArray()))
        assertEquals(made.passkey.credentialId, reg.getString("id"))
        assertEquals(reg.getString("id"), reg.getString("rawId"))
        assertEquals("public-key", reg.getString("type"))
        assertEquals(-7, reg.getJSONObject("response").getInt("publicKeyAlgorithm"))
        assertEquals(B64.url(made.publicKey), reg.getJSONObject("response").getString("publicKey"))
        assertTrue(reg.getJSONObject("clientExtensionResults").getJSONObject("credProps").getBoolean("rk"))
        val signed = WebAuthn.sign(made.passkey, ByteArray(32))
        val got = JSONObject(WebAuthn.assertionJson(made.passkey, signed, "{}".toByteArray())).getJSONObject("response")
        assertEquals("dXNlci0x", got.getString("userHandle"))
        assertEquals(B64.url(signed.signature), got.getString("signature"))
        val noUser = JSONObject(WebAuthn.assertionJson(made.passkey.copy(userHandle = ""), signed, "{}".toByteArray())).getJSONObject("response")
        assertFalse(noUser.has("userHandle"))
    }

    @Test fun readsWhatSitesAsk() {
        val get = PasskeyGet.parse("""{"challenge":"c1","rpId":"Example.com","allowCredentials":[{"type":"public-key","id":"ab+/cd=="},{"id":""}],"userVerification":"preferred"}""")!!
        assertEquals("example.com", get.rpId)
        assertEquals("c1", get.challenge)
        assertEquals(listOf("ab-_cd"), get.allow)
        assertEquals(emptyList<String>(), PasskeyGet.parse("""{"challenge":"c","rpId":"a.b"}""")!!.allow)
        assertNull(PasskeyGet.parse("""{"rpId":"a.b"}"""))
        assertNull(PasskeyGet.parse("not json"))

        val create = PasskeyCreate.parse(
            """{"rp":{"id":"example.com","name":"Example"},"user":{"id":"dXNlcg==","name":"alice","displayName":"Alice A"},"challenge":"c2",
               "pubKeyCredParams":[{"type":"public-key","alg":-257},{"type":"public-key","alg":-7}],"excludeCredentials":[{"type":"public-key","id":"old"}]}""",
        )!!
        assertEquals("example.com", create.rpId)
        assertEquals("Example", create.rpName)
        assertEquals("dXNlcg", create.userId)
        assertEquals("alice", create.userName)
        assertEquals(listOf(-257, -7), create.algs)
        assertEquals(listOf("old"), create.exclude)
        assertTrue(create.supported)
        assertFalse(PasskeyCreate.parse("""{"rp":{"id":"a.b"},"user":{"id":"dQ"},"challenge":"c","pubKeyCredParams":[{"alg":-257}]}""")!!.supported)
        assertTrue(PasskeyCreate.parse("""{"rp":{"id":"a.b"},"user":{"id":"dQ"},"challenge":"c"}""")!!.supported)
        assertNull(PasskeyCreate.parse("""{"rp":{"id":"a.b"},"challenge":"c"}"""))
    }

    @Test fun onlyTheSitesOwnPagesMayUseItsPasskeys() {
        assertTrue(WebAuthn.originAllows("https://example.com", "example.com"))
        assertTrue(WebAuthn.originAllows("https://login.example.com/", "example.com"))
        assertTrue(WebAuthn.originAllows("https://Login.Example.com:8443", "example.com"))
        assertFalse(WebAuthn.originAllows("https://example.com.evil.net", "example.com"))
        assertFalse(WebAuthn.originAllows("https://evilexample.com", "example.com"))
        assertFalse(WebAuthn.originAllows("http://example.com", "example.com"))
        assertFalse(WebAuthn.originAllows("https://example.com", "login.example.com"))
        assertFalse(WebAuthn.originAllows("https://example.com", "com"))
        assertFalse(WebAuthn.originAllows("https://example.com/path", "example.com"))
        assertFalse(WebAuthn.originAllows("android:apk-key-hash:abc", "example.com"))
    }

    @Test fun appsMustBeListedByTheSite() {
        val links = """[
          {"relation":["delegate_permission/common.handle_all_urls","delegate_permission/common.get_login_creds"],
           "target":{"namespace":"android_app","package_name":"com.example.app","sha256_cert_fingerprints":["AA:BB:CC","11:22:33"]}},
          {"relation":["delegate_permission/common.get_login_creds"],"target":{"namespace":"web","site":"https://example.com"}},
          {"relation":["delegate_permission/common.use_as_origin"],
           "target":{"namespace":"android_app","package_name":"com.example.other","sha256_cert_fingerprints":["AA:BB:CC"]}}
        ]"""
        assertTrue(AssetLinks.allows(links, "com.example.app", "AA:BB:CC"))
        assertTrue(AssetLinks.allows(links, "com.example.app", "11:22:33"))
        assertTrue(AssetLinks.allows(links, "com.example.app", "aa:bb:cc"))
        assertFalse(AssetLinks.allows(links, "com.example.app", "DE:AD"))
        assertFalse(AssetLinks.allows(links, "com.evil.app", "AA:BB:CC"))
        assertFalse(AssetLinks.allows(links, "com.example.other", "AA:BB:CC"))
        assertFalse(AssetLinks.allows("<html>not found</html>", "com.example.app", "AA:BB:CC"))
        assertFalse(AssetLinks.allows("{}", "com.example.app", "AA:BB:CC"))
    }

    @Test fun appOriginAndFingerprintFormats() {
        val cert = "certificate".toByteArray()
        assertEquals("android:apk-key-hash:" + B64.url(WebAuthn.sha256(cert)), WebAuthn.appOrigin(cert))
        assertTrue(Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$").matches(WebAuthn.fingerprint(cert)))
    }

    @Test fun picksTheSitesPasskeys() {
        val a = Passkey("a", "k", "example.com", "alice", "u")
        val b = Passkey("b", "k", "example.com", "bob", "u")
        val other = Passkey("c", "k", "other.com", "carol", "u")
        assertEquals(listOf(a, b), PasskeyPick.matching(listOf(a, other, b, a), "example.com", emptyList()))
        assertEquals(listOf(b), PasskeyPick.matching(listOf(a, other, b), "example.com", listOf("b", "zz")))
        assertEquals(emptyList<Passkey>(), PasskeyPick.matching(listOf(a, b), "example.com", listOf("c")))
        assertEquals(emptyList<Passkey>(), PasskeyPick.matching(listOf(a, b), "sub.example.com", emptyList()))
    }

    @Test fun waitingPasskeysSurviveBeingStored() {
        val made = WebAuthn.create("example.com", "dXNlci0x", "alice \"a\"")
        val item = NewPasskey(made.passkey, "Example", "https://example.com", 123L)
        val back = NewPasskey.list("[" + item.toJson().toString() + "]")
        assertEquals(listOf(item), back)
        assertEquals(emptyList<NewPasskey>(), NewPasskey.list(null))
        assertEquals(emptyList<NewPasskey>(), NewPasskey.list("garbage"))
        // What the web app publishes for the vault's own passkeys reads the same way.
        val entry = FillIndex.parse(org.json.JSONArray("""[{"id":"1","title":"Example","passkey":${made.passkey.toJson()}}]""")).single()
        assertEquals(made.passkey, entry.passkey)
        assertFalse(entry.fillable)
        assertNull(FillIndex.parse(org.json.JSONArray("""[{"id":"2","username":"u"}]""")).single().passkey)
    }

    /**
     * Writes a registration and a sign-in, as a site would receive them, for e2e/android-passkey.cjs
     * to check with a WebAuthn server library.
     */
    @Test fun writesAnswersForTheServerCheck() {
        val origin = "https://example.com"
        val made = WebAuthn.create("example.com", "dXNlci0x", "alice@example.com")
        val regChallenge = "cmVnaXN0ZXItY2hhbGxlbmdl"
        val regClient = WebAuthn.clientData("webauthn.create", regChallenge, origin, null)
        val getChallenge = "c2lnbi1pbi1jaGFsbGVuZ2U"
        val getClient = WebAuthn.clientData("webauthn.get", getChallenge, origin, null)
        val signed = WebAuthn.sign(made.passkey, WebAuthn.sha256(getClient))
        // The same passkey after a trip through the vault and the web app's index.
        val stored = FillIndex.parse(org.json.JSONArray("""[{"id":"1","passkey":${made.passkey.toJson()}}]""")).single().passkey!!
        val again = WebAuthn.sign(stored, WebAuthn.sha256(getClient))
        val out = JSONObject()
            .put("origin", origin).put("rpId", "example.com")
            .put("registerChallenge", regChallenge).put("registration", JSONObject(WebAuthn.registrationJson(made, regClient)))
            .put("signInChallenge", getChallenge)
            .put("assertions", org.json.JSONArray().put(JSONObject(WebAuthn.assertionJson(made.passkey, signed, getClient))).put(JSONObject(WebAuthn.assertionJson(stored, again, getClient))))
            .put("webPasskey", JSONObject().put("pem", webPem))
        File("build").mkdirs()
        File("build/passkey-answers.json").writeText(out.toString())
    }
}
