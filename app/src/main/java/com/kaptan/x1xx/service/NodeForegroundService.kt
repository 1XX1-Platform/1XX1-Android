package com.kaptan.x1xx1.service

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.kaptan.x1xx.R
import com.kaptan.x1xx.bridge.NodeBridge
import com.kaptan.x1xx.runtime.NodeRuntimeLauncher
import com.kaptan.x1xx.ui.MainActivity

class NodeForegroundService : Service() {

    companion object {
        const val ACTION_START     = "com.kaptan.x1xx.START"
        const val ACTION_STOP      = "com.kaptan.x1xx.STOP"
        const val NOTIFICATION_ID  = 1331
        const val CHANNEL_ID       = "x1xx_node_channel"
    }

    private var launcher: NodeRuntimeLauncher? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForeground(NOTIFICATION_ID, buildNotification("Baslatiliyor..."))
                startRuntime()
            }
            ACTION_STOP -> {
                stopRuntime()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startRuntime() {
        val bridge = NodeBridge.instance
        launcher = NodeRuntimeLauncher(applicationContext, bridge)
        launcher?.start(
            onReady = { port ->
                bridge.log("[SERVICE] Node hazir: localhost:$port")
                updateNotification("Aktif — localhost:$port")
            },
            onError = { err ->
                bridge.log("[SERVICE] Hata: $err")
                updateNotification("Hata: $err")
            }
        )
    }

    private fun stopRuntime() {
        launcher?.stop()
        launcher = null
        NodeBridge.instance.log("[SERVICE] Node durduruldu")
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("1XX1 Node")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "1XX1 Node Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "1XX1 P2P node arka planda calisir"
        }
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopRuntime()
        super.onDestroy()
    }
}
