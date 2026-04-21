const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Auth
  login:         (creds) => ipcRenderer.invoke("api-login", creds),
  setToken:      (token) => ipcRenderer.invoke("api-set-token", token),
  getWsStatus:   ()      => ipcRenderer.invoke("ws-status-query"),

  // Recording
  startRecording: (d)     => ipcRenderer.invoke("start-recording", d),
  stopRecording:  ()      => ipcRenderer.invoke("stop-recording"),
  sendAudioChunk: (chunk) => ipcRenderer.send("audio-chunk", chunk),

  // Audio file operations
  saveAudioRecording: (callId, audioBuffer) => ipcRenderer.invoke("save-audio", { callId, audioBuffer }),
  getAudioData:       (filename)            => ipcRenderer.invoke("get-audio-data", filename),
  deleteAudioFile:    (filename)            => ipcRenderer.invoke("delete-audio-file", filename),
  downloadAudio:      (audioId)             => ipcRenderer.invoke("download-audio", audioId),
  transcribeAudio:    (filename)            => ipcRenderer.invoke("transcribe-audio", filename),

  // REST API (local data routes + backend AI routes)
  get:    (endpoint)        => ipcRenderer.invoke("api-get",    endpoint),
  post:   (endpoint, body)  => ipcRenderer.invoke("api-post",   endpoint, body),
  put:    (endpoint, body)  => ipcRenderer.invoke("api-put",    endpoint, body),
  delete: (endpoint)        => ipcRenderer.invoke("api-delete", endpoint),

  // Events from main process
  on:  (ch, cb) => {
    const ok = ["ws-status", "session-started", "processing", "call-analyzed", "stream-error", "data-updated"];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_, ...a) => cb(...a));
  },
  off: (ch) => ipcRenderer.removeAllListeners(ch),
});
