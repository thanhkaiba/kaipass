package io.github.thanhkaiba.kaipass

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.IntentSender
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Hosts the KaiPass web app, served from the APK's own files at an https address, and gives it the
 * phone's features through a message channel that only that address can use.
 */
abstract class WebHostActivity : FragmentActivity() {
    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
    }

    protected lateinit var web: WebView
    private var proxy: JavaScriptReplyProxy? = null
    private lateinit var assets: WebViewAssetLoader

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private var onDocument: ((Uri?) -> Unit)? = null
    private var onSender: ((ActivityResult) -> Unit)? = null
    private var onIntent: ((ActivityResult) -> Unit)? = null

    private val chooseFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val uris = mutableListOf<Uri>()
        if (r.resultCode == RESULT_OK) {
            val clip = r.data?.clipData
            if (clip != null) for (i in 0 until clip.itemCount) uris += clip.getItemAt(i).uri
            r.data?.data?.let { uris += it }
            val shot = cameraUri
            if (uris.isEmpty() && shot != null && (File(cacheDir, "camera/shot.jpg").length() > 0)) uris += shot
        }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.distinct().toTypedArray())
    }

    private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        onDocument?.invoke(if (r.resultCode == RESULT_OK) r.data?.data else null)
        onDocument = null
    }

    private val senderLauncher = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        onSender?.invoke(r)
        onSender = null
    }

    private val intentLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        onIntent?.invoke(r)
        onIntent = null
    }

    fun launchIntentForResult(intent: Intent, then: (ActivityResult) -> Unit) {
        onIntent = then
        intentLauncher.launch(intent)
    }

    fun launchForResult(sender: IntentSender, then: (ActivityResult) -> Unit) {
        onSender = then
        senderLauncher.launch(IntentSenderRequest.Builder(sender).build())
    }

    /** Path and query the web app opens with. */
    protected open fun startPath(): String = "/index.html"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keeps passwords out of screenshots and the recent-apps preview.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web = WebView(this)
        val root = FrameLayout(this).apply { addView(web) }
        setContentView(root)
        // Android 15 draws apps edge to edge: keep the page clear of the status bar and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
        }
        assets = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == HOST) assets.shouldInterceptRequest(request.url) else null

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                openExternal(request.url)
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                showFileChooser(callback, params)
        }
        web.setDownloadListener { _, _, _, _, _ -> /* files are saved through the bridge */ }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            web.loadData("<p style='font:16px sans-serif;padding:24px'>Cần cập nhật Android System WebView (Play Store) để dùng KaiPass.</p>", "text/html", "utf-8")
            return
        }
        WebViewCompat.addWebMessageListener(web, "KaiPassNative", setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
            if (!isMainFrame || origin.toString() != ORIGIN) return@addWebMessageListener
            proxy = reply
            handle(message.data)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(ORIGIN + startPath())
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    // ---- bridge ----

    fun emit(event: String, data: JSONObject = JSONObject()) {
        runOnUiThread { proxy?.postMessage(JSONObject().put("event", event).put("data", data).toString()) }
    }

    private fun handle(raw: String?) {
        val msg = try { JSONObject(raw ?: return) } catch (e: Exception) { return }
        val id = msg.optInt("id")
        val args = msg.optJSONObject("args") ?: JSONObject()
        var answered = false
        fun send(o: JSONObject) = runOnUiThread {
            if (answered) return@runOnUiThread
            answered = true
            proxy?.postMessage(o.put("id", id).toString())
        }
        val ok: (Any?) -> Unit = { send(JSONObject().put("ok", true).put("result", it ?: JSONObject.NULL)) }
        val fail: (String) -> Unit = { send(JSONObject().put("ok", false).put("error", it)) }
        try {
            dispatch(msg.optString("method"), args, ok, fail)
        } catch (e: Exception) {
            fail(e.message ?: e.toString())
        }
    }

    protected open fun dispatch(method: String, args: JSONObject, ok: (Any?) -> Unit, fail: (String) -> Unit) {
        when (method) {
            "hello", "info" -> ok(info())
            "googleToken" -> GoogleAuth.token(this, args.optBoolean("interactive"), ok, fail)
            "googleClearToken" -> { GoogleAuth.clear(this, args.optString("token")); ok(true) }
            "bioEnroll" -> Bio.enroll(this, args.getString("password"), { ok(true) }, fail)
            "bioUnlock" -> Bio.unlock(this, { ok(JSONObject().put("password", it)) }, fail)
            "bioDisable" -> { Bio.disable(this); ok(true) }
            "copy" -> { Clip.copy(this, args.getString("text"), args.optBoolean("sensitive")); ok(true) }
            "openUrl" -> { openExternal(Uri.parse(args.getString("url"))); ok(true) }
            "saveFile" -> saveFile(args.getString("name"), args.optString("mime", "application/octet-stream"), args.getString("data"), ok)
            "setFillIndex" -> {
                val entries = FillIndex.parse(args.optJSONArray("entries") ?: JSONArray())
                // Site names only, kept while locked so a passkey request can offer to unlock.
                PasskeySites.set(this, entries.mapNotNull { it.passkey?.rpId }.toSet())
                FillIndex.publish(entries, args.optInt("lockMinutes", 10))
                ok(true)
            }
            "newPasskeys" -> ok(JSONArray(NewPasskeys.all(this).map { it.toJson() }))
            "passkeysDone" -> {
                val ids = args.optJSONArray("ids") ?: JSONArray()
                NewPasskeys.remove(this, (0 until ids.length()).map { B64.normal(ids.getString(it)) }.toSet())
                ok(true)
            }
            "openPasskeySettings" -> { openPasskeySettings(); ok(true) }
            "clearFillIndex" -> { FillIndex.clear(); ok(true) }
            "touch" -> { FillIndex.touch(); ok(true) }
            "openAutofillSettings" -> {
                try {
                    startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:$packageName")))
                } catch (e: ActivityNotFoundException) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
                ok(true)
            }
            "pendingSave" -> ok(PendingStore.next(this)?.toJson())
            "saveDone" -> { PendingStore.remove(this, args.optString("id")); ok(true); onSaveDone() }
            else -> fail("Không hỗ trợ: $method")
        }
    }

    protected open fun onSaveDone() {}

    /** Android 14+: whether KaiPass is switched on under "Passwords, passkeys & autofill". */
    private fun passkeysEnabled(): Boolean {
        if (Build.VERSION.SDK_INT < 34) return false
        return try {
            getSystemService(android.credentials.CredentialManager::class.java)
                ?.isEnabledCredentialProviderService(ComponentName(this, KaiPassCredentialService::class.java)) == true
        } catch (e: RuntimeException) {
            false
        }
    }

    private fun openPasskeySettings() {
        val attempts = listOfNotNull(
            if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_CREDENTIAL_PROVIDER).setData(Uri.parse("package:$packageName")) else null,
            Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData(Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (i in attempts) {
            try {
                return startActivity(i)
            } catch (e: ActivityNotFoundException) {
                /* try the next screen */
            }
        }
    }

    private fun info(): JSONObject {
        val af = getSystemService(AutofillManager::class.java)
        return JSONObject()
            .put("platform", "android")
            .put("version", BuildConfig.VERSION_NAME)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("package", packageName)
            .put("sha1", GoogleAuth.signingSha1(this))
            .put("autofill", JSONObject()
                .put("supported", af?.isAutofillSupported == true)
                .put("enabled", af?.hasEnabledAutofillServices() == true))
            .put("passkeys", JSONObject().put("supported", Build.VERSION.SDK_INT >= 34).put("enabled", passkeysEnabled()))
            .put("bio", JSONObject().put("available", Bio.available(this)).put("enrolled", Bio.enrolled(this)))
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in setOf("http", "https", "mailto", "tel")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            /* no app for it */
        }
    }

    private fun saveFile(name: String, mime: String, base64: String, ok: (Any?) -> Unit) {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        onDocument = { uri ->
            if (uri == null) ok(JSONObject().put("saved", false))
            else {
                contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                ok(JSONObject().put("saved", true))
            }
        }
        createDocument.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name))
    }

    private fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        val accept = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.filter { it.isNotEmpty() }
        val mimes = accept.filter { '/' in it }
        val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
        // File extensions (".1pux") have no MIME type Android knows: then any file.
        if (mimes.isNotEmpty() && mimes.size == accept.size) {
            pick.type = if (mimes.size == 1) mimes[0] else "*/*"
            if (mimes.size > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        } else {
            pick.type = "*/*"
        }
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        val chooser = Intent.createChooser(pick, null)
        cameraUri = null
        if (mimes.any { it.startsWith("image/") }) {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            val file = File(dir, "shot.jpg").apply { delete() }
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            cameraUri = uri
            val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
        }
        return try {
            chooseFiles.launch(chooser)
            true
        } catch (e: ActivityNotFoundException) {
            fileCallback = null
            false
        }
    }
}
