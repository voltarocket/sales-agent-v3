package com.sales.analyzer

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder.AudioSource
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
        // VOICE_COMMUNICATION enables hardware AEC, which actively cancels whatever
        // comes out of the earpiece/speaker from the mic signal — on speakerphone that's
        // literally the other party's voice, so AEC was erasing it. Plain MIC skips that
        // processing and picks up speaker bleed into the mic normally.
        val record = try {
            AudioRecord(
                AudioSource.MIC,
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
