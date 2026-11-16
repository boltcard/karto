package tech.whitewolf.karto.cardnative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.Base64
import android.util.Log
import android.util.Size
import android.view.View
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.min
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

private const val TAG = "CardCamera"

/** The resolutions asked of CameraX: the analysed frames, and the shot. */
private val ANALYSIS_SIZE = Size(1280, 960)
private val SHOT_SIZE = Size(1920, 1440)
/** The analysed frames' width once cropped and upright (570 on the Pixel): the shot is searched at about this. */
private const val ANALYSIS_WIDTH = 576

/**
 * The card camera: a preview with
 * the card-shaped frame, the dimming around it and the found edges drawn over
 * it; each analysed frame goes to CardEdges on a background thread, and
 * takePhoto() makes the card's thumbnail from an in-memory shot. Preview,
 * analysis and shot share the PreviewView's viewport, so the frame is the same
 * area in all three. The camera permission is the screen's to ask for.
 */
class CardCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFound by EventDispatcher<Map<String, Boolean>>()
  private val onError by EventDispatcher<Map<String, String>>()

  // A TextureView, as the QR scanner's: a SurfaceView sits behind React Native's opaque screens.
  // FILL_CENTER (the default) is the scale whose viewport is what is shown.
  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val overlay = CardOverlay(context)

  /** The frame: its width as a fraction of the view's, and its centre's fraction of the way down (props from cardphoto). */
  var frameWidth = 0.86
    set(v) {
      field = v
      overlay.invalidate()
    }
  var frameCentreY = 0.45
    set(v) {
      field = v
      overlay.invalidate()
    }

  /** The analysis and capture thread, for as long as the view is attached; binding again reuses it. */
  @Volatile private var analysis: ExecutorService? = null
  @Volatile private var provider: ProcessCameraProvider? = null
  @Volatile private var capture: ImageCapture? = null
  private var camera: Camera? = null
  private var boundSize: Pair<Int, Int>? = null
  /** Bumped by each bind, so a provider that answers after a later bind (or a detach) is ignored. */
  private var binds = 0
  private val steady = Steady()
  /** The outline shown, as fractions of the viewport; read by takePhoto. */
  @Volatile private var outline: List<Double>? = null
  private var found = false
  private var frames = 0

  init {
    addView(previewView)
    addView(overlay)
  }

  // As the QR scanner: React Native ignores child layout requests, so Android lays out this view's children.
  override val shouldUseAndroidLayout = true

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    measureChild(overlay, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(resolveSize(previewView.measuredWidth, widthMeasureSpec), resolveSize(previewView.measuredHeight, heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    previewView.layout(0, 0, r - l, b - t)
    overlay.layout(0, 0, r - l, b - t)
    // The viewport is null until the preview has a size: bind at the first layout with one, and again if it changes.
    val size = (r - l) to (b - t)
    if (size.first > 0 && size.second > 0 && size != boundSize && isAttachedToWindow) {
      boundSize = size
      post { bind() }
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (analysis == null) analysis = Executors.newSingleThreadExecutor()
    if (width > 0 && height > 0 && boundSize == null) {
      boundSize = width to height
      post { bind() }
    }
  }

  override fun onDetachedFromWindow() {
    binds++
    (appContext.currentActivity as? LifecycleOwner)?.let { camera?.cameraInfo?.cameraState?.removeObservers(it) }
    // Unbinding aborts a shot in progress through the executor, so it is shut down only after.
    provider?.unbindAll()
    camera = null
    capture = null
    analysis?.shutdown()
    analysis = null
    boundSize = null
    super.onDetachedFromWindow()
  }

  private fun bind() {
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val viewPort = previewView.viewPort ?: return
    val executor = analysis ?: return
    val bind = ++binds
    appContext.mainQueue.launch {
      try {
        val p = ProcessCameraProvider.awaitInstance(context)
        if (bind != binds) return@launch // detached or bound again meanwhile
        provider = p
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analyzer = ImageAnalysis.Builder()
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setResolutionSelector(resolution(ANALYSIS_SIZE))
          .build()
        val planes = Planes()
        analyzer.setAnalyzer(executor) { image -> analyse(image, planes) }
        val shot = ImageCapture.Builder()
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setResolutionSelector(resolution(SHOT_SIZE))
          .build()
        val group = UseCaseGroup.Builder().setViewPort(viewPort).addUseCase(preview).addUseCase(analyzer).addUseCase(shot).build()
        p.unbindAll()
        camera?.cameraInfo?.cameraState?.removeObservers(owner)
        val c = p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, group)
        camera = c
        capture = shot
        // A camera another app holds, or one turned off, is reported later, as the camera's state.
        var reported = false
        c.cameraInfo.cameraState.observe(owner) { state ->
          val reason = state.error?.let { cameraTrouble(it.code) }
          if (reason != null && !reported && bind == binds) {
            reported = true
            onError(mapOf("message" to reason))
          }
        }
        Log.d(TAG, "camera bound at ${boundSize?.first}x${boundSize?.second}")
      } catch (e: Exception) {
        Log.w(TAG, "camera didn't start", e)
        onError(mapOf("message" to (e.message ?: e.javaClass.simpleName)))
      }
    }
  }

  /** The camera's errors that stop it for good, in words; null for those CameraX recovers from by itself. */
  private fun cameraTrouble(code: Int): String? = when (code) {
    CameraState.ERROR_CAMERA_IN_USE, CameraState.ERROR_MAX_CAMERAS_IN_USE -> "another app is using the camera"
    CameraState.ERROR_CAMERA_DISABLED -> "the camera is turned off for apps"
    CameraState.ERROR_DO_NOT_DISTURB_MODE_ENABLED -> "Do Not Disturb is on"
    CameraState.ERROR_CAMERA_FATAL_ERROR -> "the camera stopped working"
    else -> null
  }

  private fun resolution(size: Size) = ResolutionSelector.Builder()
    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
    .setResolutionStrategy(ResolutionStrategy(size, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
    .build()

  /**
   * The analyser's planes, kept from frame to frame so a frame makes no garbage: a set for each bind, used only on
   * that bind's one thread, so a frame still finishing after a detach never writes into the next bind's, and let go
   * with the bind.
   */
  private class Planes {
    var y: ByteArray? = null
    var cb: ByteArray? = null
    var cr: ByteArray? = null
  }

  private fun analyse(image: ImageProxy, planes: Planes) {
    try {
      val started = System.nanoTime()
      val (y, u, v) = image.planes
      val crop = image.cropRect
      val turn = image.imageInfo.rotationDegrees
      // Copied (cropped and turned upright) before the frame is closed: its buffers go back to the camera.
      val luma = Luma.fromPlane(y.buffer, y.rowStride, crop.left, crop.top, crop.right, crop.bottom, turn, into = planes.y)
      val colour = Chroma.fromPlanes(u.buffer, v.buffer, u.rowStride, u.pixelStride, crop.left, crop.top, crop.right, crop.bottom, turn, cbInto = planes.cb, crInto = planes.cr)
      planes.y = luma.pixels
      planes.cb = colour.cb.pixels
      planes.cr = colour.cr.pixels
      val read = System.nanoTime()
      val q = CardEdges.find(luma, Box.frame(luma.width, luma.height, frameWidth, frameCentreY), colour)
      val shown = steady.add(q)?.fractions(luma.width, luma.height)
      outline = shown
      if (frames++ % 30 == 0) Log.d(TAG, "frame $frames: ${luma.width}x${luma.height}, planes read in ${(read - started) / 1_000_000} ms, ${(System.nanoTime() - started) / 1_000_000} ms, card ${q != null}")
      post {
        overlay.invalidate()
        if ((shown != null) != found) {
          found = shown != null
          onFound(mapOf("found" to found))
        }
      }
    } finally {
      image.close()
    }
  }

  /** The shot's thumbnail as base64, and where its corners came from: the shot, the outline shown, or the frame. */
  suspend fun takePhoto(): Map<String, String> {
    val shot = capture ?: throw CaptureException("the camera isn't ready")
    val executor = analysis ?: throw CaptureException("the camera isn't ready")
    val shownAtPress = outline
    val image = suspendCancellableCoroutine<ImageProxy> { cont ->
      shot.takePicture(executor, object : ImageCapture.OnImageCapturedCallback() {
        override fun onCaptureSuccess(image: ImageProxy) {
          cont.resume(image)
        }

        override fun onError(e: ImageCaptureException) {
          cont.resumeWithException(if (e.imageCaptureError == ImageCapture.ERROR_CAMERA_CLOSED) CameraClosedException() else CaptureException(e.message ?: "the shot failed"))
        }
      })
    }
    return withContext(Dispatchers.Default) {
      val upright = image.use { upright(it) }
      try {
        val (q, source) = corners(upright, shownAtPress)
        Log.d(TAG, "shot ${upright.width}x${upright.height}: corners from the $source")
        mapOf("jpeg" to Base64.encodeToString(CardThumb.make(upright, q), Base64.NO_WRAP), "source" to source)
      } finally {
        upright.recycle()
      }
    }
  }

  /** The in-memory JPEG decoded as stored (BitmapFactory ignores its EXIF orientation), cropped to the viewport, turned upright. */
  private fun upright(image: ImageProxy): Bitmap {
    val stored = image.toBitmap()
    val crop = image.cropRect
    val turn = Matrix().apply { postRotate(image.imageInfo.rotationDegrees.toFloat()) }
    return Bitmap.createBitmap(stored, crop.left, crop.top, crop.width(), crop.height(), turn, true).also { if (it !== stored) stored.recycle() }
  }

  /** The card's corners in the shot: found again there; else the outline that was shown; else the frame. */
  private fun corners(shot: Bitmap, shown: List<Double>?): Pair<Quad, String> {
    // A copy in brightness and colour at the analysed frames' width, the size CardEdges's numbers are tuned at.
    val w = min(shot.width, ANALYSIS_WIDTH)
    val h = shot.height * w / shot.width
    val small = if (w == shot.width) shot else Bitmap.createScaledBitmap(shot, w, h, true)
    val argb = IntArray(w * h)
    small.getPixels(argb, 0, w, 0, 0, w, h)
    if (small !== shot) small.recycle()
    val luma = Luma.fromArgb(argb, w, h)
    val colour = Chroma.fromArgb(argb, w, h)
    val back = shot.width.toDouble() / w
    CardEdges.find(luma, Box.frame(w, h, frameWidth, frameCentreY), colour)?.let { return it.scaled(back, back) to "shot" }
    if (shown != null) return Quad.ofFractions(shown, shot.width, shot.height) to "outline"
    return Box.frame(shot.width, shot.height, frameWidth, frameCentreY).quad() to "frame"
  }

  /** The dimming outside the frame, the frame's outline, and the found edges in green. */
  private inner class CardOverlay(context: Context) : View(context) {
    private val dp = resources.displayMetrics.density
    private val dim = Paint().apply { color = Color.argb(115, 0, 0, 0) }
    private val frameLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 2.5f * dp
      color = Color.WHITE
    }
    private val edgeLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 3f * dp
      strokeJoin = Paint.Join.ROUND
      color = Color.rgb(0x3f, 0xb9, 0x50)
    }

    override fun onDraw(canvas: Canvas) {
      val f = Box.frame(width, height, frameWidth, frameCentreY)
      val rect = RectF(f.left.toFloat(), f.top.toFloat(), f.right.toFloat(), f.bottom.toFloat())
      // A CR80 card's corner: 3.18 mm of its 54 mm height.
      val r = (f.height * 3.18 / 54).toFloat()
      val outside = Path().apply {
        fillType = Path.FillType.EVEN_ODD
        addRect(0f, 0f, width.toFloat(), height.toFloat(), Path.Direction.CW)
        addRoundRect(rect, r, r, Path.Direction.CW)
      }
      canvas.drawPath(outside, dim)
      val shown = outline
      frameLine.alpha = if (shown != null) 140 else 255
      canvas.drawRoundRect(rect, r, r, frameLine)
      if (shown != null) {
        val q = Quad.ofFractions(shown, width, height)
        val edges = Path().apply {
          moveTo(q.tl.x.toFloat(), q.tl.y.toFloat())
          lineTo(q.tr.x.toFloat(), q.tr.y.toFloat())
          lineTo(q.br.x.toFloat(), q.br.y.toFloat())
          lineTo(q.bl.x.toFloat(), q.bl.y.toFloat())
          close()
        }
        canvas.drawPath(edges, edgeLine)
      }
    }
  }
}
