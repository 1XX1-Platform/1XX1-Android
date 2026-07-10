package com.kaptan.x1xx.transport

import android.content.Context
import android.net.*
import com.kaptan.x1xx.bridge.NodeBridge
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet4Address
import java.util.concurrent.TimeUnit

class NetworkWatcher(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(2, TimeUnit.SECONDS)
        .build()

    private var cm: ConnectivityManager? = null
    private var cb: ConnectivityManager.NetworkCallback? = null

    fun start() {
        if (cb != null) return
        cm = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as ConnectivityManager
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        cb = object : ConnectivityManager.NetworkCallback() {
            override fun onLinkPropertiesChanged(n: Network, lp: LinkProperties) {
                val ip = lp.linkAddresses.map { it.address }
                    .firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
                    ?.hostAddress ?: return
                sendHint("lan", ip)
            }
            override fun onLost(n: Network) {
                NodeBridge.instance.log("[NET] Ag koptu")
            }
        }
        cm?.registerNetworkCallback(req, cb!!)
        NodeBridge.instance.log("[NET] NetworkWatcher aktif")
    }

    fun stop() {
        cb?.let { cm?.unregisterNetworkCallback(it) }
        cb = null
    }

    private fun sendHint(medium: String, ip: String) {
        val port = NodeBridge.instance.getStatus().port
        val req = Request.Builder()
            .url("http://localhost:$port/admin/net-hint?ip=$ip")
            .build()
        client.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(c: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(c: okhttp3.Call, r: okhttp3.Response) {
                r.close()
                NodeBridge.instance.log("[NET] Ipucu: $medium $ip")
            }
        })
    }
}
