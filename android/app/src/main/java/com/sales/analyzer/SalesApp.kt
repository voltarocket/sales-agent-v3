package com.sales.analyzer

import android.app.Application
import android.content.ComponentName
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

class SalesApp : Application() {

    override fun onCreate() {
        super.onCreate()
        registerPhoneAccount()
    }

    /**
     * Регистрирует PhoneAccount — без этого шага система Android не знает,
     * что приложение умеет обрабатывать звонки, и не предлагает его как дефолтный dialer.
     */
    private fun registerPhoneAccount() {
        try {
            val telecomManager = getSystemService(TELECOM_SERVICE) as TelecomManager

            val handle = PhoneAccountHandle(
                ComponentName(this, SalesConnectionService::class.java),
                "SalesAnalyzerAccount"
            )

            val phoneAccount = PhoneAccount.builder(handle, "Sales Analyzer")
                .setCapabilities(
                    PhoneAccount.CAPABILITY_CALL_PROVIDER or
                    PhoneAccount.CAPABILITY_SUPPORTS_VOICE_CALLING_INDICATIONS
                )
                .build()

            telecomManager.registerPhoneAccount(phoneAccount)
            Log.d("SalesApp", "PhoneAccount registered")
        } catch (e: Exception) {
            Log.e("SalesApp", "Failed to register PhoneAccount: ${e.message}")
        }
    }
}
