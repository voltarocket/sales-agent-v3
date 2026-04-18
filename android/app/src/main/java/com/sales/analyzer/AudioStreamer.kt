package com.sales.analyzer

import android.util.Log
import okhttp3.*
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AudioStreamer(private val backendWsUrl: String) {

    private var ws: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    var onSessionStarted:  ((String) -> Unit)? = null
    var onProcessing:      (() -> Unit)?        = null
    var onAnalyzed:        ((CallAnalysis) -> Unit)? = null
    var onError:           ((String) -> Unit)?  = null
    var onConnected:       (() -> Unit)?        = null
    var onDisconnected:    (() -> Unit)?        = null

    fun connect() {
        val request = Request.Builder().url(backendWsUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("Streamer", "Connected")
                onConnected?.invoke()
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    when (msg.getString("type")) {
                        "session_started" -> onSessionStarted?.invoke(msg.getString("sessionId"))
                        "processing"      -> onProcessing?.invoke()
                        "call_analyzed"   -> onAnalyzed?.invoke(CallAnalysis.fromJson(msg))
                        "error"           -> onError?.invoke(msg.optString("error"))
                    }
                } catch (e: Exception) { Log.e("Streamer", e.message ?: "") }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("Streamer", t.message ?: "")
                onDisconnected?.invoke()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onDisconnected?.invoke()
            }
        })
    }

    fun startCall(phone: String, managerId: Int = 1) {
        ws?.send(JSONObject().apply {
            put("type", "call_start")
            put("phone", phone)
            put("managerId", managerId)
            put("deviceType", "android")
        }.toString())
    }

    fun sendChunk(data: ByteArray) {
        ws?.send(data.toByteString())
    }

    fun endCall() {
        ws?.send(JSONObject().apply { put("type", "call_end") }.toString())
    }

    fun disconnect() {
        ws?.close(1000, "closed")
        ws = null
    }

    fun isConnected() = ws != null
}

data class CallAnalysis(
    val sessionId:      String,
    val transcript:     String,
    val summary:        String,
    val score:          Int,
    val errors:         List<CallError>,
    val positives:      List<String>,
    val recommendation: String,
    val duration:       Int,
    val phone:          String,
) {
    companion object {
        fun fromJson(json: JSONObject): CallAnalysis {
            val a = json.optJSONObject("analysis")
            val errArr = a?.optJSONArray("errors")
            val errors = mutableListOf<CallError>()
            if (errArr != null) for (i in 0 until errArr.length()) {
                val e = errArr.getJSONObject(i)
                errors.add(CallError(e.optString("title"), e.optString("description"), e.optString("severity","low")))
            }
            val posArr = a?.optJSONArray("positives")
            val positives = mutableListOf<String>()
            if (posArr != null) for (i in 0 until posArr.length()) positives.add(posArr.getString(i))
            return CallAnalysis(
                sessionId      = json.optString("sessionId"),
                transcript     = json.optString("transcript"),
                summary        = a?.optString("summary") ?: "",
                score          = a?.optInt("score", 0) ?: 0,
                errors         = errors,
                positives      = positives,
                recommendation = a?.optString("recommendation") ?: "",
                duration       = json.optInt("duration", 0),
                phone          = json.optString("phone"),
            )
        }
    }
}

data class CallError(val title: String, val description: String, val severity: String)
