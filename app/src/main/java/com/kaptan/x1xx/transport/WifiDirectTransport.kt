package com.kaptan.x1xx.transport

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.*
import android.os.Looper
import com.kaptan.x1xx.bridge.NodeBridge
import kotlinx.coroutines.*
import java.net.InetAddress

/**
 * WiFi Direct Transport — FAZ 3
 * Router olmadan cihazlar arasi direkt baglanti.
 *
 * Mimari:
 *   WifiP2pManager → peer kesfet
 *   Grup olustur (GO = Group Owner)
 *   Node.js'e /admin/add-peer ile bildir
 */
class WifiDirectTransport(private val context: Context) {

    private val manager: WifiP2pManager by lazy {
        context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
    }
    private lateinit var channel: WifiP2pManager.Channel
    private var receiver: BroadcastReceiver? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var isRunning = false
    private var groupOwnerAddress: InetAddress? = null

    companion object {
        const val PORT = 1331
        val intentFilter = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
        }
    }

    fun start() {
        if (isRunning) return
        channel = manager.initialize(context, Looper.getMainLooper(), null)
        receiver = WifiDirectReceiver()
        context.registerReceiver(receiver, intentFilter)
        isRunning = true
        NodeBridge.instance.log("[P2P] WiFi Direct baslatildi")
        discoverPeers()
    }

    fun stop() {
        if (!isRunning) return
        try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
        manager.removeGroup(channel, null)
        scope.cancel()
        isRunning = false
        NodeBridge.instance.log("[P2P] WiFi Direct durduruldu")
    }

    fun discoverPeers() {
        if (!isRunning) return
        manager.discoverPeers(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                NodeBridge.instance.log("[P2P] Peer arama basladi")
            }
            override fun onFailure(reason: Int) {
                NodeBridge.instance.log("[P2P] Peer arama hatasi: $reason")
                // 30 saniye sonra tekrar dene
                scope.launch { delay(30_000); discoverPeers() }
            }
        })
    }

    fun connectToPeer(device: WifiP2pDevice) {
        val config = WifiP2pConfig().apply {
            deviceAddress = device.deviceAddress
            wps.setup = android.net.wifi.WpsInfo.PBC
        }
        manager.connect(channel, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                NodeBridge.instance.log("[P2P] Baglanti istegi: ${device.deviceName}")
            }
            override fun onFailure(reason: Int) {
                NodeBridge.instance.log("[P2P] Baglanti hatasi: $reason")
            }
        })
    }

    fun requestConnectionInfo() {
        manager.requestConnectionInfo(channel) { info ->
            if (info == null || !info.groupFormed) return@requestConnectionInfo
            groupOwnerAddress = info.groupOwnerAddress
            val ip = info.groupOwnerAddress?.hostAddress ?: return@requestConnectionInfo
            val isOwner = info.isGroupOwner

            NodeBridge.instance.log("[P2P] Grup olustu - GO: $ip - Ben GO mu: $isOwner")

            // Node.js'e peer olarak bildir
            if (!isOwner) {
                // Biz istemciyiz, GO'ya baglan
                scope.launch {
                    delay(1000) // GO'nun hazir olmasi icin bekle
                    notifyNodeJS(ip)
                }
            }
        }
    }

    private fun notifyNodeJS(peerIp: String) {
        scope.launch {
            try {
                val port = NodeBridge.instance.getStatus().port
                val url = "http://localhost:$port/admin/add-peer?ip=$peerIp"
                val client = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                    .build()
                val req = okhttp3.Request.Builder().url(url)
                    .post(okhttp3.RequestBody.create(null, ByteArray(0)))
                    .build()
                client.newCall(req).execute().use { res ->
                    if (res.isSuccessful) {
                        NodeBridge.instance.log("[P2P] Node.js'e peer bildirildi: $peerIp")
                    }
                }
            } catch (e: Exception) {
                NodeBridge.instance.log("[P2P] Node.js bildirimi hatasi: ${e.message}")
            }
        }
    }

    inner class WifiDirectReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                    val state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                    val enabled = state == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                    NodeBridge.instance.log("[P2P] WiFi Direct: ${if (enabled) "AKTIF" else "KAPALI"}")
                }
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> {
                    manager.requestPeers(channel) { peerList ->
                        val peers = peerList.deviceList
                        NodeBridge.instance.log("[P2P] ${peers.size} cihaz bulundu")
                        peers.forEach { device ->
                            NodeBridge.instance.log("[P2P] Cihaz: ${device.deviceName} - ${device.deviceAddress}")
                            connectToPeer(device)
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
                        NodeBridge.instance.log("[P2P] Baglanti koptu")
                        // Yeniden ara
                        scope.launch { delay(5_000); discoverPeers() }
                    }
                }
                WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION -> {
                    val device = intent.getParcelableExtra<WifiP2pDevice>(
                        WifiP2pManager.EXTRA_WIFI_P2P_DEVICE
                    )
                    NodeBridge.instance.log("[P2P] Bu cihaz: ${device?.deviceName}")
                }
            }
        }
    }
}
