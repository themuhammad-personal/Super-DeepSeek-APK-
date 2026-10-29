package com.superdeepseek.app

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A bottom sheet for Linux Studio that behaves like a phone sheet: it slides
 * up, follows the finger when dragged down (the dim layer fades with it),
 * closes past a distance or on a flick and otherwise springs back. Back and a
 * tap on the dim layer slide it away too.
 *
 * Framework views only. Callers fill [content]; [scrollable] names the view
 * inside that scrolls, so a drag in it only moves the sheet from its top.
 */
internal class StudioSheet(
        private val activity: Activity,
        private val dark: Boolean,
        private val panelColor: Int,
        private val textColor: Int,
        private val mutedColor: Int,
) {
    private val density = activity.resources.displayMetrics.density
    private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics).toInt()

    private val dialog = Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar)
    private var backInvokedCallback: OnBackInvokedCallback? = null

    private val root = FrameLayout(activity)
    private val scrim = View(activity).apply {
        setBackgroundColor(Color.argb(if (dark) 150 else 110, 0, 0, 0))
        alpha = 0f
        setOnClickListener { this@StudioSheet.dismiss(animated = true) }
    }
    private val panel = Panel()

    /** The sheet's body, below the grab handle. */
    val content: LinearLayout = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    /** A view inside [content] that scrolls (text viewer, long list). */
    var scrollable: View? = null

    var onDismissed: (() -> Unit)? = null

    private var dismissing = false
    private var shown = false

    init {
        panel.orientation = LinearLayout.VERTICAL
        panel.isClickable = true // touches on the panel never reach the dim layer
        panel.background = GradientDrawable().apply {
            setColor(panelColor)
            val r = dp(24f).toFloat()
            cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        }
        panel.elevation = dp(16f).toFloat()
        panel.addView(View(activity).apply {
            background = GradientDrawable().apply {
                setColor(if (dark) 0x40FFFFFF else 0x33000000)
                cornerRadius = dp(2f).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(dp(36f), dp(4f)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(10f); bottomMargin = dp(6f)
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        })
        panel.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(panel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            // A wide screen (tablet, landscape) gets a centred sheet, not a strip.
            val maxW = dp(600f)
            val w = activity.resources.displayMetrics.widthPixels
            if (w > maxW) { width = maxW; gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL }
        })
        root.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            val bottom = insets.systemWindowInsetBottom
            @Suppress("DEPRECATION")
            val top = insets.systemWindowInsetTop
            panel.setPadding(0, 0, 0, bottom)
            panel.topInset = top
            insets
        }
        dialog.setContentView(root)
        installBackHandling()
        dialog.setOnDismissListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                backInvokedCallback?.let(dialog.onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
                backInvokedCallback = null
            }
            onDismissed?.invoke()
        }
        dialog.window?.let { w ->
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            w.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            @Suppress("DEPRECATION")
            run {
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
                w.statusBarColor = Color.TRANSPARENT
                w.navigationBarColor = panelColor
                var flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                        View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                if (!dark) {
                    flags = flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                }
                w.decorView.systemUiVisibility = flags
            }
        }
    }

    private fun installBackHandling() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val callback = OnBackInvokedCallback { dismiss(animated = true) }
            dialog.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                callback,
            )
            backInvokedCallback = callback
        } else {
            // Before Android 13, Back is delivered as a key event. Keep the old
            // sheet animation without overriding Dialog.onBackPressed(), which no
            // longer receives predictive-back gestures on current Android.
            dialog.setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    dismiss(animated = true)
                    true
                } else {
                    false
                }
            }
        }
    }

    // ── Building blocks ─────────────────────────────────────────────────────

    /** Title row: the name, an optional subtitle and icon actions on the right. */
    fun header(title: String, subtitle: String? = null, actions: List<View> = emptyList()): StudioSheet {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20f), dp(2f), dp(8f), dp(8f))
        }
        val texts = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        texts.addView(TextView(activity).apply {
            text = title
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f)
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        })
        if (!subtitle.isNullOrEmpty()) texts.addView(TextView(activity).apply {
            text = subtitle
            setTextColor(mutedColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            isSingleLine = true
            ellipsize = android.text.TextUtils.TruncateAt.START
        })
        row.addView(texts)
        actions.forEach { row.addView(it) }
        content.addView(row)
        return this
    }

    /** One tappable row of an action list (icon + label); the sheet closes first. */
    fun action(icon: Int, label: String, color: Int = textColor, onClick: () -> Unit): StudioSheet {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(52f)
            setPadding(dp(20f), 0, dp(20f), 0)
            val v = TypedValue()
            if (activity.theme.resolveAttribute(android.R.attr.selectableItemBackground, v, true)) setBackgroundResource(v.resourceId)
            isClickable = true
            setOnClickListener { dismiss(animated = true, then = onClick) }
        }
        row.addView(ImageView(activity).apply {
            setImageResource(icon)
            imageTintList = android.content.res.ColorStateList.valueOf(color)
            layoutParams = LinearLayout.LayoutParams(dp(22f), dp(22f))
        })
        row.addView(TextView(activity).apply {
            text = label
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(18f) }
        })
        content.addView(row)
        return this
    }

    fun space(heightDp: Float): StudioSheet {
        content.addView(View(activity), LinearLayout.LayoutParams(1, dp(heightDp)))
        return this
    }

    // ── Showing and hiding ───────────────────────────────────────────────────

    fun show() {
        if (shown || activity.isFinishing || activity.isDestroyed) return
        shown = true
        panel.visibility = View.INVISIBLE
        dialog.show()
        panel.post {
            panel.translationY = panel.height.toFloat()
            panel.visibility = View.VISIBLE
            animatePanel(0f, 300L, PathInterpolator(0.16f, 1f, 0.3f, 1f))
        }
    }

    fun dismiss(animated: Boolean = true, then: (() -> Unit)? = null) {
        if (dismissing) return
        dismissing = true
        val finish = {
            runCatching { if (dialog.isShowing) dialog.dismiss() }
            then?.invoke()
            Unit
        }
        if (!animated || !dialog.isShowing || panel.height == 0) { finish(); return }
        animatePanel(panel.height.toFloat() + dp(24f), 200L, PathInterpolator(0.4f, 0f, 1f, 1f), finish)
    }

    private var anim: ValueAnimator? = null

    /** Moves the panel to [to]; the dim layer follows. */
    private fun animatePanel(to: Float, duration: Long, interp: android.animation.TimeInterpolator, end: (() -> Unit)? = null) {
        anim?.cancel()
        val from = panel.translationY
        anim = ValueAnimator.ofFloat(from, to).apply {
            this.duration = duration
            interpolator = interp
            addUpdateListener { setOffset(it.animatedValue as Float) }
            addListener(object : AnimatorListenerAdapter() {
                private var cancelled = false
                override fun onAnimationCancel(animation: Animator) { cancelled = true }
                override fun onAnimationEnd(animation: Animator) { if (!cancelled) end?.invoke() }
            })
            start()
        }
    }

    private fun setOffset(y: Float) {
        panel.translationY = y
        val h = panel.height.coerceAtLeast(1)
        scrim.alpha = (1f - y / h).coerceIn(0f, 1f)
    }

    // ── The panel: measured to a maximum height, draggable ───────────────────

    private inner class Panel : LinearLayout(activity) {
        /** The status bar's height: the sheet stops a little below it. */
        var topInset = 0
            set(v) { if (field != v) { field = v; requestLayout() } }

        private val slop = ViewConfiguration.get(activity).scaledTouchSlop
        private val flingVelocity = 900f * density // px per second
        private var downX = 0f
        private var downY = 0f
        private var startY = 0f
        private var dragging = false
        private var fromScrollable = false
        private var tracker: VelocityTracker? = null

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val avail = MeasureSpec.getSize(heightMeasureSpec)
            val size = if (avail > 0) (avail - topInset - dp(24f)).coerceAtLeast(avail / 2) else avail
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(size, if (avail > 0) MeasureSpec.AT_MOST else MeasureSpec.UNSPECIFIED))
        }

        private fun inside(v: View, x: Float, y: Float): Boolean {
            val a = IntArray(2); val b = IntArray(2)
            v.getLocationOnScreen(a); getLocationOnScreen(b)
            val left = a[0] - b[0]; val top = a[1] - b[1]
            return x >= left && x < left + v.width && y >= top && y < top + v.height
        }

        private fun canStart(ev: MotionEvent): Boolean {
            val dy = ev.y - downY
            val dx = ev.x - downX
            if (dy <= slop || dy < Math.abs(dx) * 1.2f) return false
            return !(fromScrollable && scrollable?.canScrollVertically(-1) == true)
        }

        private fun track(ev: MotionEvent) {
            val t = tracker ?: VelocityTracker.obtain().also { tracker = it }
            // Raw coordinates: the panel itself moves under the finger.
            val copy = MotionEvent.obtain(ev)
            copy.setLocation(ev.rawX, ev.rawY)
            t.addMovement(copy)
            copy.recycle()
        }

        private fun begin(ev: MotionEvent) {
            dragging = true
            // Caught mid-animation: continue from where the panel is, no jump.
            startY = ev.rawY - translationY.coerceAtLeast(0f)
            anim?.cancel()
            parent?.requestDisallowInterceptTouchEvent(true)
        }

        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
            if (dismissing) return true
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.x; downY = ev.y; dragging = false
                    fromScrollable = scrollable?.let { inside(it, ev.x, ev.y) } == true
                    tracker?.clear()
                    track(ev)
                }
                MotionEvent.ACTION_MOVE -> {
                    track(ev)
                    if (!dragging && canStart(ev)) begin(ev)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> dragging = false
            }
            return dragging
        }

        override fun onTouchEvent(ev: MotionEvent): Boolean {
            if (dismissing) return true
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.x; downY = ev.y; dragging = false; fromScrollable = false
                    tracker?.clear()
                    track(ev)
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    track(ev)
                    if (!dragging && canStart(ev)) begin(ev)
                    if (dragging) setOffset((ev.rawY - startY).coerceAtLeast(0f))
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    track(ev)
                    if (dragging) settle(ev.actionMasked == MotionEvent.ACTION_CANCEL)
                    else if (ev.actionMasked == MotionEvent.ACTION_UP) performClick()
                    dragging = false
                }
            }
            return true
        }

        private fun settle(cancelled: Boolean) {
            val t = tracker
            t?.computeCurrentVelocity(1000)
            val vy = t?.yVelocity ?: 0f
            val y = translationY
            val far = y > minOf(height * 0.3f, 220f * density)
            val flick = vy > flingVelocity && y > 12f * density
            if (!cancelled && (far || flick)) this@StudioSheet.dismiss(animated = true)
            else animatePanel(0f, 240L, DecelerateInterpolator(2f))
        }

        // A tap on the panel's empty space does nothing (it only keeps the tap off the dim layer).
        override fun performClick(): Boolean = super.performClick()

        override fun onDetachedFromWindow() {
            tracker?.recycle(); tracker = null
            super.onDetachedFromWindow()
        }
    }
}
