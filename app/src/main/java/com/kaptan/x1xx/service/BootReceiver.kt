package com.kaptan.x1xx.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences("x1xx", Context.MODE_PRIVATE)
        val mode  = prefs.getInt("mode", 0)

        // Auto (1) veya Background (2) modda ise boot'ta baslat
        if (mode == 1 || mode == 2) {
            val svc = Intent(context, NodeForegroundService::class.java)
            svc.action = NodeForegroundService.ACTION_START
            context.startForegroundService(svc)
        }
    }
}
