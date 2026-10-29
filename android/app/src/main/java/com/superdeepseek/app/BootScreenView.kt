package com.superdeepseek.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.SystemClock
import android.view.View
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * The launch screen, drawn on one Canvas in the chat's own dark palette.
 *
 * Scene: the page's dark background colour ([baseColor], sampled from the real
 * chat on an earlier run) with a soft vignette and a slow, quiet star field.
 * The app icon starts where the system splash left it (screen centre) and
 * glides up; the wordmark rises in as dim "ghost" letters and then **is the
 * progress indicator**: it fills with light from left to right while the page
 * loads, never completing on its own. [finish] fills it to the end, sweeps a
 * light across it and fades the scene out, then [onExitFinished] fires.
 *
 * Time comes from [SystemClock], not ValueAnimator, so the animation still plays
 * when the system "animator duration scale" is set to 0.
 */
@SuppressLint("ViewConstructor")
internal class BootScreenView(
    context: Context,
    private val title: String,
    brandTypeface: Typeface?,
    icon: Bitmap?,
    /** The chat's dark background; the scene is built on it. */
    private val baseColor: Int,
    /** The system splash colour; the scene eases from it so the hand-off is seamless. */
    private val splashColor: Int,
) : View(context) {

    /** Runs once on the UI thread after the exit animation has fully played. */
    var onExitFinished: (() -> Unit)? = null

    /** True once [finish] was called (the exit may still be playing). */
    val isFinishing: Boolean get() = finishAt >= 0f

    private val dp = resources.displayMetrics.density
    private var startMs = -1L
    private var finishAt = -1f
    private var exitReported = false

    // ── Paints and shaders (allocated once) ──
    private val vignettePaint = Paint()
    private val liftPaint = Paint()
    private val starPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val meteorPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = 1.2f * dp
        shader = LinearGradient(
            0f, 0f, UNIT_RADIUS, 0f,
            intArrayOf(0x00FFFFFF, 0xCCFFFFFF.toInt()),
            null,
            Shader.TileMode.CLAMP,
        )
    }
    private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = RadialGradient(
            0f, 0f, UNIT_RADIUS,
            intArrayOf(withAlpha(ACCENT, 0.16f), withAlpha(ACCENT, 0.05f), withAlpha(ACCENT, 0f)),
            floatArrayOf(0f, 0.45f, 1f),
            Shader.TileMode.CLAMP,
        )
    }
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val iconShader: BitmapShader? =
        icon?.let { BitmapShader(it, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
    private val iconBitmapSize = icon?.width?.toFloat() ?: 1f
    private val iconRimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * dp
        color = Color.WHITE
    }
    private val face = brandTypeface ?: Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
    /** Dim, not-yet-loaded letters. */
    private val ghostPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = face; color = Color.WHITE }
    /** Loaded part of the wordmark; its edge dissolves softly (no hard wipe line). */
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = face
        shader = LinearGradient(
            0f, 0f, UNIT_RADIUS, 0f,
            intArrayOf(TEXT, withAlpha(TEXT, 0f)),
            null,
            Shader.TileMode.CLAMP,
        )
    }
    /** Soft accent tint at the moving edge of the fill. */
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = face }
    /** Light that sweeps across the filled letters. */
    private val shinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = face
        shader = LinearGradient(
            -UNIT_RADIUS, 0f, UNIT_RADIUS, 0f,
            intArrayOf(0x00FFFFFF, 0xE6FFFFFF.toInt(), 0x00FFFFFF),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    private val m = Matrix()
    private val rect = RectF()

    // ── Layout (computed in onSizeChanged) ──
    private var textWidth = 0f
    private var textAscent = 0f
    private var textDescent = 0f
    private var letterX = FloatArray(0)
    private var letterW = FloatArray(0)
    private val starX = FloatArray(STAR_COUNT)
    private val starY = FloatArray(STAR_COUNT)
    private val starR = FloatArray(STAR_COUNT)
    private val starSpeed = FloatArray(STAR_COUNT)
    private val starPhase = FloatArray(STAR_COUNT)
    private val starTwinkle = FloatArray(STAR_COUNT)
    private val starBright = FloatArray(STAR_COUNT)

    init {
        // Deterministic star field (same sky every launch, no Random allocation).
        var seed = 11L
        fun rnd(): Float {
            seed = (seed * 16807L) % 2147483647L
            return seed / 2147483647f
        }
        for (i in 0 until STAR_COUNT) {
            starX[i] = rnd(); starY[i] = rnd()
            starR[i] = 0.5f + rnd() * 0.8f
            starSpeed[i] = 1.5f + rnd() * 4.5f
            starPhase[i] = rnd() * 6.28f
            starTwinkle[i] = 0.5f + rnd() * 1.4f
            starBright[i] = 0.35f + rnd() * 0.65f
        }
    }

    /**
     * Fills the wordmark to the end and plays the exit. Safe to call repeatedly.
     * The exit never starts before the intro has built the wordmark.
     */
    fun finish() {
        if (finishAt >= 0f) return
        finishAt = max(elapsed(), MIN_INTRO_S)
        postInvalidateOnAnimation()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        postInvalidateOnAnimation()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val cx = w / 2f
        val cy = h * 0.44f
        val far = max(w, h).toFloat()
        // Edges sink a little darker, the centre lifts a touch: depth without colour.
        vignettePaint.shader = RadialGradient(
            cx, cy, far * 0.78f,
            intArrayOf(0x00000000, 0x00000000, 0x59000000),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP,
        )
        liftPaint.shader = RadialGradient(
            cx, cy, far * 0.42f,
            intArrayOf(0x0DFFFFFF, 0x00FFFFFF),
            null,
            Shader.TileMode.CLAMP,
        )
        // Wordmark: 32dp, shrunk to fit 78% of the width on narrow screens.
        var size = 32f * dp
        ghostPaint.textSize = size
        var tw = ghostPaint.measureText(title)
        val maxW = w * 0.78f
        if (tw > maxW && tw > 0f) {
            size = size * maxW / tw
            ghostPaint.textSize = size
            tw = ghostPaint.measureText(title)
        }
        fillPaint.textSize = size
        edgePaint.textSize = size
        shinePaint.textSize = size
        textWidth = tw
        textAscent = -ghostPaint.ascent()
        textDescent = ghostPaint.descent()
        // Kerning-aware x offset and width of every glyph.
        letterX = FloatArray(title.length) { i -> ghostPaint.measureText(title, 0, i) }
        letterW = FloatArray(title.length) { i -> ghostPaint.measureText(title, i, i + 1) }
        // A soft blue glow that rises towards the edge and dissolves past it.
        edgePaint.shader = LinearGradient(
            0f, 0f, UNIT_RADIUS, 0f,
            intArrayOf(withAlpha(EDGE, 0f), withAlpha(EDGE, 0.85f), withAlpha(EDGE, 0f)),
            floatArrayOf(0f, 0.72f, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    private fun elapsed(): Float =
        if (startMs < 0L) 0f else (SystemClock.uptimeMillis() - startMs) / 1000f

    /** Loaded fraction of the wordmark at time [t]. */
    private fun fillAt(t: Float): Float {
        if (finishAt < 0f) return loadingProgress(t)
        val p0 = loadingProgress(finishAt)
        return p0 + (1f - p0) * easeOut(seg(t, finishAt, finishAt + FILL_S))
    }

    override fun onDraw(canvas: Canvas) {
        // The clock starts on the first frame the user can actually see.
        if (startMs < 0L) startMs = SystemClock.uptimeMillis()
        val t = elapsed()
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        // Exit: after the fill completes and the light has swept, fade out.
        val exitStart = if (finishAt < 0f) Float.MAX_VALUE else finishAt + FILL_S + EXIT_DELAY_S
        val ex = if (finishAt < 0f) 0f else seg(t, exitStart, exitStart + EXIT_S)
        val exE = easeInOut(ex)
        alpha = 1f - exE

        // ── Background: eases from the splash colour into the chat colour ──
        canvas.drawColor(lerpColor(splashColor, baseColor, easeOut(seg(t, 0f, 0.6f))))
        canvas.drawRect(0f, 0f, w, h, liftPaint)
        canvas.drawRect(0f, 0f, w, h, vignettePaint)

        val sky = seg(t, 0.1f, 1.0f)
        for (i in 0 until STAR_COUNT) {
            val y = (((starY[i] * h - t * starSpeed[i] * dp) % h) + h) % h
            val tw = 0.5f + 0.5f * sin(t * starTwinkle[i] + starPhase[i])
            val a = (0.18f + 0.50f * tw) * starBright[i] * sky
            starPaint.alpha = (255 * a).toInt()
            canvas.drawCircle(starX[i] * w, y, starR[i] * dp, starPaint)
        }
        drawMeteor(canvas, t, w, h, sky)

        // ── Foreground: icon rises from the splash position into place ──
        val cx = w / 2f
        val targetY = h * 0.44f - 38f * dp
        val rise = easeInOut(seg(t, 0.3f, 1.15f))
        val cy = h / 2f + (targetY - h / 2f) * rise

        canvas.save()
        val zoom = 1f + 0.035f * exE
        canvas.scale(zoom, zoom, cx, h * 0.44f)

        val halo = (0.8f + 0.2f * sin(t * 1.6f)) * seg(t, 0.2f, 1.0f)
        if (halo > 0f) {
            val hr = 150f * dp
            m.setScale(hr / UNIT_RADIUS, hr / UNIT_RADIUS)
            m.postTranslate(cx, cy)
            haloPaint.shader.setLocalMatrix(m)
            haloPaint.alpha = (255 * halo).toInt()
            canvas.drawRect(cx - hr, cy - hr, cx + hr, cy + hr, haloPaint)
        }

        // Icon (rounded-tile fill removes the square corners of the source art).
        val shader = iconShader
        if (shader != null) {
            val size = ICON_DP * dp * (0.86f + 0.14f * easeBack(seg(t, 0f, 0.6f)))
            val left = cx - size / 2f
            val top = cy - size / 2f
            m.setScale(size / iconBitmapSize, size / iconBitmapSize)
            m.postTranslate(left, top)
            shader.setLocalMatrix(m)
            iconPaint.shader = shader
            val iconA = seg(t, 0f, 0.25f)
            iconPaint.alpha = (255 * iconA).toInt()
            val inset = size * ICON_TILE_INSET
            val radius = size * ICON_TILE_RADIUS
            rect.set(left + inset, top + inset, left + size - inset, top + size - inset)
            canvas.drawRoundRect(rect, radius, radius, iconPaint)
            iconRimPaint.alpha = (255 * 0.07f * iconA).toInt()
            canvas.drawRoundRect(rect, radius, radius, iconRimPaint)
        }

        // ── Wordmark = progress ──
        val baseY = h * 0.44f + 38f * dp + ICON_DP * dp / 2f + 30f * dp + textAscent * 0.8f
        val textLeft = cx - textWidth / 2f
        val revealEnd = LETTER_START_S + (title.length - 1) * LETTER_STAGGER_S + LETTER_DUR_S

        // Ghost letters rise in one by one.
        for (i in title.indices) {
            val k = seg(t, LETTER_START_S + i * LETTER_STAGGER_S, LETTER_START_S + i * LETTER_STAGGER_S + LETTER_DUR_S)
            if (k <= 0f) continue
            val e = easeOut(k)
            val x = textLeft + letterX[i]
            canvas.save()
            canvas.translate(0f, (1f - e) * 12f * dp)
            ghostPaint.alpha = (255 * GHOST_ALPHA * min(1f, k * 1.4f)).toInt()
            canvas.drawText(title, i, i + 1, x, baseY, ghostPaint)
            canvas.restore()
        }

        // Light fills the letters from left to right. The edge travels from one
        // feather-width before the text to one past it, so 0% shows nothing and
        // 100% is fully lit.
        val p = if (t < revealEnd) 0f else fillAt(t)
        if (p > 0f) {
            val feather = FEATHER_DP * dp
            val edgeX = textLeft - feather + (textWidth + 2f * feather) * p
            val top = baseY - textAscent - 4f * dp
            val bottom = baseY + textDescent + 4f * dp
            m.setScale(2f * feather / UNIT_RADIUS, 1f)
            m.postTranslate(edgeX - feather, 0f)
            fillPaint.shader.setLocalMatrix(m)
            drawWord(canvas, textLeft, baseY, fillPaint)

            // Accent glow riding the moving edge (fades away once complete).
            val edgeA = if (finishAt < 0f) 1f else 1f - seg(t, finishAt + FILL_S * 0.6f, finishAt + FILL_S + 0.25f)
            if (edgeA > 0f) {
                val band = EDGE_BAND_DP * dp
                m.setScale((band + feather) / UNIT_RADIUS, 1f)
                m.postTranslate(edgeX - band, 0f)
                edgePaint.shader.setLocalMatrix(m)
                edgePaint.alpha = (255 * edgeA).toInt()
                drawWord(canvas, textLeft, baseY, edgePaint)
            }

            // Light sweep: gently over the loaded part while waiting, and one
            // full, brighter pass when the page is ready.
            var sweep = -1f
            var sweepA = 0f
            if (finishAt < 0f) {
                val sp = ((t - revealEnd) % SHINE_PERIOD_S) / SHINE_DUR_S
                if (sp < 1f) { sweep = easeInOut(sp); sweepA = 0.45f }
            } else {
                val from = finishAt + FILL_S * 0.55f
                val k = seg(t, from, from + FINAL_SWEEP_S)
                if (t >= from && k < 1f) { sweep = easeInOut(k); sweepA = 1f }
            }
            if (sweep >= 0f) {
                val band = 46f * dp
                val sx = textLeft - band + (textWidth + 2f * band) * sweep
                m.setScale(band / UNIT_RADIUS, 1f)
                m.postTranslate(sx, 0f)
                shinePaint.shader.setLocalMatrix(m)
                shinePaint.alpha = (255 * sweepA).toInt()
                canvas.save()
                canvas.clipRect(textLeft - 4f * dp, top, edgeX - feather * 0.5f, bottom)
                drawWord(canvas, textLeft, baseY, shinePaint)
                canvas.restore()
            }
        }
        canvas.restore()

        if (ex >= 1f) {
            if (!exitReported) {
                exitReported = true
                post { onExitFinished?.invoke() }
            }
        } else {
            postInvalidateOnAnimation()
        }
    }

    /** Draws the settled wordmark glyph by glyph, exactly where the ghost letters sit. */
    private fun drawWord(canvas: Canvas, left: Float, baseY: Float, paint: Paint) {
        for (i in title.indices) canvas.drawText(title, i, i + 1, left + letterX[i], baseY, paint)
    }

    /** A faint shooting star now and then, high in the sky. */
    private fun drawMeteor(canvas: Canvas, t: Float, w: Float, h: Float, sky: Float) {
        if (t < METEOR_FIRST_S) return
        val n = ((t - METEOR_FIRST_S) / METEOR_PERIOD_S).toInt()
        val k = ((t - METEOR_FIRST_S) % METEOR_PERIOD_S) / METEOR_DUR_S
        if (k >= 1f) return
        val fromLeft = n % 2 == 0
        val sx = if (fromLeft) w * (0.12f + 0.1f * (n % 3)) else w * (0.88f - 0.1f * (n % 3))
        val sy = h * (0.08f + 0.05f * (n % 4))
        val len = 70f * dp
        val travel = 170f * dp * easeOut(k)
        val dir = if (fromLeft) 1f else -1f
        val hx = sx + dir * travel * 0.92f
        val hy = sy + travel * 0.4f
        val tx = hx - dir * len * 0.92f
        val ty = hy - len * 0.4f
        // Gradient runs tail → head.
        m.setScale(len / UNIT_RADIUS, 1f)
        m.postRotate(if (fromLeft) 23.5f else 156.5f)
        m.postTranslate(tx, ty)
        meteorPaint.shader.setLocalMatrix(m)
        meteorPaint.alpha = (255 * 0.55f * sin(k * Math.PI.toFloat()) * sky).toInt()
        canvas.drawLine(tx, ty, hx, hy, meteorPaint)
    }

    private companion object {
        const val UNIT_RADIUS = 100f
        const val STAR_COUNT = 46
        const val ICON_DP = 96f
        /** Rounded tile inside the icon art, as fractions of the icon size. */
        const val ICON_TILE_INSET = 0.058f
        const val ICON_TILE_RADIUS = 0.212f
        const val LETTER_START_S = 0.55f
        const val LETTER_STAGGER_S = 0.04f
        const val LETTER_DUR_S = 0.5f
        const val GHOST_ALPHA = 0.17f
        const val EDGE_BAND_DP = 30f
        /** Width over which the lit edge dissolves into the ghost letters. */
        const val FEATHER_DP = 14f
        const val SHINE_PERIOD_S = 3.4f
        const val SHINE_DUR_S = 1.3f
        const val FILL_S = 0.45f
        const val FINAL_SWEEP_S = 0.7f
        const val EXIT_DELAY_S = 0.3f
        const val EXIT_S = 0.5f
        const val METEOR_FIRST_S = 3.2f
        const val METEOR_PERIOD_S = 6.5f
        const val METEOR_DUR_S = 0.9f
        /** The exit never starts before the wordmark has built and begun to fill. */
        const val MIN_INTRO_S = 2.0f
        /** Loading fill: starts once the letters are in, approaches 92% and waits. */
        const val FILL_START_S = 1.6f
        const val FILL_TAU_S = 5.5f

        /** DeepSeek brand blue, used only as a faint glow. */
        const val ACCENT = 0xFF4D6BFE.toInt()
        /** Soft blue at the leading edge of the fill. */
        const val EDGE = 0xFF9DB0FF.toInt()
        /** Loaded letters: the chat's own near-white text. */
        const val TEXT = 0xFFF1F2F4.toInt()

        fun withAlpha(color: Int, a: Float): Int =
            (color and 0x00FFFFFF) or ((255 * a.coerceIn(0f, 1f)).toInt() shl 24)

        fun lerpColor(a: Int, b: Int, f: Float): Int {
            fun ch(s: Int) = (((a shr s) and 0xFF) + (((b shr s) and 0xFF) - ((a shr s) and 0xFF)) * f).toInt() and 0xFF
            return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
        }

        fun seg(t: Float, a: Float, b: Float): Float = ((t - a) / (b - a)).coerceIn(0f, 1f)
        fun easeOut(x: Float): Float = 1f - (1f - x).pow(3)
        fun easeInOut(x: Float): Float =
            if (x < 0.5f) 4f * x * x * x else 1f - (-2f * x + 2f).pow(3) / 2f
        fun easeBack(x: Float): Float {
            val c1 = 1.4f
            val c3 = c1 + 1f
            return 1f + c3 * (x - 1f).pow(3) + c1 * (x - 1f).pow(2)
        }

        /** Asymptotic "honest" progress: moves steadily, never completes alone. */
        fun loadingProgress(t: Float): Float =
            if (t < FILL_START_S) 0f else 0.92f * (1f - exp(-(t - FILL_START_S) / FILL_TAU_S))
    }
}
