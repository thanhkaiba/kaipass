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

class NewPasswordTest {
    private val PW = 0x81
    private fun pw(vararg words: String, autocomplete: String? = null, hints: List<String> = emptyList()) =
        FieldInfo(inputType = PW, words = words.toList(), autocomplete = autocomplete, hints = hints, htmlType = if (autocomplete != null) "password" else null)

    @Test fun signInFormHasNone() {
        val f = Classifier.classify(listOf(FieldInfo(hints = listOf("username")), pw("password")))
        assertTrue(f.newPassword.isEmpty())
        assertTrue(Classifier.classify(listOf(pw("pass", autocomplete = "current-password"))).newPassword.isEmpty())
    }

    @Test fun signUpWithConfirmation() {
        val f = Classifier.classify(listOf(FieldInfo(inputType = 0x21, words = listOf("email")), pw("password"), pw("confirm_password")))
        assertEquals(listOf(1, 2), f.newPassword)
        assertEquals(listOf(0), f.username)
    }

    @Test fun hintedSingleField() {
        assertEquals(listOf(0), Classifier.classify(listOf(pw("pw", autocomplete = "new-password"))).newPassword)
        assertEquals(listOf(0), Classifier.classify(listOf(pw("pw", hints = listOf("newPassword")))).newPassword)
        assertEquals(listOf(0), Classifier.classify(listOf(pw("Mật khẩu mới"))).newPassword)
    }

    @Test fun changePasswordKeepsTheCurrentOne() {
        val three = Classifier.classify(listOf(pw("current"), pw("new_password"), pw("repeat")))
        assertEquals(listOf(1, 2), three.newPassword)
        val two = Classifier.classify(listOf(pw("old_password"), pw("password")))
        assertEquals(listOf(1), two.newPassword)
        val unlabelled = Classifier.classify(listOf(pw("pass1", autocomplete = "current-password"), pw("pass2", autocomplete = "new-password"), pw("pass3", autocomplete = "new-password")))
        assertEquals(listOf(1, 2), unlabelled.newPassword)
    }
}

class PasswordGenTest {
    @Test fun strongAndVaried() {
        val seen = HashSet<String>()
        repeat(200) {
            val p = PasswordGen.generate()
            assertEquals(20, p.length)
            assertTrue(p.any { it.isUpperCase() } && p.any { it.isLowerCase() } && p.any { it.isDigit() } && p.any { !it.isLetterOrDigit() })
            assertTrue("no look-alike characters", p.none { it in "O0Il1" })
            seen += p
        }
        assertEquals(200, seen.size)
        assertEquals(8, PasswordGen.generate(8).length)
    }
}

class PendingQueueTest {
    private val web = Target("example.com", "com.android.chrome")
    private fun item(user: String, pass: String, generated: Boolean, at: Long = 1000, target: Target = web) = PendingSave.new(target, "Chrome", user, pass, generated, at)

    @Test fun samePasswordForSamePlaceIsOneEntry() {
        val made = item("", "Gen-1", generated = true)
        // Android's own save prompt later reports the same password, now with the username.
        val list = PendingQueue.add(PendingQueue.add(emptyList(), made), item("dave@example.com", "Gen-1", generated = false))
        assertEquals(1, list.size)
        assertEquals(made.id, list[0].id)
        assertEquals("dave@example.com", list[0].username)
        assertTrue(list[0].generated)
    }

    @Test fun differentPlacesOrPasswordsStaySeparate() {
        var list = PendingQueue.add(emptyList(), item("a", "p1", false))
        list = PendingQueue.add(list, item("a", "p2", false))
        list = PendingQueue.add(list, item("a", "p1", false, target = Target(null, "vn.zalo")))
        assertEquals(3, list.size)
    }

    @Test fun generatedPasswordsOutliveTypedOnes() {
        val day = 24 * 3_600_000L
        val list = listOf(item("a", "typed", false, at = 0), item("b", "made", true, at = 0))
        assertEquals(listOf("made"), PendingQueue.fresh(list, 2 * day).map { it.password })
        assertTrue(PendingQueue.fresh(list, 40 * day).isEmpty())
    }

    @Test fun survivesBeingStored() {
        val a = item("u", "p@ss \"quoted\"", true, target = Target(null, "vn.zalo"))
        assertEquals(a, PendingSave.fromJson(org.json.JSONObject(a.toJson().toString())))
    }
}

