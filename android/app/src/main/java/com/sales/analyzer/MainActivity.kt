package com.sales.analyzer

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.telecom.TelecomManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
    val accent   = Color(0xFF6366F1)
    val accent2  = Color(0xFF818CF8)
    val text     = Color(0xFFF1F5F9)
    val text2    = Color(0xFF94A3B8)
    val text3    = Color(0xFF475569)
    val green    = Color(0xFF4ADE80)
    val yellow   = Color(0xFFFBBF24)
    val red      = Color(0xFFF87171)
    val border   = Color(0x12FFFFFF)
}

class MainActivity : ComponentActivity() {

    private lateinit var streamer: AudioStreamer
    private var backendUrl = "ws://192.168.1.166:3001" // ← ЗАМЕНИ НА СВОЙ IP

    private val roleRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
            Row(Modifier.fillMaxWidth().background(C.surface).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Sales Analyzer", color = C.text, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                Box(Modifier.size(8.dp).background(if (wsOk) Color(0xFF22C55E) else C.text3, RoundedCornerShape(50)))
                Spacer(Modifier.width(6.dp))
                Text(if (wsOk) "Подключён" else "Нет связи", color = C.text2, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }

            TabRow(selectedTabIndex = tab, containerColor = C.surface, contentColor = C.accent2) {
                Tab(selected = tab==0, onClick = {tab=0}) { Text("Статус", Modifier.padding(12.dp)) }
                Tab(selected = tab==1, onClick = {tab=1}) { Text("Настройки", Modifier.padding(12.dp)) }
            }

            when (tab) {
                0 -> StatusTab(isDefault) { isDefault = requestDefault() }
                1 -> SettingsTab(urlInput,
                    onChange = { urlInput = it },
                    onSave = {
                        scope.launch {
                            backendUrl = urlInput
                            dataStore.edit { it[KEY_URL] = urlInput }
                            streamer.disconnect()
                            initStreamer { wsOk = it }
                        }
                    }
                )
            }
        }
    }

    @Composable
    fun StatusTab(isDefault: Boolean, onRequest: () -> Unit) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Card(colors = CardDefaults.cardColors(containerColor = C.surface2), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Телефон по умолчанию", color = C.text2, fontSize = 11.sp)
                    Spacer(Modifier.height(8.dp))
                    if (isDefault) {
                        Text("✓ Установлено", color = C.green, fontWeight = FontWeight.SemiBold)
                        Text("Все звонки записываются автоматически", color = C.text2, fontSize = 12.sp)
                    } else {
                        Text("⚠ Не установлено", color = C.yellow, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = onRequest, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) {
                            Text("Установить как телефон по умолчанию")
                        }
                    }
                }
            }
            Card(colors = CardDefaults.cardColors(containerColor = C.surface2), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Как работает", color = C.text2, fontSize = 11.sp)
                    Spacer(Modifier.height(8.dp))
                    listOf(
                        "1. Установи приложение как телефон по умолчанию",
                        "2. Звони как обычно",
                        "3. Запись идёт автоматически на оба голоса",
                        "4. После звонка — выбери: сохранить клиента или нет",
                    ).forEach { Text(it, color = C.text, fontSize = 13.sp, modifier = Modifier.padding(vertical = 3.dp)) }
                }
            }
        }
    }

    @Composable
    fun SettingsTab(url: String, onChange: (String) -> Unit, onSave: () -> Unit) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Card(colors = CardDefaults.cardColors(containerColor = C.surface2), shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Backend WebSocket URL", color = C.text2, fontSize = 11.sp)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = url, onValueChange = onChange,
                        placeholder = { Text("ws://192.168.1.100:3001", color = C.text3) },
                        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor=C.accent, unfocusedBorderColor=C.border, focusedTextColor=C.text, unfocusedTextColor=C.text),
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text("IP компьютера с бэкендом.\nНайти: ipconfig → IPv4 Address", color = C.text3, fontSize = 11.sp)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onSave, colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.fillMaxWidth()) {
                        Text("Сохранить и переподключить")
                    }
                }
            }
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
