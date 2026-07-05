package com.kaptan.x1xx.browser

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Bundle
import android.view.*
import android.webkit.*
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.kaptan.x1xx.R
import com.kaptan.x1xx.bridge.NodeBridge

/**
 * 1XX1Browser
 *
 * Sistemin kendi tarayicisi.
 * localhost:1331 → tam erisim, timeout yok, CORS yok.
 * Dis URL'ler → kullanici onayi.
 *
 * Protokol:
 *   1xx1://dashboard    → http://localhost:1331/#dashboard
 *   1xx1://search       → http://localhost:1331/#search
 *   http://localhost    → dogrudan erisim
 *   https://external    → dis ag (mesh yoksa uyar)
 */
class X1XXBrowserActivity : AppCompatActivity() {

    companion object {
        const val HOME_URL  = "http://localhost:1331"
        const val PROTOCOL  = "1xx1://"
    }

    private lateinit var webView:    WebView
    private lateinit var urlBar:     EditText
    private lateinit var btnBack:    ImageButton
    private lateinit var btnForward: ImageButton
    private lateinit var btnHome:    ImageButton
    private lateinit var btnRefresh: ImageButton
    private lateinit var progressBar: ProgressBar
    private lateinit var statusDot:  View
    private lateinit var statusText: TextView

