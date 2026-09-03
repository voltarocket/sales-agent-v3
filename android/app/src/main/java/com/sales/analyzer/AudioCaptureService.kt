package com.sales.analyzer

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder.AudioSource
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*

class AudioCaptureService : Service() {

    private val CHANNEL_ID  = "sales_recording"
    private val NOTIF_ID    = 1001
    private val SAMPLE_RATE = 16000
    private val BUFFER_SIZE = AudioRecord.getMinBufferSize(
        SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) * 4

    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var aec: AcousticEchoCanceler? = null
    private var ns:  NoiseSuppressor?      = null
    private var agc: AutomaticGainControl? = null

    companion object {
        const val ACTION_START = "START"
        const val ACTION_STOP  = "STOP"
        const val EXTRA_PHONE  = "phone"
        var streamer: AudioStreamer? = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val phone = intent.getStringExtra(EXTRA_PHONE) ?: "unknown"
                startForeground(NOTIF_ID, buildNotif("Запись звонка..."))
                startRecording(phone)
            }
            ACTION_STOP -> {
                stopRecording()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startRecording(phone: String) {
        if (isRecording) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            Log.e("AudioCapture", "RECORD_AUDIO not granted, aborting capture")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        // Plain MIC is silently muted by the platform while a telephony call is active
        // on many Android 10+ builds (confirmed on this device: Flyme Lite 1.0.1.0RU /
        // Android 15) — AudioRecord.read() keeps returning zero-filled buffers all call
        // long. VOICE_COMMUNICATION is the source the platform actually keeps live during
        // a call, but it ships with hardware AEC/NS/AGC attached, and on speakerphone the
        // AEC treats the other party's voice coming out of the speaker as echo and cancels
        // it. So: use VOICE_COMMUNICATION for a live signal, then explicitly disable the
        // effects bound to its audio session so the speaker bleed survives.
        val record = try {
            AudioRecord(
                AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, BUFFER_SIZE
            )
        } catch (e: SecurityException) {
            Log.e("AudioCapture", "AudioRecord init failed: ${e.message}")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e("AudioCapture", "AudioRecord not initialized (state=${record.state})")
            record.release()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        audioRecord = record

        val sessionId = record.audioSessionId
        if (AcousticEchoCanceler.isAvailable()) {
            aec = AcousticEchoCanceler.create(sessionId)?.apply { enabled = false }
        }
        if (NoiseSuppressor.isAvailable()) {
            ns = NoiseSuppressor.create(sessionId)?.apply { enabled = false }
        }
        if (AutomaticGainControl.isAvailable()) {
            agc = AutomaticGainControl.create(sessionId)?.apply { enabled = false }
        }
        streamer?.startCall(phone, AppSession.managerId)
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            Log.e("AudioCapture", "startRecording() did not enter RECORDING state")
        }
        isRecording = true
        scope.launch {
            val buf = ByteArray(BUFFER_SIZE)
            while (isRecording) {
                val read = audioRecord?.read(buf, 0, buf.size) ?: 0
                if (read > 0) streamer?.sendChunk(buf.copyOf(read))
                else if (read < 0) Log.e("AudioCapture", "AudioRecord.read() error: $read")
            }
        }
        Log.d("AudioCapture", "Recording started: $phone")
    }

    private fun stopRecording() {
        isRecording = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        aec?.release(); aec = null
        ns?.release();  ns  = null
        agc?.release(); agc = null
        streamer?.endCall()
        scope.cancel()
        Log.d("AudioCapture", "Recording stopped")
    }

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL_ID, "Запись звонка", NotificationManager.IMPORTANCE_LOW)
        ch.setSound(null, null)
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
    }

    private fun buildNotif(text: String): Notification {
        val stop = PendingIntent.getService(this, 0,
            Intent(this, AudioCaptureService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Diallog")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .addAction(android.R.drawable.ic_media_pause, "Стоп", stop)
            .setOngoing(true).build()
    }

    override fun onDestroy() { stopRecording(); super.onDestroy() }
}
