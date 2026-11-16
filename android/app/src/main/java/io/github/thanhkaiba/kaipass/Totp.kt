package io.github.thanhkaiba.kaipass

import java.net.URLDecoder
import java.nio.ByteBuffer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Time-based one-time codes (RFC 6238), from an otpauth:// URI or a bare base32 secret. */
class OtpConfig(val secret: ByteArray, val algorithm: String, val digits: Int, val period: Int)

object Totp {
    fun parse(value: String): OtpConfig? {
        val v = value.trim()
        if (v.isEmpty()) return null
        if (!v.startsWith("otpauth://", ignoreCase = true)) return base32(v)?.let { OtpConfig(it, "SHA1", 6, 30) }
        if (!v.substring("otpauth://".length).startsWith("totp", ignoreCase = true)) return null
        val params = v.substringAfter('?', "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else it.substring(0, i).lowercase() to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }.toMap()
        val secret = base32(params["secret"] ?: return null) ?: return null
        val algorithm = when (params["algorithm"]?.uppercase()) {
            "SHA256" -> "SHA256"
            "SHA512" -> "SHA512"
            else -> "SHA1"
        }
        val digits = params["digits"]?.toIntOrNull()?.takeIf { it in 4..10 } ?: 6
        val period = params["period"]?.toIntOrNull()?.takeIf { it in 1..600 } ?: 30
        return OtpConfig(secret, algorithm, digits, period)
    }

    fun base32(s: String): ByteArray? {
        val clean = s.uppercase().replace(Regex("[\\s=-]"), "")
        if (clean.isEmpty()) return null
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val out = java.io.ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        for (c in clean) {
            val v = alphabet.indexOf(c)
            if (v < 0) return null
            buffer = (buffer shl 5) or v
            bits += 5
            if (bits >= 8) {
                out.write((buffer shr (bits - 8)) and 0xff)
                bits -= 8
            }
        }
        return out.toByteArray().takeIf { it.isNotEmpty() }
    }

    fun code(config: OtpConfig, timeMillis: Long = System.currentTimeMillis()): String {
        val counter = timeMillis / 1000 / config.period
        val mac = Mac.getInstance("Hmac${config.algorithm}")
        mac.init(SecretKeySpec(config.secret, "RAW"))
        val h = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array())
        val o = h.last().toInt() and 0x0f
        val bin = ((h[o].toInt() and 0x7f) shl 24) or ((h[o + 1].toInt() and 0xff) shl 16) or
            ((h[o + 2].toInt() and 0xff) shl 8) or (h[o + 3].toInt() and 0xff)
        var mod = 1L
        repeat(config.digits) { mod *= 10 }
        return (bin.toLong() % mod).toString().padStart(config.digits, '0')
    }

    /** The current code, or null when the value is not a usable TOTP secret. */
    fun now(value: String): String? = parse(value)?.let { code(it) }
}
