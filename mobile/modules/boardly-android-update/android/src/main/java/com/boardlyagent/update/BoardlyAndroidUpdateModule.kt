package com.boardlyagent.update

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.HttpsURLConnection

class UpdateFileProvider : FileProvider()

class BoardlyAndroidUpdateModule : Module() {
  private val generation = AtomicLong(0)
  private val lock = Any()
  private data class Prepared(val file: File, val generation: Long)
  private var prepared: Prepared? = null
  private val context get() = requireNotNull(appContext.reactContext) { "Android context unavailable" }

  override fun definition() = ModuleDefinition {
    Name("BoardlyAndroidUpdate")
    AsyncFunction("prepare") { sessionToken: String, metadata: String ->
      prepare(sessionToken, metadata)
    }.runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("discard") {
      synchronized(lock) {
        generation.incrementAndGet()
        prepared?.file?.delete()
        prepared = null
      }
    }
    AsyncFunction("install") {
      synchronized(lock) {
        val item = requireNotNull(prepared) { "Download and verify the update first" }
        check(item.generation == generation.get() && item.file.isFile) { "Update expired" }
        val activity = requireNotNull(appContext.currentActivity) { "Return to Boardly to install" }
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName)))
          "permission_required"
        } else {
          val uri = FileProvider.getUriForFile(context, context.packageName + ".boardlyupdates", item.file)
          activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
          "installer_opened"
        }
      }
    }.runOnQueue(Queues.MAIN)
  }

  @Suppress("DEPRECATION")
  private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet() ?: emptySet()
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun integer(value: JSONObject, key: String): Long {
    val raw = value.get(key)
    require(raw is Number) { "Invalid release metadata" }
    val number = raw.toDouble()
    require(number.isFinite() && number == raw.toLong().toDouble()) { "Invalid release metadata" }
    return raw.toLong()
  }

  @Suppress("DEPRECATION")
  private fun prepare(sessionToken: String, metadata: String) {
    require(sessionToken.isNotBlank() && sessionToken.length <= 16384 && sessionToken.none { it.code == 13 || it.code == 10 }) { "Sign in again" }
    require(metadata.length <= 8192) { "Invalid release metadata" }
    val release = JSONObject(metadata)
    val version = release.getString("version")
    val expectedHash = release.getString("sha256")
    val expectedSize = integer(release, "size")
    val expectedCode = integer(release, "version_code")
    require(version.matches(Regex("[0-9]+[.][0-9]+[.][0-9]+")) && expectedHash.matches(Regex("[a-f0-9]{64}"))) { "Invalid release metadata" }
    require(expectedSize in 1..300000000 && expectedCode in 1..2100000000) { "Invalid release metadata" }
    require(release.getString("download_url") == "/api/mobile/android/apk") { "Untrusted update endpoint" }
    val ctx = context
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val installed = ctx.packageManager.getPackageInfo(ctx.packageName, flags)
    require(expectedCode >= code(installed)) { "Installed app is newer than this release" }
    val current = synchronized(lock) {
      prepared?.file?.delete()
      prepared = null
      generation.incrementAndGet()
    }
    val directory = File(ctx.cacheDir, "boardly-verified-updates").apply { mkdirs() }
    check(directory.isDirectory && directory.usableSpace > expectedSize + 10485760) { "Not enough space for this update" }
    val file = File(directory, UUID.randomUUID().toString() + ".apk")
    val connection = URL("https://boardlyagent.com/api/mobile/android/apk").openConnection() as HttpsURLConnection
    var retained = false
    try {
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 15000
      connection.readTimeout = 30000
      connection.setRequestProperty("Authorization", "Bearer " + sessionToken)
      connection.setRequestProperty("Accept-Encoding", "identity")
      check(connection.responseCode == 200) { "Update download unavailable; sign in and try again" }
      check(connection.contentLengthLong < 0 || connection.contentLengthLong == expectedSize) { "Release changed; check for updates again" }
      val hash = MessageDigest.getInstance("SHA-256")
      val deadline = System.nanoTime() + 300000000000L
      var count = 0L
      connection.inputStream.use { input ->
        file.outputStream().use { output ->
          val buffer = ByteArray(65536)
          while (true) {
            check(current == generation.get()) { "Update cancelled" }
            check(System.nanoTime() < deadline) { "Update download timed out" }
            val n = input.read(buffer)
            if (n < 0) break
            count += n
            check(count <= expectedSize) { "Update exceeds expected size" }
            hash.update(buffer, 0, n)
            output.write(buffer, 0, n)
          }
        }
      }
      check(count == expectedSize && hex(hash.digest()) == expectedHash) { "Update checksum verification failed" }
      val archive = requireNotNull(ctx.packageManager.getPackageArchiveInfo(file.absolutePath, flags)) { "Invalid Android package" }
      check(archive.packageName == ctx.packageName && code(archive) == expectedCode && archive.versionName == version) { "Wrong app or version" }
      val trusted = signers(installed)
      check(trusted.isNotEmpty() && signers(archive) == trusted) { "Update signing certificate does not match" }
      synchronized(lock) {
        check(current == generation.get()) { "Update cancelled" }
        prepared = Prepared(file, current)
        retained = true
      }
    } finally {
      connection.disconnect()
      if (!retained) file.delete()
    }
  }
}
