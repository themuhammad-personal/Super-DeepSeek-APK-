package com.superdeepseek.app

import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Capability gate in front of [WebViewBridge].
 *
 * `addJavascriptInterface` injects its object into EVERY frame of the WebView,
 * including sandboxed iframes, and Android cannot tell the calling frame
 * (developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges).
 * Generated visuals, artifacts and MCP Apps run as sandboxed `srcdoc` iframes
 * inside the chat page, so the raw bridge must not be reachable from them.
 *
 * Only this gate is injected. Every call must carry a random per-WebView token.
 * The token is delivered with `evaluateJavascript`, which runs in the main frame
 * only, and is kept in a closure by [shimScript]; opaque-origin iframes can see
 * the gate object but cannot call anything without the token.
 */
class BridgeGate(private val target: Any, val token: String = newToken()) {

    private val methods: Map<String, List<Method>> = target.javaClass.methods
        .filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
        .groupBy { it.name }

    /** Names the shim exposes as `window.AndroidBridge.<name>(…)`. */
    val methodNames: List<String> get() = methods.keys.sorted()

    /**
     * Returns `{"v":value}` (JSON) on success, `{}` for void, `{"e":"msg"}` on
     * failure. Wrong token → `{"e":"denied"}` without touching the target.
     */
    @JavascriptInterface
    fun call(callToken: String?, name: String?, argsJson: String?): String {
        if (callToken == null || !constantTimeEquals(callToken, token)) return DENIED
        val candidates = methods[name ?: return DENIED] ?: return err("unknown method")
        val args = try { JSONArray(argsJson ?: "[]") } catch (_: Throwable) { return err("bad arguments") }
        val method = candidates.firstOrNull { it.parameterTypes.size == args.length() }
            ?: candidates.minByOrNull { kotlin.math.abs(it.parameterTypes.size - args.length()) }
            ?: return err("unknown method")
        val converted = try {
            Array(method.parameterTypes.size) { i -> convert(if (i < args.length()) args.opt(i) else null, method.parameterTypes[i]) }
        } catch (t: Throwable) { return err("bad arguments") }
        return try {
            val result = method.invoke(target, *converted)
            if (method.returnType == Void.TYPE) "{}" else JSONObject().put("v", result ?: JSONObject.NULL).toString()
        } catch (t: InvocationTargetException) {
            err(t.targetException?.message ?: "call failed")
        } catch (t: Throwable) {
            err(t.message ?: "call failed")
        }
    }

    /** Main-frame script that installs `window.AndroidBridge` backed by the gate. Idempotent. */
    fun shimScript(): String {
        val names = JSONArray(methodNames).toString()
        return "(function(T,N){try{var g=window.$GATE_NAME;if(!g||window.__sdBridgeShim)return;" +
            "var b={};N.forEach(function(n){b[n]=function(){var r=g.call(T,n,JSON.stringify(Array.prototype.slice.call(arguments)," +
            "function(k,v){return v===undefined?null:v}));if(r==null)return undefined;var o=JSON.parse(r);" +
            "if(o.e){if(o.e==='denied')throw new Error('bridge denied');throw new Error(o.e)}return o.v}});" +
            "Object.defineProperty(window,'AndroidBridge',{value:Object.freeze(b),configurable:false,writable:false,enumerable:false});" +
            "Object.defineProperty(window,'__sdBridgeShim',{value:true});}catch(e){}})(" +
            JSONObject.quote(token) + "," + names + ");"
    }

    companion object {
        const val GATE_NAME = "SdsBridgeGate"
        private const val DENIED = "{\"e\":\"denied\"}"
        private fun err(message: String) = JSONObject().put("e", message.take(300)).toString()

        fun newToken(): String {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        fun constantTimeEquals(a: String, b: String): Boolean =
            MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

        /** Mirrors the Java-bridge conversions the engine relies on (strings, numbers, booleans, null). */
        internal fun convert(value: Any?, type: Class<*>): Any? {
            val v = if (value == JSONObject.NULL) null else value
            return when (type) {
                String::class.java -> when (v) {
                    null -> null
                    is String -> v
                    is Double -> if (v % 1.0 == 0.0 && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
                    else -> v.toString()
                }
                java.lang.Boolean.TYPE, java.lang.Boolean::class.java -> when (v) {
                    is Boolean -> v
                    is Number -> v.toDouble() != 0.0
                    is String -> v.isNotEmpty() && v != "false"
                    else -> false
                }
                java.lang.Integer.TYPE, java.lang.Integer::class.java -> (v as? Number)?.toInt() ?: (v as? String)?.toDoubleOrNull()?.toInt() ?: 0
                java.lang.Long.TYPE, java.lang.Long::class.java -> (v as? Number)?.toLong() ?: (v as? String)?.toDoubleOrNull()?.toLong() ?: 0L
                java.lang.Double.TYPE, java.lang.Double::class.java -> (v as? Number)?.toDouble() ?: (v as? String)?.toDoubleOrNull() ?: 0.0
                java.lang.Float.TYPE, java.lang.Float::class.java -> (v as? Number)?.toFloat() ?: (v as? String)?.toFloatOrNull() ?: 0f
                else -> throw IllegalArgumentException("unsupported parameter type")
            }
        }
    }
}