    private val bridge = NodeBridge.instance

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_browser)

        // View baglantilari
        webView     = findViewById(R.id.webView)
        urlBar      = findViewById(R.id.urlBar)
        btnBack     = findViewById(R.id.btnBack)
        btnForward  = findViewById(R.id.btnForward)
        btnHome     = findViewById(R.id.btnHome)
        btnRefresh  = findViewById(R.id.btnRefresh)
        progressBar = findViewById(R.id.progressBar)
        statusDot   = findViewById(R.id.statusDot)
        statusText  = findViewById(R.id.statusText)

        setupWebView()
        setupControls()
        setupBridgeListener()

        // Ana sayfayi yükle
        loadUrl(HOME_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled          = true
            domStorageEnabled          = true
            databaseEnabled            = true
            allowFileAccess            = true
            allowContentAccess         = true
            setSupportZoom(true)
            builtInZoomControls        = true
            displayZoomControls        = false
            useWideViewPort            = true
            loadWithOverviewMode       = true
            mixedContentMode           = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode                  = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }

        // JavaScript köprüsü — Web'den Android'e cagri
        webView.addJavascriptInterface(X1XXJsBridge(this, bridge), "X1XX")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url.toString()

                // 1xx1:// protokolü → iç sayfa
                if (url.startsWith(PROTOCOL)) {
                    val path = url.removePrefix(PROTOCOL)
                    view.loadUrl("$HOME_URL/#$path")
                    return true
                }

                // localhost → her zaman izin ver
                if (url.contains("localhost") || url.contains("127.0.0.1")) {
                    return false
                }

                // Dis URL → yükle (gelecekte onay sorulabilir)
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                progressBar.visibility = View.VISIBLE
                updateUrlBar(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                progressBar.visibility = View.GONE
                updateNavButtons()
                // Health durumunu guncelle
                bridge.fetchHealth()
            }

            override fun onReceivedSslError(
                view: WebView, handler: SslErrorHandler, error: SslError
            ) {
                // localhost SSL hatasi → devam et
                if (error.url?.contains("localhost") == true) {
                    handler.proceed()
                } else {
                    handler.cancel()
                }
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest,
                error: WebResourceError
            ) {
                // localhost hatasi → Node baslamamis olabilir
                if (request.url.toString().contains("localhost")) {
                    showNodeOfflineMessage()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
            }

            override fun onJsAlert(
                view: WebView, url: String, message: String,
                result: JsResult
            ): Boolean {
                android.app.AlertDialog.Builder(this@X1XXBrowserActivity)
                    .setMessage(message)
                    .setPositiveButton("Tamam") { _, _ -> result.confirm() }
                    .show()
                return true
            }
        }
    }

    private fun setupControls() {
        btnBack.setOnClickListener {
            if (webView.canGoBack()) webView.goBack()
        }
        btnForward.setOnClickListener {
            if (webView.canGoForward()) webView.goForward()
        }
        btnHome.setOnClickListener {
            loadUrl(HOME_URL)
        }
        btnRefresh.setOnClickListener {
            webView.reload()
        }

        urlBar.setOnEditorActionListener { _, _, _ ->
            val input = urlBar.text.toString().trim()
            val url   = when {
                input.startsWith("1xx1://")  -> "${HOME_URL}/#${input.removePrefix(PROTOCOL)}"
                input.startsWith("http")     -> input
                input.contains("localhost")  -> "http://$input"
                input.contains(".")          -> "https://$input"
                else                         -> "${HOME_URL}/#search?q=$input"
            }
            loadUrl(url)
            true
        }
    }

    private fun setupBridgeListener() {
        // Node durumunu dinle
        bridge.onLog { line ->
            if (line.contains("ÇALIŞIYOR") || line.contains("hazir")) {
                runOnUiThread {
                    updateStatus(true)
                    // Node hazir oldugunda sayfayi yenile
                    if (webView.url?.contains("localhost") == true) {
                        webView.reload()
                    }
                }
            }
        }

        // Periyodik durum kontrolü
        android.os.Handler(mainLooper).postDelayed(object : Runnable {
            override fun run() {
                val status = bridge.getStatus()
                updateStatus(status.running)
                android.os.Handler(mainLooper).postDelayed(this, 3000)
            }
        }, 1000)
    }

    private fun loadUrl(url: String) {
        webView.loadUrl(url)
        updateUrlBar(url)
    }

    private fun updateUrlBar(url: String) {
        val display = when {
            url.startsWith(HOME_URL) -> url.replace(HOME_URL, "1xx1:/")
            else -> url
        }
        urlBar.setText(display)
    }

    private fun updateNavButtons() {
        btnBack.alpha    = if (webView.canGoBack())    1.0f else 0.4f
        btnForward.alpha = if (webView.canGoForward()) 1.0f else 0.4f
    }

    private fun updateStatus(online: Boolean) {
        if (online) {
            statusDot.setBackgroundResource(R.drawable.dot_green)
            statusText.text = "AKTIF"
            statusText.setTextColor(ContextCompat.getColor(this, android.R.color.holo_green_light))
        } else {
            statusDot.setBackgroundResource(R.drawable.dot_red)
            statusText.text = "OFFLINE"
            statusText.setTextColor(ContextCompat.getColor(this, android.R.color.holo_red_light))
        }
    }

    private fun showNodeOfflineMessage() {
        runOnUiThread {
            webView.loadData(
                """
                <html>
                <head>
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <style>
                  body { background:#0E1116; color:#E8EDF5; font-family:monospace;
                         display:flex; align-items:center; justify-content:center;
                         height:100vh; margin:0; flex-direction:column; gap:16px; }
                  h1 { color:#5B8CFF; font-size:24px; }
                  p  { color:#6B7A90; text-align:center; }
                  button { background:#5B8CFF; color:#fff; border:none; padding:12px 24px;
                           border-radius:8px; font-size:16px; cursor:pointer; }
                </style>
                </head>
                <body>
                  <h1>1XX1</h1>
                  <p>Node henüz başlatılmadı.<br>Ana ekrandan Node'u başlatın.</p>
                  <button onclick="location.reload()">Yeniden Dene</button>
                </body>
                </html>
                """.trimIndent(),
                "text/html", "UTF-8"
            )
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        bridge.fetchHealth()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

/**
 * JavaScript → Android köprüsü
 * Web sayfasından Android özelliklerine erisim
 */
class X1XXJsBridge(
    private val context: Context,
    private val bridge:  NodeBridge
) {
    /** Web'den snapshot al */
    @JavascriptInterface
    fun takeSnapshot() {
        bridge.takeSnapshot { ok, result ->
            android.util.Log.d("X1XX", "Snapshot: $ok — $result")
        }
    }

    /** Node durumunu al */
    @JavascriptInterface
    fun getNodeStatus(): String {
        val s = bridge.getStatus()
        return """{"running":${s.running},"nodeId":"${s.nodeId}","pulse":${s.pulseNumber},"peers":${s.peerCount}}"""
    }

    /** Mesh peer listesi */
    @JavascriptInterface
    fun getPeers(): String {
        return """{"peers":[]}"""
    }

    /** Bildirim gönder */
    @JavascriptInterface
    fun notify(title: String, message: String) {
        android.util.Log.d("X1XX", "Notify: $title — $message")
    }
}
