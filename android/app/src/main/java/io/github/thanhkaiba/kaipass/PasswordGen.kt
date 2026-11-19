package io.github.thanhkaiba.kaipass

import java.security.SecureRandom

/** Strong random passwords, with the same alphabet as the app's own generator (no look-alikes). */
object PasswordGen {
    private const val UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val LOWER = "abcdefghijkmnopqrstuvwxyz"
    private const val DIGITS = "23456789"
    private const val SYMBOLS = "!@#$%^&*-_=+?"
    private val sets = listOf(UPPER, LOWER, DIGITS, SYMBOLS)

    fun generate(length: Int = 20, random: SecureRandom = SecureRandom()): String {
        val n = length.coerceIn(sets.size, 128)
        val all = sets.joinToString("")
        // One of each kind, the rest from everything, then shuffled.
        val chars = sets.map { it[random.nextInt(it.length)] }.toMutableList()
        while (chars.size < n) chars += all[random.nextInt(all.length)]
        for (i in chars.size - 1 downTo 1) {
            val j = random.nextInt(i + 1)
            val t = chars[i]
            chars[i] = chars[j]
            chars[j] = t
        }
        return chars.joinToString("")
    }
}
