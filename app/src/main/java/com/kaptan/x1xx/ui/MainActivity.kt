package com.kaptan.x1xx.ui

import com.kaptan.x1xx.R
import android.content.Intent
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.kaptan.x1xx.R
import com.kaptan.x1xx.bridge.NodeBridge
import com.kaptan.x1xx.browser.X1XXBrowserActivity
import com.kaptan.x1xx.service.NodeForegroundService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus:     TextView
    private lateinit var tvNodeId:     TextView
    private lateinit var tvPulse:      TextView
    private lateinit var tvPeers:      TextView
    private lateinit var tvLog:        TextView
    private lateinit var btnStart:     Button
    private lateinit var btnStop:      Button
    private lateinit var btnBrowser:   Button
    private lateinit var rgMode:       RadioGroup
    private lateinit var rbManual:     RadioButton
    private lateinit var rbAuto:       RadioButton
    private lateinit var rbBackground: RadioButton
    private lateinit var scrollLog:    ScrollView

    private val bridge = NodeBridge.instance

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus     = findViewById(R.id.tvStatus)
        tvNodeId     = findViewById(R.id.tvNodeId)
        tvPulse      = findViewById(R.id.tvPulse)
        tvPeers      = findViewById(R.id.tvPeers)
        tvLog        = findViewById(R.id.tvLog)
        btnStart     = findViewById(R.id.btnStart)
        btnStop      = findViewById(R.id.btnStop)
        btnBrowser   = findViewById(R.id.btnBrowser)
        rgMode       = findViewById(R.id.rgMode)
        rbManual     = findViewById(R.id.rbManual)
        rbAuto       = findViewById(R.id.rbAuto)
        rbBackground = findViewById(R.id.rbBackground)
        scrollLog    = findViewById(R.id.scrollLog)

        val prefs = getSharedPreferences("x1xx", MODE_PRIVATE)
        when (prefs.getInt("mode", 0)) {
            1 -> rbAuto.isChecked = true
            2 -> rbBackground.isChecked = true
            else -> rbManual.isChecked = true
        }

        rgMode.setOnCheckedChangeListener { _, checkedId ->
            prefs.edit().putInt("mode",
                when (checkedId) { R.id.rbAuto -> 1; R.id.rbBackground -> 2; else -> 0 }
            ).apply()
        }

        btnStart.setOnClickListener   { startNode() }
        btnStop.setOnClickListener    { stopNode() }
        btnBrowser.setOnClickListener { openBrowser() }
        btnBrowser.isEnabled = false

        if (rbAuto.isChecked || rbBackground.isChecked) startNode()

        lifecycleScope.launch {
            while (true) { updateUI(); delay(2000) }
        }

        bridge.onLog { line ->
            runOnUiThread {
                tvLog.append(line + "\n")
                scrollLog.post { scrollLog.fullScroll(ScrollView.FOCUS_DOWN) }
                val lines = tvLog.text.split("\n")
                if (lines.size > 200) tvLog.text = lines.takeLast(200).joinToString("\n")
                if (line.contains("1XX1 Platform") || line.contains("localhost:1331")) {
                    btnBrowser.isEnabled = true
                }
            }
        }
    }

    private fun startNode() {
        startForegroundService(
            Intent(this, NodeForegroundService::class.java).also {
                it.action = NodeForegroundService.ACTION_START
            }
        )
        btnStart.isEnabled = false
        btnStop.isEnabled  = true
        log("Node baslatiliyor...")
    }

    private fun stopNode() {
        startService(
            Intent(this, NodeForegroundService::class.java).also {
                it.action = NodeForegroundService.ACTION_STOP
            }
        )
        btnStart.isEnabled   = true
        btnStop.isEnabled    = false
        btnBrowser.isEnabled = false
        log("Node durduruldu")
    }

    private fun openBrowser() {
        startActivity(Intent(this, X1XXBrowserActivity::class.java))
    }

    private fun updateUI() {
        val s = bridge.getStatus()
        tvStatus.text = if (s.running) "● AKTIF" else "● OFFLINE"
        tvStatus.setTextColor(
            if (s.running) getColor(android.R.color.holo_green_light)
            else           getColor(android.R.color.holo_red_light)
        )
        tvNodeId.text = "Node: ${s.nodeId}"
        tvPulse.text  = "Pulse: #${s.pulseNumber}"
        tvPeers.text  = "Peers: ${s.peerCount}"
        if (s.running) btnBrowser.isEnabled = true
    }

    private fun log(msg: String) { tvLog.append("[APP] $msg\n") }
}
