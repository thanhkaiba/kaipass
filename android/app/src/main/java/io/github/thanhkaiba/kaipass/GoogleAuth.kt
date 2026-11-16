package io.github.thanhkaiba.kaipass

import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import org.json.JSONObject

/**
 * Google Drive access through Google Play services (Google blocks its sign-in page inside apps'
 * web views). Only the drive.file scope: KaiPass sees just the files it created.
 */
object GoogleAuth {
    private const val SCOPE = "https://www.googleapis.com/auth/drive.file"

    fun token(a: WebHostActivity, interactive: Boolean, ok: (JSONObject) -> Unit, fail: (String) -> Unit) {
        val request = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(SCOPE))).build()
        val client = Identity.getAuthorizationClient(a)
        fun deliver(r: AuthorizationResult) {
            val token = r.accessToken ?: return fail("Google không trả về quyền truy cập")
            // Access tokens last an hour; ask again a little early.
            ok(JSONObject().put("token", token).put("expiresIn", 3300))
        }
        client.authorize(request)
            .addOnSuccessListener { r ->
                val pending = r.pendingIntent
                if (!r.hasResolution() || pending == null) return@addOnSuccessListener deliver(r)
                if (!interactive) return@addOnSuccessListener fail("consent-needed")
                a.launchForResult(pending.intentSender) { res ->
                    try {
                        deliver(client.getAuthorizationResultFromIntent(res.data))
                    } catch (e: ApiException) {
                        fail(if (e.statusCode == CommonStatusCodes.CANCELED) "Bạn đã huỷ đăng nhập Google" else describe(e))
                    }
                }
            }
            .addOnFailureListener { e -> fail(if (e is ApiException) describe(e) else e.message ?: "Đăng nhập Google thất bại") }
    }

    private fun describe(e: ApiException): String = when (e.statusCode) {
        CommonStatusCodes.DEVELOPER_ERROR ->
            "Google chưa nhận app Android này: cần tạo OAuth client loại Android (package io.github.thanhkaiba.kaipass + SHA-1) trong Google Cloud"
        CommonStatusCodes.NETWORK_ERROR -> "Không kết nối được tới Google (kiểm tra mạng)"
        CommonStatusCodes.CANCELED -> "Bạn đã huỷ đăng nhập Google"
        CommonStatusCodes.SIGN_IN_REQUIRED -> "Cần đăng nhập tài khoản Google trên điện thoại"
        else -> "Đăng nhập Google thất bại (mã ${e.statusCode})"
    }
}
