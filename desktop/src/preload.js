const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Recording
  startRecording: (d)     => ipcRenderer.invoke("start-recording", d),
  stopRecording:  ()      => ipcRenderer.invoke("stop-recording"),
  sendAudioChunk: (chunk) => ipcRenderer.send("audio-chunk", chunk),

  // Backend REST
  get:    (endpoint)        => ipcRenderer.invoke("api-get",    endpoint),
  post:   (endpoint, body)  => ipcRenderer.invoke("api-post",   endpoint, body),
  put:    (endpoint, body)  => ipcRenderer.invoke("api-put",    endpoint, body),
  delete: (endpoint)        => ipcRenderer.invoke("api-delete", endpoint),

  // Events
  on:  (ch, cb) => {
    const ok = ["ws-status","session-started","processing","call-analyzed","stream-error","data-updated"];
    if (ok.includes(ch)) ipcRenderer.on(ch, (_,...a) => cb(...a));
  },
  off: (ch) => ipcRenderer.removeAllListeners(ch),
});
