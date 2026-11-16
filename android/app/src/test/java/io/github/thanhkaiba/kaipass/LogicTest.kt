package io.github.thanhkaiba.kaipass

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TotpTest {
    // RFC 6238 test vectors (SHA1 secret "12345678901234567890").
    private val rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    @Test fun rfcVectors() {
        val c = Totp.parse("otpauth://totp/x?secret=$rfcSecret&digits=8&period=30")!!
        assertEquals("94287082", Totp.code(c, 59_000))
        assertEquals("07081804", Totp.code(c, 1111111109_000))
        assertEquals("14050471", Totp.code(c, 1111111111_000))
        assertEquals("89005924", Totp.code(c, 1234567890_000))
    }

    @Test fun bareSecretAndDefaults() {
        val c = Totp.parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")!!
        assertEquals(6, c.digits)
        assertEquals(30, c.period)
        assertEquals("287082", Totp.code(c, 59_000))
    }

    @Test fun sha256AndEscapes() {
        val c = Totp.parse("otpauth://totp/AWS%3Atheo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&algorithm=SHA256&digits=8")!!
        assertEquals("46119246", Totp.code(c, 59_000))
    }

    @Test fun rejectsJunk() {
        assertNull(Totp.parse(""))
        assertNull(Totp.parse("otpauth://hotp/x?secret=GEZDGNBV&counter=1"))
        assertNull(Totp.parse("not base32 !!"))
        assertNull(Totp.parse("otpauth://totp/x?issuer=a"))
    }
}

class MatcherTest {
    private fun entry(id: String, hosts: List<String> = emptyList(), sites: List<String> = emptyList(), labels: List<String> = emptyList(), apps: List<String> = emptyList()) =
        Entry(id, id, "u", "p", "", hosts, sites, labels, apps)

    private val google = entry("google", listOf("accounts.google.com"), listOf("google.com"), listOf("google"))
    private val aws = entry("aws", listOf("signin.aws.amazon.com"), listOf("amazon.com"), listOf("amazon"))
    private val shopee = entry("shopee", listOf("shopee.vn"), listOf("shopee.vn"), listOf("shopee"))
    private val pages = entry("blog", listOf("me.github.io"), listOf("me.github.io"), listOf("me"))
    private val bank = entry("bank", apps = listOf("com.vietcombank.vcbdigibank"))
    private val all = listOf(google, aws, shopee, pages, bank)

    @Test fun webExactBeforeSameSite() {
        val m = Matcher.matches(all, Target("accounts.google.com", "com.android.chrome"))
        assertEquals(listOf("google"), m.map { it.id })
        assertEquals(listOf("google"), Matcher.matches(all, Target("mail.google.com", "com.android.chrome")).map { it.id })
        assertEquals(listOf("aws"), Matcher.matches(all, Target("123456789012.signin.aws.amazon.com", "org.mozilla.firefox")).map { it.id })
    }

    @Test fun webNeverAcrossSites() {
        assertTrue(Matcher.matches(all, Target("evilgoogle.com", "com.android.chrome")).isEmpty())
        assertTrue(Matcher.matches(all, Target("google.com.evil.io", "com.android.chrome")).isEmpty())
        assertTrue(Matcher.matches(all, Target("other.github.io", "com.android.chrome")).isEmpty())
    }

    @Test fun apps() {
        assertEquals(listOf("bank"), Matcher.matches(all, Target(null, "com.vietcombank.vcbdigibank")).map { it.id })
        assertEquals(listOf("shopee"), Matcher.matches(all, Target(null, "com.shopee.vn")).map { it.id })
        assertTrue("a browser without a page domain gets nothing", Matcher.matches(all, Target(null, "com.android.chrome")).isEmpty())
        assertTrue(Matcher.matches(all, Target(null, "com.example.notes")).isEmpty())
    }

    @Test fun rememberedPick() {
        assertEquals(listOf("aws"), Matcher.matches(all, Target(null, "com.example.console"), setOf("aws")).map { it.id })
    }
}

class ClassifierTest {
    private val PASSWORD_INPUT = 0x81
    private val EMAIL_INPUT = 0x21
    private val TEXT = 0x1

    @Test fun nativeAppWithHints() {
        val f = Classifier.classify(listOf(
            FieldInfo(hints = listOf("emailAddress")),
            FieldInfo(hints = listOf("password")),
        ))
        assertEquals(listOf(0), f.username)
        assertEquals(listOf(1), f.password)
    }

    @Test fun nativeAppByInputTypeAndId() {
        val f = Classifier.classify(listOf(
            FieldInfo(inputType = TEXT, words = listOf("search_box")),
            FieldInfo(inputType = TEXT, words = listOf("edt_phone", "Số điện thoại")),
            FieldInfo(inputType = PASSWORD_INPUT, words = listOf("edt_pass")),
        ))
        assertEquals(listOf(1), f.username)
        assertEquals(listOf(2), f.password)
    }

    @Test fun webForm() {
        val f = Classifier.classify(listOf(
            FieldInfo(htmlType = "hidden", words = listOf("csrf")),
            FieldInfo(htmlType = "text", words = listOf("q", "Tìm kiếm")),
            FieldInfo(htmlType = "text", words = listOf("signin-field")),
            FieldInfo(htmlType = "password", words = listOf("pw")),
            FieldInfo(htmlType = "checkbox", words = listOf("remember")),
        ))
        assertEquals("the text field before the password", listOf(2), f.username)
        assertEquals(listOf(3), f.password)
        assertTrue(f.otp.isEmpty())
    }

    @Test fun otpFields() {
        val f = Classifier.classify(listOf(
            FieldInfo(htmlType = "text", autocomplete = "one-time-code"),
        ))
        assertEquals(listOf(0), f.otp)
        val g = Classifier.classify(listOf(FieldInfo(inputType = 0x12, words = listOf("Mã xác thực"))))
        assertEquals(listOf(0), g.otp)
        val h = Classifier.classify(listOf(FieldInfo(htmlType = "password", words = listOf("totp-code"))))
        assertEquals(listOf(0), h.otp)
        assertTrue(h.password.isEmpty())
    }

    @Test fun emailOnlyStep() {
        val f = Classifier.classify(listOf(FieldInfo(inputType = EMAIL_INPUT, words = listOf("identifierId"))))
        assertEquals(listOf(0), f.username)
        assertTrue(f.password.isEmpty())
    }

    @Test fun nothingToFill() {
        assertTrue(Classifier.classify(listOf(FieldInfo(inputType = TEXT, words = listOf("note")), FieldInfo(isText = false))).isEmpty)
        assertTrue(Classifier.classify(listOf(FieldInfo(hints = listOf("creditCardNumber")))).isEmpty)
    }
}
