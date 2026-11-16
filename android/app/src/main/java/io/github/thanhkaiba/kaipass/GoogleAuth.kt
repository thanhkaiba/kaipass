package io.github.thanhkaiba.kaipass

import android.accounts.Account
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.auth.GoogleAuthException
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.UserRecoverableAuthException
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.auth.api.signin.GoogleSignInStatusCodes
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Google Drive access through Google Play services (Google blocks its sign-in page inside apps'
 * web views). Only the drive.file scope: KaiPass sees just the files it created.
 *
 * Tries Google's current authorization API first. If that fails for a reason other than the user
 * cancelling, it falls back to the older sign-in + GoogleAuthUtil route, which works on more
 * setups and says precisely what is wrong when the Cloud project is not set up for this app.
 */
object GoogleAuth {
    private const val SCOPE = "https://www.googleapis.com/auth/drive.file"

    private class Failure(val message: String, val canceled: Boolean = false, val config: Boolean = false)

    fun token(a: WebHostActivity, interactive: Boolean, ok: (JSONObject) -> Unit, fail: (String) -> Unit) {
        val deliver = { token: String -> ok(JSONObject().put("token", token).put("expiresIn", 3300)) }
        modern(a, interactive, deliver) { first ->
            if (first.canceled || first.message == "consent-needed") return@modern fail(first.message)
            legacy(a, interactive, deliver) { second ->
                if (second.canceled || second.message == "consent-needed") return@legacy fail(second.message)
                val config = first.config || second.config
                fail(buildString {
                    append("Đăng nhập Google thất bại: ").append(second.message)
                    if (second.message != first.message) append(" (cách 1: ").append(first.message).append(")")
                    if (config) append(". ").append(setupHint(a))
                })
            }
        }
    }

    /** Lets Google hand out a new token after Drive refused the old one. */
    fun clear(c: Context, token: String) {
        thread {
            try {
                GoogleAuthUtil.clearToken(c, token)
            } catch (e: Exception) {
                /* nothing cached */
            }
        }
    }

    private fun modern(a: WebHostActivity, interactive: Boolean, ok: (String) -> Unit, fail: (Failure) -> Unit) {
        val request = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(SCOPE))).build()
        val client = Identity.getAuthorizationClient(a)
        fun deliver(r: AuthorizationResult) {
            val token = r.accessToken ?: return fail(Failure("Google không trả về quyền truy cập"))
            ok(token)
        }
        client.authorize(request)
            .addOnSuccessListener { r ->
                val pending = r.pendingIntent
                if (!r.hasResolution() || pending == null) return@addOnSuccessListener deliver(r)
                if (!interactive) return@addOnSuccessListener fail(Failure("consent-needed"))
                a.launchForResult(pending.intentSender) { res ->
                    try {
                        deliver(client.getAuthorizationResultFromIntent(res.data))
                    } catch (e: ApiException) {
                        fail(describe(e))
                    }
                }
            }
            .addOnFailureListener { e -> fail(if (e is ApiException) describe(e) else Failure(e.message ?: "lỗi không rõ")) }
    }

    @Suppress("DEPRECATION")
    private fun legacy(a: WebHostActivity, interactive: Boolean, ok: (String) -> Unit, fail: (Failure) -> Unit) {
        val scope = Scope(SCOPE)
        val last = GoogleSignIn.getLastSignedInAccount(a)
        val account = last?.account
        if (account != null && GoogleSignIn.hasPermissions(last, scope)) return fetch(a, account, interactive, ok, fail)
        if (!interactive) return fail(Failure("consent-needed"))
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN).requestEmail().requestScopes(scope).build()
        a.launchIntentForResult(GoogleSignIn.getClient(a, options).signInIntent) { res ->
            try {
                val acc = GoogleSignIn.getSignedInAccountFromIntent(res.data).getResult(ApiException::class.java)
                val chosen = acc.account ?: return@launchIntentForResult fail(Failure("Google không trả về tài khoản"))
                fetch(a, chosen, interactive, ok, fail)
            } catch (e: ApiException) {
                fail(
                    when (e.statusCode) {
                        GoogleSignInStatusCodes.SIGN_IN_CANCELLED -> Failure("Bạn đã huỷ đăng nhập Google", canceled = true)
                        CommonStatusCodes.DEVELOPER_ERROR, GoogleSignInStatusCodes.SIGN_IN_FAILED ->
                            Failure("Google chưa nhận app này (mã ${e.statusCode})", config = true)
                        else -> describe(e)
                    },
                )
            }
        }
    }

    private fun fetch(a: WebHostActivity, account: Account, interactive: Boolean, ok: (String) -> Unit, fail: (Failure) -> Unit) {
        thread {
            try {
                val token = GoogleAuthUtil.getToken(a, account, "oauth2:$SCOPE")
                a.runOnUiThread { ok(token) }
            } catch (e: UserRecoverableAuthException) {
                val intent = e.intent
                if (!interactive || intent == null) return@thread a.runOnUiThread { fail(Failure("consent-needed")) }
                a.runOnUiThread {
                    a.launchIntentForResult(intent) { res ->
                        if (res.resultCode == android.app.Activity.RESULT_OK) fetch(a, account, false, ok, fail)
                        else fail(Failure("Bạn đã huỷ cấp quyền Google Drive", canceled = true))
                    }
                }
            } catch (e: GoogleAuthException) {
                // e.g. "UNREGISTERED_ON_API_CONSOLE": no Android OAuth client matches this app.
                val m = e.message ?: "GoogleAuthException"
                a.runOnUiThread { fail(Failure("Google báo $m", config = "UNREGISTERED" in m || "INVALID" in m || "Unknown" in m)) }
            } catch (e: IOException) {
                a.runOnUiThread { fail(Failure("Không kết nối được tới Google (kiểm tra mạng)")) }
            }
        }
    }

    private fun describe(e: ApiException): Failure {
        val detail = e.status.statusMessage?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""
        return when (e.statusCode) {
            CommonStatusCodes.CANCELED -> Failure("Bạn đã huỷ đăng nhập Google", canceled = true)
            CommonStatusCodes.DEVELOPER_ERROR -> Failure("Google chưa nhận app này (mã 10$detail)", config = true)
            CommonStatusCodes.INTERNAL_ERROR -> Failure("lỗi nội bộ của Google Play services (mã 8$detail)", config = true)
            CommonStatusCodes.NETWORK_ERROR -> Failure("Không kết nối được tới Google (kiểm tra mạng)")
            CommonStatusCodes.SIGN_IN_REQUIRED -> Failure("Cần thêm tài khoản Google vào điện thoại")
            else -> Failure("mã ${e.statusCode}$detail")
        }
    }

    /** What to compare in Google Cloud: this running app's package and signing SHA-1. */
    fun setupHint(c: Context): String =
        "Trong Google Cloud (cùng project với Client ID web) cần OAuth client loại Android với package ${c.packageName} và SHA-1 ${signingSha1(c)}. " +
            "Nếu vừa tạo, đợi vài phút rồi thử lại."

    @Suppress("DEPRECATION")
    fun signingSha1(c: Context): String {
        val pm = c.packageManager
        val cert = if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(c.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners?.firstOrNull()
        } else {
            pm.getPackageInfo(c.packageName, PackageManager.GET_SIGNATURES).signatures?.firstOrNull()
        } ?: return "?"
        return MessageDigest.getInstance("SHA-1").digest(cert.toByteArray()).joinToString(":") { "%02X".format(it) }
    }
}
