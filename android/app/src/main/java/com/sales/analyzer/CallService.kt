package com.sales.analyzer

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService
import android.util.Log

class CallService : InCallService() {

    private var phone = "unknown"

    private val cb = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
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
                }
            }
        }
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        phone = call.details?.handle?.schemeSpecificPart ?: "unknown"
        call.registerCallback(cb)
        Log.d("CallService", "Call added: $phone state=${call.state}")
        if (call.state == Call.STATE_ACTIVE) {
            startService(Intent(this, AudioCaptureService::class.java).apply {
                action = AudioCaptureService.ACTION_START
                putExtra(AudioCaptureService.EXTRA_PHONE, phone)
            })
        }
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        call.unregisterCallback(cb)
        startService(Intent(this, AudioCaptureService::class.java).apply {
            action = AudioCaptureService.ACTION_STOP
        })
    }
}
