package io.github.thanhkaiba.kaipass

/** What the autofill service knows about one input on screen, from an app view or a web page. */
data class FieldInfo(
    val hints: List<String> = emptyList(),
    val inputType: Int = 0,
    val htmlType: String? = null,
    val autocomplete: String? = null,
    /** Resource id, HTML name/id, placeholder, label: anything that names the field. */
    val words: List<String> = emptyList(),
    val isText: Boolean = true,
    val value: String? = null,
)

enum class Kind { USERNAME, PASSWORD, OTP, OTHER, SKIP }

/** Indices into the field list, in screen order. */
data class Form(
    val username: List<Int>,
    val password: List<Int>,
    val otp: List<Int>,
    /** The password fields that set a new password (sign-up, change): where a generated one goes. */
    val newPassword: List<Int> = emptyList(),
) {
    val isEmpty: Boolean get() = username.isEmpty() && password.isEmpty() && otp.isEmpty()
    val all: List<Int> get() = (username + password + otp).distinct()
}

object Classifier {
    // android.text.InputType, copied so this file runs on a plain JVM in tests.
    private const val CLASS_MASK = 0x0000000f
    private const val VARIATION_MASK = 0x00000ff0
    private const val CLASS_TEXT = 1
    private const val CLASS_NUMBER = 2
    private const val TEXT_PASSWORD = 0x80
    private const val TEXT_VISIBLE_PASSWORD = 0x90
    private const val TEXT_WEB_PASSWORD = 0xe0
    private const val TEXT_EMAIL = 0x20
    private const val TEXT_WEB_EMAIL = 0xd0
    private const val NUMBER_PASSWORD = 0x10

    private val OTP_WORDS = Regex(
        "otp|one.?time|2fa|two.?factor|mfa|totp|verif\\w*.?code|auth\\w*.?code|security.?code|" +
            "mã.?(xác|otp|bảo mật)|ma.?xac|authenticator|passcode|sms.?code",
    )
    private val PASSWORD_WORDS = Regex("pass|pwd|mật.?khẩu|mat.?khau|\\bpin\\b|secret")
    private val USERNAME_WORDS = Regex(
        "user|login|e.?mail|account|acct|identifier|\\bid\\b|tài.?khoản|tai.?khoan|tên.?đăng.?nhập|" +
            "ten.?dang.?nhap|phone|mobile|sđt|số.?điện.?thoại|so.?dien.?thoai|msisdn",
    )
    private val SKIP_WORDS = Regex("search|tìm|tim.?kiem|captcha|coupon|promo|voucher|comment|message|tin.?nhắn")
    private val SKIP_HTML_TYPES = setOf("hidden", "checkbox", "radio", "submit", "button", "search", "file", "image", "reset", "range", "color", "date", "number")

    fun kindOf(f: FieldInfo): Kind {
        if (!f.isText) return Kind.SKIP
        val hints = f.hints.map { it.lowercase() }
        if (hints.any { "otp" in it || "onetimecode" in it || "one-time-code" in it }) return Kind.OTP
        if (hints.any { "password" in it }) return Kind.PASSWORD
        if (hints.any { it == "username" || it == "emailaddress" || it == "email" || it == "phone" || "newusername" in it }) return Kind.USERNAME
        if (hints.any { it.startsWith("creditcard") || it.startsWith("postal") || it == "name" }) return Kind.SKIP

        val ac = f.autocomplete?.lowercase()?.split(' ')?.lastOrNull()
        when (ac) {
            "one-time-code" -> return Kind.OTP
            "current-password", "new-password" -> return Kind.PASSWORD
            "username", "email", "tel" -> return Kind.USERNAME
        }
        val type = f.htmlType?.lowercase()
        if (type == "password") return if (words(f).let { OTP_WORDS.containsMatchIn(it) }) Kind.OTP else Kind.PASSWORD
        if (type == "email") return Kind.USERNAME
        if (type != null && type in SKIP_HTML_TYPES && type != "number") return Kind.SKIP

        val w = words(f)
        if (SKIP_WORDS.containsMatchIn(w)) return Kind.SKIP
        val cls = f.inputType and CLASS_MASK
        val variation = f.inputType and VARIATION_MASK
        val passwordInput = (cls == CLASS_TEXT && variation in setOf(TEXT_PASSWORD, TEXT_VISIBLE_PASSWORD, TEXT_WEB_PASSWORD)) ||
            (cls == CLASS_NUMBER && variation == NUMBER_PASSWORD)
        if (OTP_WORDS.containsMatchIn(w)) return Kind.OTP
        if (passwordInput) return Kind.PASSWORD
        if (cls == CLASS_TEXT && (variation == TEXT_EMAIL || variation == TEXT_WEB_EMAIL)) return Kind.USERNAME
        if (PASSWORD_WORDS.containsMatchIn(w)) return Kind.PASSWORD
        if (USERNAME_WORDS.containsMatchIn(w)) return Kind.USERNAME
        if (type == "number") return Kind.SKIP
        return Kind.OTHER
    }

    private fun words(f: FieldInfo) = f.words.joinToString(" ").lowercase()

    fun classify(fields: List<FieldInfo>): Form {
        val kinds = fields.map(::kindOf)
        val username = kinds.indices.filter { kinds[it] == Kind.USERNAME }.toMutableList()
        val password = kinds.indices.filter { kinds[it] == Kind.PASSWORD }
        val otp = kinds.indices.filter { kinds[it] == Kind.OTP }
        // A password with no recognisable username: the text field just before it usually is one.
        if (password.isNotEmpty() && username.isEmpty()) {
            val before = (password.first() - 1 downTo 0).firstOrNull { kinds[it] == Kind.OTHER }
            if (before != null) username += before
        }
        return Form(username, password, otp, newPasswordAmong(fields, password))
    }

    private val NEW_WORDS = Regex("new|mới|moi\\b|create|choose")
    private val CONFIRM_WORDS = Regex("confirm|repeat|retype|again|verify|re.?enter|nhập.?lại|nhap.?lai|xác.?nhận|xac.?nhan|pass(word)?.?2")
    private val CURRENT_WORDS = Regex("current|old|existing|hiện.?tại|hien.?tai")

    /** Which of the password fields are for a new password rather than one the user already has. */
    fun newPasswordAmong(fields: List<FieldInfo>, password: List<Int>): List<Int> {
        fun last(i: Int) = fields[i].autocomplete?.lowercase()?.split(' ')?.lastOrNull()
        fun saysNew(i: Int) = last(i) == "new-password" || fields[i].hints.any { it.lowercase().contains("newpassword") }
        fun isNew(i: Int) = saysNew(i) || NEW_WORDS.containsMatchIn(words(fields[i]))
        fun isCurrent(i: Int) = !saysNew(i) && (last(i) == "current-password" || CURRENT_WORDS.containsMatchIn(words(fields[i])))
        fun isConfirm(i: Int) = CONFIRM_WORDS.containsMatchIn(words(fields[i]))
        return when (password.size) {
            0 -> emptyList()
            1 -> if (!isCurrent(password[0]) && isNew(password[0])) password else emptyList()
            2 -> {
                val (a, b) = password
                when {
                    isCurrent(a) -> listOf(b)
                    isConfirm(b) || isNew(a) -> password // password + confirmation
                    isNew(b) -> listOf(b) // current + new
                    else -> password
                }
            }
            // Usually: current, new, confirmation.
            else -> if (password.any(::isCurrent) || !isNew(password[0])) password.filterIndexed { n, i -> !isCurrent(i) && (n > 0 || isNew(i)) } else password
        }
    }
}
