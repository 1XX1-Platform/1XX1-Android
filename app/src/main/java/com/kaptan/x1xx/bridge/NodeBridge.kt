package com.kaptan.x1xx.bridge

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * NodeBridge — Android ile Node.js runtime arasindaki kopru.
 *
 * Node.js localhost:1331'de calisir.
 * Android bu sinif uzerinden:
 *   - Durum sorgular (/health)
 *   - Log alir (SSE /events)
 *   - Komut gonderir (POST /admin/ *)
 */
class NodeBridge private constructor() {

    companion object {
        val instance = NodeBridge()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
         private val sseClient = OkHttpClient.Builder()
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.SECONDS)
    .build()
    private val logListeners = mutableListOf<(String) -> Unit>()
    private var sseCall: Call? = null
    @Volatile private var sseGeneration = 0

    // Mevcut durum
    data class NodeStatus(
        val running:     Boolean = false,
        val nodeId:      String  = "—",
        val pulseNumber: Long    = 0,
        val peerCount:   Int     = 0,
        val port:        Int     = 1331
    )

    @Volatile private var _status = NodeStatus()

    fun getStatus(): NodeStatus = _status

    fun setRunning(port: Int) {
        _status = _status.copy(running = true, port = port)
        fetchHealth(port)
        startSSE(port)
    }

    fun setStopped() {
        _status = NodeStatus(running = false)
        sseCall?.cancel()
        sseCall = null
    }

    // ─── Health sorgusu ───────────────────────────────────────────────────────

    fun fetchHealth(port: Int = _status.port) {
        val req = Request.Builder()
            .url("http://localhost:$port/health")
            .build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                log("[BRIDGE] Health sorgusu basarisiz: ${e.message}")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) return
                    val json = JSONObject(it.body?.string() ?: return)
                    _status = _status.copy(
                        running     = true,
                        nodeId      = json.optString("nodeId", "—"),
                        pulseNumber = maxOf(_status.pulseNumber, json.optLong("pulse", 0)),
                        peerCount   = json.optInt("peers", 0),
                        port        = port
                    )
                }
            }
        })
    }

    // ─── SSE — canli log akisi ────────────────────────────────────────────────

fun startSSE(port: Int = _status.port) {
		val myGen = ++sseGeneration
sseCall?.cancel()
val req = Request.Builder()
.url("http://localhost:$port/events")
.addHeader("Accept", "text/event-stream")
.build()

sseCall = sseClient.newCall(req)
sseCall?.enqueue(object : Callback {
override fun onFailure(call: Call, e: IOException) {
log("[BRIDGE] SSE baglantisi koptu: ${e.message}")
        if (myGen != sseGeneration) return
if (_status.running) {
Thread {
Thread.sleep(2000)
startSSE(port)
}.start()
}
}
override fun onResponse(call: Call, response: Response) {
response.body?.source()?.let { src ->
try {
while (!src.exhausted()) {
val line = src.readUtf8Line() ?: break
if (line.startsWith("data: ")) {
val data = line.removePrefix("data: ")
try {
val json = JSONObject(data)
val type = json.optString("type")
when (type) {
"pulse" -> {
val num = json.optJSONObject("data")?.optLong("number", 0) ?: 0
_status = _status.copy(pulseNumber = num)
}
"peer" -> fetchHealth(port)
"log" -> {
val msg = json.optJSONObject("data")?.optString("message", "") ?: ""
if (msg.isNotEmpty()) log("[NODE] $msg")
}
}
} catch (_: Exception) {}
}
}
} catch (e: Exception) {
log("[BRIDGE] SSE okuma hatasi: ${e.message}")
}
}
        if (myGen != sseGeneration) return
if (_status.running) {
Thread {
Thread.sleep(2000)
startSSE(port)
}.start()
}
}
})
}
    // ─── Snapshot al ──────────────────────────────────────────────────────────

    fun takeSnapshot(callback: (Boolean, String) -> Unit) {
        val req = Request.Builder()
            .url("http://localhost:${_status.port}/admin/snapshot")
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                callback(false, e.message ?: "Hata")
            }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string() ?: "{}"
                    callback(it.isSuccessful, body)
                }
            }
        })
    }

    // ─── Log ──────────────────────────────────────────────────────────────────

    fun log(message: String) {
        logListeners.forEach { it(message) }
    }

    fun onLog(listener: (String) -> Unit) {
        logListeners.add(listener)
    }
}
