package com.sales.analyzer

import android.media.AudioManager
import android.os.Bundle
import android.telecom.Call
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

class InCallActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                InCallScreen()
            }
        }
    }

    // Disable back button during a call
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // do nothing — call is still active
    }

    @Composable
    fun InCallScreen() {
        val callState by CallService.callState.collectAsState()
        val call = CallService.currentCall
        val phone = call?.details?.handle?.schemeSpecificPart ?: ""

        LaunchedEffect(callState) {
            if (callState == Call.STATE_DISCONNECTED) {
                delay(800)
                finish()
            }
        }

        var seconds by remember { mutableIntStateOf(0) }
        LaunchedEffect(callState) {
            if (callState == Call.STATE_ACTIVE) {
                seconds = 0
                while (true) {
                    delay(1000)
                    seconds++
                }
            }
        }

        var isMuted by remember { mutableStateOf(false) }
        var isSpeaker by remember { mutableStateOf(false) }
        val audioManager = remember { getSystemService(AUDIO_SERVICE) as AudioManager }

        val statusText = when (callState) {
            Call.STATE_RINGING             -> "Входящий звонок"
            Call.STATE_DIALING,
            Call.STATE_CONNECTING          -> "Вызов..."
            Call.STATE_ACTIVE              -> "%d:%02d".format(seconds / 60, seconds % 60)
            Call.STATE_HOLDING             -> "Удержание"
            Call.STATE_DISCONNECTED        -> "Завершён"
            else                           -> "Подключение..."
        }

        Column(
            Modifier
                .fillMaxSize()
                .background(Color(0xFF0A0A1A)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // ── Caller info ────────────────────────────────────
            Column(
                Modifier.padding(top = 80.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = phone.ifEmpty { "Неизвестный" },
                    color = Color.White,
                    fontSize = 30.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    text = statusText,
                    color = Color(0xFF94A3B8),
                    fontSize = 18.sp
                )
            }

            // ── Action buttons ────────────────────────────────
            Column(
                Modifier.padding(bottom = 64.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                when (callState) {
                    Call.STATE_RINGING -> {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 48.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            CallButton(emoji = "📵", label = "Отклонить", bg = Color(0xFFEF4444)) {
                                call?.reject(false, null)
                            }
                            CallButton(emoji = "📞", label = "Ответить", bg = Color(0xFF22C55E)) {
                                call?.answer(0)
                            }
                        }
                    }
                    else -> {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 48.dp),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            CallButton(
                                emoji = if (isMuted) "🎙" else "🔇",
                                label = if (isMuted) "Вкл. микр." else "Выкл. микр.",
                                bg = if (isMuted) Color(0xFF475569) else Color(0xFF1E293B)
                            ) {
                                isMuted = !isMuted
                                audioManager.isMicrophoneMute = isMuted
                            }
                            CallButton(
                                emoji = "🔊",
                                label = "Динамик",
                                bg = if (isSpeaker) Color(0xFF475569) else Color(0xFF1E293B)
                            ) {
                                isSpeaker = !isSpeaker
                                audioManager.isSpeakerphoneOn = isSpeaker
                            }
                        }
                        Spacer(Modifier.height(28.dp))
                        CallButton(emoji = "📵", label = "Завершить", bg = Color(0xFFEF4444)) {
                            call?.disconnect()
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun CallButton(emoji: String, label: String, bg: Color, onClick: () -> Unit) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(72.dp)
                    .background(bg, CircleShape)
                    .clickable { onClick() },
                contentAlignment = Alignment.Center
            ) {
                Text(emoji, fontSize = 28.sp)
            }
            Spacer(Modifier.height(8.dp))
            Text(label, color = Color(0xFF94A3B8), fontSize = 12.sp)
        }
    }
}
