package com.sales.analyzer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class PostCallActivity : ComponentActivity() {

    private val backendHost get() = intent.getStringExtra("backendHost") ?: "192.168.1.100"
    private val backendUrl  get() = "http://$backendHost:3001"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val phone      = intent.getStringExtra("phone")          ?: ""
        val score      = intent.getIntExtra("score", 0)
        val summary    = intent.getStringExtra("summary")        ?: ""
        val transcript = intent.getStringExtra("transcript")     ?: ""
        val rec        = intent.getStringExtra("recommendation") ?: ""
        val duration   = intent.getIntExtra("duration", 0)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Screen(phone, score, summary, transcript, rec, duration,
                    onDiscard = { saveCallOnly(phone, duration, transcript, summary, score); finish() },
                    onSave    = { company, cname -> saveWithContact(phone, duration, transcript, summary, score, rec, company, cname) }
                )
            }
        }
    }

    @Composable
    fun Screen(phone: String, score: Int, summary: String, transcript: String, rec: String, duration: Int, onDiscard: () -> Unit, onSave: (String,String) -> Unit) {
        val scope = rememberCoroutineScope()
        var step    by remember { mutableStateOf("ask") }
        var company by remember { mutableStateOf("") }
        var cname   by remember { mutableStateOf("") }
        val sc = if (score>=75) C.green else if (score>=50) C.yellow else C.red

        Column(Modifier.fillMaxSize().background(C.bg).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Звонок завершён", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text("$phone · ${duration/60}:${String.format("%02d",duration%60)}", color = C.text2, fontSize = 13.sp, fontFamily = FontFamily.Monospace)

            Card(colors = CardDefaults.cardColors(containerColor = C.surface2), shape = RoundedCornerShape(12.dp)) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(score.toString(), color = sc, fontSize = 36.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                    Text("/100", color = C.text2, fontSize = 16.sp, modifier = Modifier.padding(start=4.dp))
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Оценка звонка", color = C.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        if (summary.isNotEmpty()) Text(summary, color = C.text2, fontSize = 11.sp, lineHeight = 16.sp)
                    }
                }
            }

            if (rec.isNotEmpty()) {
                Card(colors = CardDefaults.cardColors(containerColor = C.surface2), shape = RoundedCornerShape(12.dp)) {
                    Column(Modifier.padding(14.dp)) {
                        Text("Рекомендация", color = C.text2, fontSize = 10.sp)
                        Spacer(Modifier.height(4.dp))
                        Text(rec, color = C.accent2, fontSize = 13.sp, lineHeight = 18.sp)
                    }
                }
            }

            HorizontalDivider(color = C.border)

            when (step) {
                "ask" -> {
                    Text("Сохранить клиента в базу?", color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = { onDiscard() }, modifier = Modifier.weight(1f)) { Text("Только аналитика") }
                        Button(onClick = { step = "form" }, modifier = Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = C.accent, contentColor = Color(0xFF0A0A0F))) { Text("Создать карточку") }
                    }
                }
                "form" -> {
                    Text("Данные клиента", color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(value=company, onValueChange={company=it}, label={Text("Название компании *", color=C.text2)}, colors=OutlinedTextFieldDefaults.colors(focusedBorderColor=C.accent,unfocusedBorderColor=C.border,focusedTextColor=C.text,unfocusedTextColor=C.text), modifier=Modifier.fillMaxWidth())
                    OutlinedTextField(value=cname,   onValueChange={cname=it},   label={Text("Имя контакта",         color=C.text2)}, colors=OutlinedTextFieldDefaults.colors(focusedBorderColor=C.accent,unfocusedBorderColor=C.border,focusedTextColor=C.text,unfocusedTextColor=C.text), modifier=Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick={step="ask"}, modifier=Modifier.weight(1f)) { Text("← Назад") }
                        Button(onClick={if(company.isNotBlank()){step="saving";scope.launch{onSave(company,cname)}}}, enabled=company.isNotBlank(), modifier=Modifier.weight(1f), colors=ButtonDefaults.buttonColors(containerColor=C.accent)) { Text("Сохранить") }
                    }
                }
                "saving" -> Box(Modifier.fillMaxWidth(), contentAlignment=Alignment.Center) { CircularProgressIndicator(color=C.accent) }
                "done"   -> { Text("✓ Сохранено!", color=C.green, fontSize=16.sp, fontWeight=FontWeight.Bold); LaunchedEffect(Unit){kotlinx.coroutines.delay(1500);finish()} }
            }
        }
    }

    private fun saveCallOnly(phone: String, duration: Int, transcript: String, summary: String, score: Int) {
        post("/api/calls", JSONObject().apply { put("phone",phone);put("duration",duration);put("transcript",transcript);put("summary",summary);put("score",score);put("saved",false) })
    }

    private fun saveWithContact(phone: String, duration: Int, transcript: String, summary: String, score: Int, rec: String, company: String, cname: String) {
        val client = OkHttpClient()
        val body = JSONObject().apply { put("phone",phone);put("duration",duration);put("transcript",transcript);put("summary",summary);put("score",score);put("saved",true) }
        client.newCall(Request.Builder().url("$backendUrl/api/calls").post(body.toString().toRequestBody("application/json".toMediaType())).build())
            .enqueue(object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) {}
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val callId = JSONObject(response.body?.string()?:"{}").optInt("id")
                        post("/api/contacts", JSONObject().apply { put("phone",phone);put("company",company);put("name",cname);put("summary",summary);put("transcript",transcript);put("score",score);put("recommendation",rec);put("call_id",callId) })
                        runOnUiThread { finish() }
                    } catch(_: Exception) {}
                }
            })
    }

    private fun post(endpoint: String, json: JSONObject) {
        try {
            OkHttpClient().newCall(Request.Builder().url("$backendUrl$endpoint")
                .post(json.toString().toRequestBody("application/json".toMediaType())).build()).execute()
        } catch(_: Exception) {}
    }
}
