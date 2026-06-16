const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  checkDocker:       ()        => ipcRenderer.invoke("check-docker"),
  openDockerDownload:()        => ipcRenderer.invoke("open-docker-download"),
  installBackend:    (opts)    => ipcRenderer.invoke("install-backend", opts),
  getLocalIp:        ()        => ipcRenderer.invoke("get-local-ip"),
  onLog: (cb) => ipcRenderer.on("log", (_, msg) => cb(msg)),
});
