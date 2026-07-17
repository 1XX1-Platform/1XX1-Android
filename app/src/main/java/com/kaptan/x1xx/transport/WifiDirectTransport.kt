package com.kaptan.x1xx.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.*
import android.os.Handler
import android.os.HandlerThread
import com.kaptan.x1xx.bridge.NodeBridge
import kotlinx.coroutines.*

class WifiDirectTransport(private val context: Context) {

    private var manager: WifiP2pManager? = null
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val handlerThread = HandlerThread("WifiDirectHandler")
    private var isRunning = false

    companion object {
        val intentFilter = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
        }
    }

    fun start() {
        if (isRunning) return
        scope.launch(Dispatchers.Main) {
            try {
                handlerThread.start()
                val handler = Handler(handlerThread.looper)
                manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
                channel = manager?.initialize(context, handlerThread.looper, null)
                receiver = WifiDirectReceiver()
                context.registerReceiver(receiver, intentFilter)
                isRunning = true
                NodeBridge.instance.log("[P2P] WiFi Direct baslatildi")
                // 2 saniye bekle sonra tara
                scope.launch { delay(2000); discoverPeers() }
            } catch (e: Exception) {
                NodeBridge.instance.log("[P2P] Baslama hatasi: ${e.message}")
            }
        }
    }

    fun stop() {
        if (!isRunning) return
        try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
        try { manager?.removeGroup(channel, null) } catch (_: Exception) {}
        try { handlerThread.quitSafely() } catch (_: Exception) {}
        scope.cancel()
        isRunning = false
    }

    private fun discoverPeers() {
        if (!isRunning) return
        val mgr = manager ?: return
        val ch = channel ?: return
        mgr.discoverPeers(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                NodeBridge.instance.log("[P2P] Tarama basladi")
            }
            override fun onFailure(reason: Int) {
                // Sessiz retry
                scope.launch { delay(60_000); discoverPeers() }
            }
        })
    }

    private fun connectToPeer(device: WifiP2pDevice) {
        val mgr = manager ?: return
        val ch = channel ?: return
        val config = WifiP2pConfig().apply {
            deviceAddress = device.deviceAddress
            wps.setup = android.net.wifi.WpsInfo.PBC
        }
        mgr.connect(ch, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                NodeBridge.instance.log("[P2P] Baglanti istegi: ${device.deviceName}")
            }
            override fun onFailure(reason: Int) {
                if (reason != 2) NodeBridge.instance.log("[P2P] Baglanti hatasi: $reason")
            }
        })
    }

    private fun requestConnectionInfo() {
        val mgr = manager ?: return
        val ch = channel ?: return
        mgr.requestConnectionInfo(ch) { info ->
            if (info == null || !info.groupFormed) return@requestConnectionInfo
            val ip = info.groupOwnerAddress?.hostAddress ?: return@requestConnectionInfo
            val isOwner = info.isGroupOwner
            NodeBridge.instance.log("[P2P] Grup kuruldu - GO: $ip - Ben GO: $isOwner")
            scope.launch {
                delay(2000)
                notifyNodeJS(ip)
            }
        }
    }

    private fun notifyNodeJS(peerIp: String) {
        scope.launch {
            try {
                val port = NodeBridge.instance.getStatus().port
                val client = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                    .build()
                val req = okhttp3.Request.Builder()
                    .url("http://localhost:$port/admin/add-peer?ip=$peerIp")
                    .post(okhttp3.RequestBody.create(null, ByteArray(0)))
                    .build()
                client.newCall(req).execute().use { res ->
                    if (res.isSuccessful)
                        NodeBridge.instance.log("[P2P] Peer bildirildi: $peerIp")
                }
            } catch (e: Exception) {
                NodeBridge.instance.log("[P2P] Bildirim hatasi: ${e.message}")
            }
        }
    }

    inner class WifiDirectReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                    val state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                    if (state != WifiP2pManager.WIFI_P2P_STATE_ENABLED) {
                        NodeBridge.instance.log("[P2P] WiFi Direct kapali")
                    }
                }
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> {
                    manager?.requestPeers(channel) { peerList ->
                        val peers = peerList.deviceList
                        if (peers.isNotEmpty()) {
                            NodeBridge.instance.log("[P2P] ${peers.size} cihaz bulundu")
                            peers.forEach { device ->
                                NodeBridge.instance.log("[P2P] Cihaz: ${device.deviceName}")
                                connectToPeer(device)
                            }
                        }
                    }
                }
                WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                    val networkInfo = intent.getParcelableExtra<android.net.NetworkInfo>(
                        WifiP2pManager.EXTRA_NETWORK_INFO
                    )
                    if (networkInfo?.isConnected == true) {
                        requestConnectionInfo()
                    } else {
                        scope.launch { delay(10_000); discoverPeers() }
                    }
                }
                WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION -> { /* sessiz */ }
            }
        }
    }
}
