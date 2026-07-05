package com.kaptan.x1xx.runtime

import android.content.Context
import android.util.Log
import com.kaptan.x1xx.bridge.NodeBridge
import java.io.File
import java.io.FileOutputStream

/**
 * NodeRuntimeLauncher
 *
 * 1. assets/nodejs/ klasoründen Node.js binary'yi cihaza kopyalar
 * 2. assets/1xx1/ klasoründen 1XX1 TypeScript dosyalarini kopyalar
 * 3. Node.js process'i baslatir:
 *    node --experimental-strip-types main.ts
 * 4. localhost:1331 hazir olunca onReady callback'ini cagirir
 *
 * Node.js binary Android icin:
 *   arm64-v8a: assets/nodejs/arm64/node
 *   x86_64:    assets/nodejs/x86_64/node
 */
class NodeRuntimeLauncher(
    private val context: Context,
    private val bridge:  NodeBridge
) {
    companion object {
        const val TAG      = "NodeRuntimeLauncher"
        const val PORT     = 1331
    }

    private var process: Process? = null
    private var logThread: Thread? = null

    fun start(onReady: (Int) -> Unit, onError: (String) -> Unit) {
        Thread {
            try {
                // 1. Node binary'yi kopyala
                val nodeFile = extractNodeBinary()
                if (nodeFile == null) {
                    onError("Node.js binary bulunamadi")
                    return@Thread
                }

                // 2. 1XX1 dosyalarini kopyala
                val appDir = extractAppFiles()

                // 3. Process baslat
                bridge.log("[LAUNCHER] Node.js baslatiliyor: $appDir")

                val pb = ProcessBuilder(
                    nodeFile.absolutePath,
                    "--experimental-strip-types",
                    "main.ts"
                )
                pb.directory(appDir)
                pb.environment().apply {
                    put("X1_UI_PORT",  PORT.toString())
                    put("X1_NODE_ID",  "android-${android.os.Build.MODEL.replace(" ", "-")}")
                    put("X1_NO_BROWSER", "true")
                    put("HOME", context.filesDir.absolutePath)
                }
                pb.redirectErrorStream(true)

                process = pb.start()

                // 4. Log akisini oku
                logThread = Thread {
                    process?.inputStream?.bufferedReader()?.useLines { lines ->
                        lines.forEach { line ->
                            bridge.log(line)
                            Log.d(TAG, line)

                            // Port hazir oldugunda bridge'i bildir
                            if (line.contains("ÇALIŞIYOR") || line.contains("localhost:$PORT")) {
                                bridge.setRunning(PORT)
                                onReady(PORT)
                            }
                        }
                    }
                }
                logThread?.start()

                // Process bitince
                val exitCode = process?.waitFor() ?: -1
                bridge.log("[LAUNCHER] Node process sona erdi: $exitCode")
                bridge.setStopped()

            } catch (e: Exception) {
                Log.e(TAG, "Baslatma hatasi", e)
                onError(e.message ?: "Bilinmeyen hata")
                bridge.setStopped()
            }
        }.start()
    }

    fun stop() {
        process?.destroy()
        process = null
        logThread?.interrupt()
        logThread = null
        bridge.setStopped()
    }

    // ─── Asset Kopyalama ─────────────────────────────────────────────────────

    private fun extractNodeBinary(): File? {
        // ABI'ye gore dogru binary sec
        val abi = android.os.Build.SUPPORTED_ABIS.firstOrNull()
            ?.replace("-", "_") ?: "arm64_v8a"

        val assetPath = when {
            abi.contains("arm64") -> "nodejs/arm64/node"
            abi.contains("x86_64") -> "nodejs/x86_64/node"
            else -> "nodejs/arm64/node" // varsayilan
        }

        val outFile = File(context.filesDir, "node")

        return try {
            context.assets.open(assetPath).use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            }
            outFile.setExecutable(true)
            bridge.log("[LAUNCHER] Node binary kopyalandi: ${outFile.absolutePath}")
            outFile
        } catch (e: Exception) {
            // Asset yoksa — Termux'un node'unu dene
            bridge.log("[LAUNCHER] Asset bulunamadi, sistem node'u aranıyor...")
            findSystemNode()
        }
    }

    private fun findSystemNode(): File? {
        val paths = listOf(
            "/data/data/com.termux/files/usr/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/node"
        )
        return paths.map { File(it) }.firstOrNull { it.exists() && it.canExecute() }
    }

    private fun extractAppFiles(): File {
        val appDir = File(context.filesDir, "1xx1")
        appDir.mkdirs()

        // assets/1xx1/ klasoründeki tum dosyalari kopyala
        copyAssetDir("1xx1", appDir)

        bridge.log("[LAUNCHER] 1XX1 dosyalari kopyalandi: ${appDir.absolutePath}")
        return appDir
    }

    private fun copyAssetDir(assetPath: String, outDir: File) {
        try {
            val list = context.assets.list(assetPath) ?: return
            if (list.isEmpty()) {
                // Dosya
                val outFile = outDir
                context.assets.open(assetPath).use { input ->
                    FileOutputStream(outFile).use { output ->
                        input.copyTo(output)
                    }
                }
            } else {
                // Klasor
                outDir.mkdirs()
                for (item in list) {
                    copyAssetDir("$assetPath/$item", File(outDir, item))
                }
            }
        } catch (_: Exception) {}
    }
}
