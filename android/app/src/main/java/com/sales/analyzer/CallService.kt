package com.sales.analyzer

import android.content.Intent
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class CallService : InCallService() {

    companion object {
        @Volatile
        var currentCall: Call? = null
            private set

        @Volatile
        private var instance: CallService? = null

        private val _callState = MutableStateFlow(Call.STATE_NEW)
        val callState: StateFlow<Int> = _callState

        fun setSpeakerOn(on: Boolean) {
            instance?.setAudioRoute(
                if (on) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_WIRED_OR_EARPIECE
            )
        }

        fun setMuted(muted: Boolean) {
            instance?.setMuted(muted)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    private var phone = "unknown"
    private var callStartedAt = 0L
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val cb = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            _callState.value = state
            when (state) {
                Call.STATE_ACTIVE -> {
                    Log.d("CallService", "ACTIVE → start recording")
                    callStartedAt = System.currentTimeMillis()
                    startService(Intent(this@CallService, AudioCaptureService::class.java).apply {
                        action = AudioCaptureService.ACTION_START
                        putExtra(AudioCaptureService.EXTRA_PHONE, phone)
                    })
                }
                Call.STATE_DISCONNECTED -> {
                    Log.d("CallService", "DISCONNECTED → stop recording")
                    startService(Intent(this@CallService, AudioCaptureService::class.java).apply {
                        action = AudioCaptureService.ACTION_STOP
                    })
                    lookForNativeRecording(phone, callStartedAt)
                    currentCall = null
                }
            }
        }
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        phone = call.details?.handle?.schemeSpecificPart ?: "unknown"
        currentCall = call
        _callState.value = call.details.state
        call.registerCallback(cb)
        Log.d("CallService", "Call added: $phone state=${call.details.state}")

        startActivity(Intent(this, InCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        })

        if (call.details.state == Call.STATE_ACTIVE) {
            callStartedAt = System.currentTimeMillis()
            startService(Intent(this, AudioCaptureService::class.java).apply {
                action = AudioCaptureService.ACTION_START
                putExtra(AudioCaptureService.EXTRA_PHONE, phone)
            })
        }
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        call.unregisterCallback(cb)
        currentCall = null
        _callState.value = Call.STATE_DISCONNECTED
        startService(Intent(this, AudioCaptureService::class.java).apply {
            action = AudioCaptureService.ACTION_STOP
        })
    }

    /**
     * Some OEM ROMs (Flyme etc.) write their own call-recording file on hangup, separate
     * from our live AudioRecord capture. It can take a couple seconds to appear/get indexed,
     * so poll briefly; if found, upload it as a much more reliable transcript source.
     */
    private fun lookForNativeRecording(callPhone: String, startedAt: Long) {
        if (startedAt == 0L) return
        val managerId   = AppSession.managerId
        val managerName = AppSession.managerName
        scope.launch {
            repeat(5) {
                delay(1500)
                val uri = CallRecordingLocator.findRecordingFile(this@CallService, startedAt)
                if (uri != null) {
                    val file = CallRecordingLocator.copyToCache(this@CallService, uri)
                    if (file != null) {
                        Log.d("CallService", "Native recording found, uploading: ${file.name}")
                        AudioCaptureService.streamer?.uploadRecordingFile(file, callPhone, managerId, managerName)
                    }
                    return@launch
                }
            }
            Log.d("CallService", "No native recording found, relying on live stream")
        }
    }
}
