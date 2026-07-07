package com.sales.analyzer

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class CallService : InCallService() {

    companion object {
        @Volatile
        var currentCall: Call? = null
            private set

        private val _callState = MutableStateFlow(Call.STATE_NEW)
        val callState: StateFlow<Int> = _callState
    }

    private var phone = "unknown"

    private val cb = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            _callState.value = state
            when (state) {
                Call.STATE_ACTIVE -> {
                    Log.d("CallService", "ACTIVE → start recording")
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
}
