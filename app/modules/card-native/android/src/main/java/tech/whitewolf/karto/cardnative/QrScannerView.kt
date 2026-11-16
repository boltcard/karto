package tech.whitewolf.karto.cardnative

import android.content.Context
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.launch

/**
 * A camera preview that reads QR codes: each
 * frame's Y plane goes to ZXing on a background thread, and the first code read
 * is sent once as onCode. The camera permission is the screen's to ask for.
 */
private const val TAG = "CardScan"

class QrScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCode by EventDispatcher<Map<String, String>>()
  // A TextureView, not the default SurfaceView: a SurfaceView sits behind the
  // window, where React Native's opaque screens hide it.
  private val previewView = PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
  private val sent = AtomicBoolean(false)
  private var analysis: ExecutorService? = null
  private var provider: ProcessCameraProvider? = null
  private var frames = 0

  init {
    addView(previewView)
  }

  // The preview adds its TextureView when CameraX asks for a surface, and asks
  // for a layout then; React Native ignores child layout requests, which left
  // the TextureView at 0x0 with no surface ("Failed to get Surfaces"). Let
  // Android lay out this view's children.
  override val shouldUseAndroidLayout = true

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(resolveSize(previewView.measuredWidth, widthMeasureSpec), resolveSize(previewView.measuredHeight, heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    previewView.layout(0, 0, r - l, b - t)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    start()
  }

  override fun onDetachedFromWindow() {
    provider?.unbindAll()
    analysis?.shutdown()
    analysis = null
    super.onDetachedFromWindow()
  }

  private fun start() {
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val executor = Executors.newSingleThreadExecutor().also { analysis = it }
    appContext.mainQueue.launch {
      val p = ProcessCameraProvider.awaitInstance(context)
      if (analysis !== executor) return@launch // detached meanwhile
      provider = p
      val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
      val analyzer = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
      analyzer.setAnalyzer(executor) { image ->
        try {
          if (frames++ % 30 == 0) Log.d(TAG, "frame $frames: ${image.width}x${image.height}")
          if (!sent.get()) {
            val y = image.planes[0]
            // Copied before the frame is closed: its buffer goes back to the camera.
            val luma = QrDecoder.luma(y.buffer, y.rowStride, image.width, image.height)
            QrDecoder.decode(luma, image.width, image.height)?.let { text ->
              if (sent.compareAndSet(false, true)) post { onCode(mapOf("text" to text)) }
            }
          }
        } finally {
          image.close()
        }
      }
      p.unbindAll()
      p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analyzer)
      Log.d(TAG, "camera bound")
    }
  }
}
