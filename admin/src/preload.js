const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  setToken:    (token)          => ipcRenderer.invoke("api-set-token", token),
  get:         (endpoint)       => ipcRenderer.invoke("api-get",    endpoint),
  post:        (endpoint, body) => ipcRenderer.invoke("api-post",   endpoint, body),
  put:         (endpoint, body) => ipcRenderer.invoke("api-put",    endpoint, body),
  patch:       (endpoint, body) => ipcRenderer.invoke("api-patch",  endpoint, body),
  delete:      (endpoint)       => ipcRenderer.invoke("api-delete", endpoint),
  getAudioData:(filename)       => ipcRenderer.invoke("get-audio-data", filename),
});
