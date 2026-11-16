package tech.whitewolf.karto.cardnative

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** One connected tag: android.nfc.tech.IsoDep on the phone, a fake in tests. */
interface TagConnection {
  fun transceive(apdu: ByteArray): ByteArray
  fun close()
}

/** The tag is gone: it left the field, or its handle was closed. */
class TagGone(message: String) : Exception(message)

/** Connected tags by handle, for the JS side (src/native/nfc.ts). */
class NfcTags {
  private val tags = ConcurrentHashMap<Int, TagConnection>()
  private val nextHandle = AtomicInteger(1)

  fun add(tag: TagConnection): Int {
    val handle = nextHandle.getAndIncrement()
    tags[handle] = tag
    return handle
  }

  /** A lost tag (TagLostException, any IOException) is closed and reported as TagGone. */
  fun transceive(handle: Int, apdu: ByteArray): ByteArray {
    val tag = tags[handle] ?: throw TagGone("the card is no longer connected")
    return try {
      tag.transceive(apdu)
    } catch (e: IOException) {
      close(handle)
      throw TagGone(e.message ?: "the card was moved away")
    }
  }

  fun close(handle: Int) {
    tags.remove(handle)?.let { runCatching { it.close() } }
  }

  /** No card connected: none is being read. */
  fun isEmpty(): Boolean = tags.isEmpty()

  fun closeAll() {
    tags.keys.toList().forEach(::close)
  }
}

fun String.hexToBytes(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
