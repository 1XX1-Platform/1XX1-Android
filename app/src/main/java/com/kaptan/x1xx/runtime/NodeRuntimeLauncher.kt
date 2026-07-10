package com.kaptan.x1xx.runtime

import android.content.Context
import android.util.Log
import com.kaptan.x1xx.bridge.NodeBridge
import java.io.File
import java.io.FileOutputStream

/**
 * NodeRuntimeLauncher
 *
 * Node.js binary ve tum bagimli shared library'ler jniLibs/arm64-v8a/
 * altinda paketlenir (libnode.so, lib1xx1*.so). Android bunlari APK
 * kurulumu sirasinda calistirilabilir izinle nativeLibraryDir'e cikartir.
 * Bu sayede assets'ten kopyalama ve W^X kisitlamasi sorunu ortadan kalkar.
 *
 * 1. nativeLibraryDir/libnode.so dogrudan calistirilir
 * 2. LD_LIBRARY_PATH nativeLibraryDir'i gosterir (bagimli .so'lar icin)
 * 3. assets/1xx1/ klasoründen 1XX1 TypeScript dosyalari kopyalanir
 * 4. localhost:1331 hazir olunca onReady callback'i cagirilir
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
    @Volatile private var stopping = false

    fun start(onReady: (Int) -> Unit, onError: (String) -> Unit) {
        stopping = false
        Thread {
            try {
                // 1. Node binary'nin yolunu bul (nativeLibraryDir'den, kopyalama yok)
                val nativeLibDir = File(context.applicationInfo.nativeLibraryDir)
                val nodeFile = File(nativeLibDir, "libnode.so")

                if (!nodeFile.exists()) {
                    bridge.log("[LAUNCHER] libnode.so bulunamadi, sistem node'u aranıyor...")
                    val fallback = findSystemNode()
                    if (fallback == null) {
                        onError("Node.js binary bulunamadi")
                        return@Thread
                    }
                    runNode(fallback, nativeLibDir, onReady, onError)
                    return@Thread
                }

                bridge.log("[LAUNCHER] Node binary bulundu: ${nodeFile.absolutePath}")
                runNode(nodeFile, nativeLibDir, onReady, onError)

            } catch (e: Exception) {
                Log.e(TAG, "Baslatma hatasi", e)
                onError(e.message ?: "Bilinmeyen hata")
                bridge.setStopped()
            }
        }.start()
    }

    private fun runNode(
        nodeFile: File,
        libDir: File,
        onReady: (Int) -> Unit,
        onError: (String) -> Unit
    ) {
        try {
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
                put("LD_LIBRARY_PATH", libDir.absolutePath)
            }
            pb.redirectErrorStream(true)

            process = pb.start()
            if (stopping) { process?.destroyForcibly(); process = null; bridge.setStopped(); return }

            // 4. Log akisini oku
            var readyFired = false
logThread = Thread {
    process?.inputStream?.bufferedReader()?.useLines { lines ->
        lines.forEach { line ->
            bridge.log(line)
            Log.d(TAG, line)

            if (!readyFired && (line.contains("ÇALIŞIYOR") || line.contains("localhost:$PORT"))) {
                readyFired = true
                onReady(PORT)
            }
        }
    }
}
            logThread?.start()

            val exitCode = process?.waitFor() ?: -1
            bridge.log("[LAUNCHER] Node process sona erdi: $exitCode")
            bridge.setStopped()

        } catch (e: Exception) {
            Log.e(TAG, "Calistirma hatasi", e)
            onError(e.message ?: "Bilinmeyen hata")
            bridge.setStopped()
        }
    }

    fun stop() {
        stopping = true
        val p = process
        process = null
        logThread?.interrupt()
        logThread = null
        Thread {
            p?.destroy()
            
            if (p?.waitFor(2, java.util.concurrent.TimeUnit.SECONDS) != true) p?.destroyForcibly()
            p?.waitFor()
        }.start()
        bridge.setStopped()
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
        copyAssetDir("1xx1", appDir)
        bridge.log("[LAUNCHER] 1XX1 dosyalari kopyalandi: ${appDir.absolutePath}")
        return appDir
    }

    private fun copyAssetDir(assetPath: String, outDir: File) {
        try {
            val list = context.assets.list(assetPath) ?: return
            if (list.isEmpty()) {
                val outFile = outDir
                context.assets.open(assetPath).use { input ->
                    FileOutputStream(outFile).use { output ->
                        input.copyTo(output)
                    }
                }
            } else {
                outDir.mkdirs()
                for (item in list) {
                    copyAssetDir("$assetPath/$item", File(outDir, item))
                }
            }
        } catch (_: Exception) {}
    }
}
