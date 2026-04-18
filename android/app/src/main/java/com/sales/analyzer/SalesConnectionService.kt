package com.sales.analyzer

import android.net.Uri
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

class SalesConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        Log.d("SalesConnection", "onCreateOutgoingConnection: ${request?.address}")
        return SimpleConnection(request?.address)
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        Log.d("SalesConnection", "onCreateIncomingConnection: ${request?.address}")
        return SimpleConnection(request?.address)
    }

    private inner class SimpleConnection(address: Uri?) : Connection() {
        init {
            setAddress(address, TelecomManager.PRESENTATION_ALLOWED)
            connectionCapabilities = CAPABILITY_HOLD or CAPABILITY_SUPPORT_HOLD
            setActive()
        }

        override fun onDisconnect() {
            setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
            destroy()
        }

        override fun onAbort() {
            setDisconnected(DisconnectCause(DisconnectCause.UNKNOWN))
            destroy()
        }
    }
}