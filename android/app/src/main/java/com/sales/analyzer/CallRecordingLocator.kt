package com.sales.analyzer

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * Many Chinese-market ROMs (Flyme, MIUI, etc.) have a built-in call recorder in the
 * system Dialer that writes a file the moment a call ends — independent of whatever
 * our own AudioRecord capture managed to pick up. If one shows up right after a call,
 * it's a much more reliable source than our live stream, so we look for it and prefer
 * it when present.
 */
object CallRecordingLocator {

    private val PATH_HINTS = listOf(
        "callrecord", "call recordings", "call record", "callrecording",
        "recordings/call", "recorder/call", "phone recordings",
    )

    /** Newest audio file added after [sinceMillis] whose path looks like a call recording. */
    fun findRecordingFile(context: Context, sinceMillis: Long): Uri? {
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection  = arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.RELATIVE_PATH)
        val selection   = "${MediaStore.Audio.Media.DATE_ADDED} >= ?"
        val args        = arrayOf((sinceMillis / 1000).toString())
        val sort        = "${MediaStore.Audio.Media.DATE_ADDED} DESC"

        try {
            context.contentResolver.query(collection, projection, selection, args, sort)?.use { c ->
                val idCol   = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val pathCol = c.getColumnIndexOrThrow(MediaStore.Audio.Media.RELATIVE_PATH)
                while (c.moveToNext()) {
                    val path = (c.getString(pathCol) ?: "").lowercase()
                    if (PATH_HINTS.any { path.contains(it) }) {
                        val id = c.getLong(idCol)
                        Log.d("CallRecordingLocator", "Matched: $path")
                        return ContentUris.withAppendedId(collection, id)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e("CallRecordingLocator", "query failed: ${e.message}")
        }
        return null
    }

    /** Copies a content:// audio Uri into cacheDir so it can be attached to a multipart upload. */
    fun copyToCache(context: Context, uri: Uri): File? {
        return try {
            val ext = context.contentResolver.getType(uri)?.substringAfterLast("/") ?: "m4a"
            val out = File(context.cacheDir, "call_${System.currentTimeMillis()}.$ext")
            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(out).use { output -> input.copyTo(output) }
            } ?: return null
            out
        } catch (e: Exception) {
            Log.e("CallRecordingLocator", "copyToCache failed: ${e.message}")
            null
        }
    }
}
