package com.sales.analyzer

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

val Context.dataStore by preferencesDataStore("settings")
val KEY_URL = stringPreferencesKey("backend_url")

object C {
    val bg       = Color(0xFF0A0A0F)
    val surface  = Color(0xFF13131A)
    val surface2 = Color(0xFF1C1C26)
    val accent   = Color(0xFFFFFFFF)
    val accent2  = Color(0xFFE2E8F0)
    val text     = Color(0xFFF1F5F9)
    val text2    = Color(0xFF94A3B8)
    val text3    = Color(0xFF475569)
    val green    = Color(0xFF22C55E)
    val yellow   = Color(0xFFFBBF24)
    val red      = Color(0xFFF87171)
    val border   = Color(0x12FFFFFF)
}

class MainActivity : ComponentActivity() {

    private lateinit var streamer: AudioStreamer
    private var backendUrl = "ws://192.168.1.166:3001"

    private val roleRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()) {}

    private val callPermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE)
            != PackageManager.PERMISSION_GRANTED) {
            callPermissionRequest.launch(Manifest.permission.CALL_PHONE)
        }
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { App() } }
    }

    @Composable
    fun App() {
        val scope = rememberCoroutineScope()
        var wsOk by remember { mutableStateOf(false) }
        var isDefault by remember { mutableStateOf(isDefaultDialer()) }
        var urlInput by remember { mutableStateOf(backendUrl) }
        var tab by remember { mutableIntStateOf(0) }

        LaunchedEffect(Unit) {
            val saved = dataStore.data.first()[KEY_URL]
            if (saved != null) { backendUrl = saved; urlInput = saved }
            initStreamer { wsOk = it }
        }

        Column(Modifier.fillMaxSize().background(C.bg)) {
            // Header
            Row(
                Modifier.fillMaxWidth().background(C.surface).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Sales Analyzer", color = C.text, fontWeight = FontWeight.Bold,
                    fontSize = 16.sp, modifier = Modifier.weight(1f)
                )
                Box(Modifier.size(8.dp).background(
                    if (wsOk) Color(0xFF22C55E) else C.text3, RoundedCornerShape(50)
                ))
                Spacer(Modifier.width(6.dp))
                Text(
                    if (wsOk) "Подключён" else "Нет связи",
                    color = C.text2, fontSize = 11.sp, fontFamily = FontFamily.Monospace
                )
            }

            TabRow(selectedTabIndex = tab, containerColor = C.surface, contentColor = C.accent2) {
                Tab(selected = tab == 0, onClick = { tab = 0 }) {
                    Text("Звонок", Modifier.padding(12.dp))
                }
                Tab(selected = tab == 1, onClick = { tab = 1 }) {
                    Text("Настройки", Modifier.padding(12.dp))
                }
            }

            when (tab) {
                0 -> DialerTab(isDefault, onRequestDefault = { isDefault = requestDefault() })
                1 -> SettingsTab(
                    url = urlInput,
                    isDefault = isDefault,
                    onChange = { urlInput = it },
                    onSave = {
                        scope.launch {
                            backendUrl = urlInput
                            dataStore.edit { it[KEY_URL] = urlInput }
                            streamer.disconnect()
                            initStreamer { wsOk = it }
                        }
                    },
                    onRequestDefault = { isDefault = requestDefault() }
                )
            }
        }
    }

    @Composable
    fun DialerTab(isDefault: Boolean, onRequestDefault: () -> Unit) {
        var number by remember { mutableStateOf("") }

        Column(
            Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(Modifier.height(8.dp))

            // Number display
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(C.surface2, RoundedCornerShape(12.dp))
                    .padding(horizontal = 20.dp, vertical = 22.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = if (number.isEmpty()) "Введите номер" else formatNumber(number),
                    color = if (number.isEmpty()) C.text3 else C.text,
                    fontSize = if (number.length > 11) 22.sp else 26.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(Modifier.height(28.dp))

            // Numpad 3×4
            val rows = listOf(
                listOf("1", "2", "3"),
                listOf("4", "5", "6"),
                listOf("7", "8", "9"),
                listOf("*", "0", "#"),
            )
            rows.forEach { row ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    row.forEach { key ->
                        DialKey(key) { number += key }
                    }
                }
                Spacer(Modifier.height(10.dp))
            }

            Spacer(Modifier.height(10.dp))

            // Bottom row: backspace + call button + spacer
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Backspace
                Box(
                    Modifier
                        .size(64.dp)
                        .background(C.surface2, CircleShape)
                        .clickable { if (number.isNotEmpty()) number = number.dropLast(1) },
                    contentAlignment = Alignment.Center
                ) {
                    Text("⌫", fontSize = 22.sp, color = C.text2)
                }

                // Call
                Box(
                    Modifier
                        .size(72.dp)
                        .background(Color(0xFF22C55E), CircleShape)
                        .clickable { placeCall(number) },
                    contentAlignment = Alignment.Center
                ) {
                    Text("📞", fontSize = 28.sp)
                }

                // Symmetry spacer
                Spacer(Modifier.size(64.dp))
            }

            // Warning if not default dialer
            if (!isDefault) {
                Spacer(Modifier.height(20.dp))
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0x20FBBF24)),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("⚠ ", fontSize = 14.sp)
                        Column(Modifier.weight(1f)) {
                            Text(
                                "Установите как телефон по умолчанию",
                                color = C.yellow, fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Text(
                                "для автоматической записи звонков",
                                color = C.text2, fontSize = 11.sp
                            )
                        }
                        TextButton(onClick = onRequestDefault) {
                            Text("Настроить", color = C.accent2, fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun DialKey(label: String, onClick: () -> Unit) {
        Box(
            Modifier
                .size(72.dp)
                .background(C.surface2, CircleShape)
                .clickable { onClick() },
            contentAlignment = Alignment.Center
        ) {
            Text(
                label, fontSize = 22.sp, color = C.text,
                fontWeight = FontWeight.Medium, fontFamily = FontFamily.Monospace
            )
        }
    }

    @Composable
    fun SettingsTab(
        url: String,
        isDefault: Boolean,
        onChange: (String) -> Unit,
        onSave: () -> Unit,
        onRequestDefault: () -> Unit,
    ) {
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Card(
                colors = CardDefaults.cardColors(containerColor = C.surface2),
                shape = RoundedCornerShape(12.dp)
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("Backend WebSocket URL", color = C.text2, fontSize = 11.sp)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = url, onValueChange = onChange,
                        placeholder = { Text("192.168.1.100:3001 или ws://192.168.1.100:3001", color = C.text3) },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = C.accent,
                            unfocusedBorderColor = C.border,
                            focusedTextColor = C.text,
                            unfocusedTextColor = C.text
                        ),
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "IP компьютера с бэкендом (автоматически конвертируется в ws://)\nНайти: ipconfig → IPv4 Address",
                        color = C.text3, fontSize = 11.sp
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = {
                            val validUrl = normalizeWebSocketUrl(url)
                            onChange(validUrl)
                            onSave()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = C.accent, contentColor = Color(0xFF0A0A0F)),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Сохранить и переподключить")
                    }
                }
            }

            Card(
                colors = CardDefaults.cardColors(containerColor = C.surface2),
                shape = RoundedCornerShape(12.dp)
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("Телефон по умолчанию", color = C.text2, fontSize = 11.sp)
                    Spacer(Modifier.height(8.dp))
                    if (isDefault) {
                        Text(
                            "✓ Sales Analyzer — телефон по умолчанию",
                            color = C.green, fontWeight = FontWeight.SemiBold, fontSize = 13.sp
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Все звонки записываются автоматически",
                            color = C.text2, fontSize = 12.sp
                        )
                    } else {
                        Text(
                            "⚠ Не установлен как телефон по умолчанию",
                            color = C.yellow, fontWeight = FontWeight.SemiBold, fontSize = 13.sp
                        )
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = onRequestDefault,
                            colors = ButtonDefaults.buttonColors(containerColor = C.accent, contentColor = Color(0xFF0A0A0F)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Установить как телефон по умолчанию")
                        }
                    }
                }
            }
        }
    }

    private fun normalizeWebSocketUrl(input: String): String {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return "ws://192.168.1.166:3001"

        val withScheme = when {
            trimmed.startsWith("ws://") || trimmed.startsWith("wss://") -> trimmed
            trimmed.startsWith("http://") -> trimmed.replace("http://", "ws://")
            trimmed.startsWith("https://") -> trimmed.replace("https://", "wss://")
            else -> "ws://$trimmed"
        }

        return if (withScheme.contains(":")) withScheme else "$withScheme:3001"
    }

    private fun formatNumber(raw: String): String {
        if (raw.startsWith("+") || raw.length <= 1) return raw
        return buildString {
            raw.forEachIndexed { i, c ->
                when (i) {
                    1 -> append(" (")
                    4 -> append(") ")
                    7, 9 -> append("-")
                }
                append(c)
            }
        }
    }

    private fun placeCall(number: String) {
        if (number.isBlank()) return
        val uri = Uri.parse("tel:${number.trim()}")
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startActivity(Intent(Intent.ACTION_CALL, uri))
        } else {
            callPermissionRequest.launch(Manifest.permission.CALL_PHONE)
        }
    }

    private fun initStreamer(onStatus: (Boolean) -> Unit) {
        streamer = AudioStreamer(backendUrl)
        AudioCaptureService.streamer = streamer
        streamer.onConnected    = { onStatus(true) }
        streamer.onDisconnected = { onStatus(false) }
        streamer.onAnalyzed = { analysis ->
            startActivity(Intent(this, PostCallActivity::class.java).apply {
                putExtra("phone",          analysis.phone)
                putExtra("score",          analysis.score)
                putExtra("summary",        analysis.summary)
                putExtra("transcript",     analysis.transcript)
                putExtra("recommendation", analysis.recommendation)
                putExtra("duration",       analysis.duration)
                putExtra("backendHost",    backendUrl.removePrefix("ws://").substringBefore(":"))
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }
        streamer.connect()
    }

    private fun isDefaultDialer() =
        getSystemService(TelecomManager::class.java)?.defaultDialerPackage == packageName

    private fun requestDefault(): Boolean {
        val rm = getSystemService(RoleManager::class.java)
        if (rm.isRoleAvailable(RoleManager.ROLE_DIALER) && !rm.isRoleHeld(RoleManager.ROLE_DIALER))
            roleRequest.launch(rm.createRequestRoleIntent(RoleManager.ROLE_DIALER))
        return isDefaultDialer()
    }
}
