// Implements window.api using Tauri v2 IPC.
// Loaded before renderer.js so it can use window.api without changes.
(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const _unlisteners = {};

  window.api = {
    get(endpoint) {
      return invoke("api_get", { endpoint });
    },
    post(endpoint, body) {
      return invoke("api_post", { endpoint, body: JSON.stringify(body ?? {}) });
    },
    put(endpoint, body) {
      return invoke("api_put", { endpoint, body: JSON.stringify(body ?? {}) });
    },
    delete(endpoint) {
      return invoke("api_delete", { endpoint });
    },

    startRecording(data) {
      return invoke("start_recording", {
        phone: data.phone || "",
        managerId: data.managerId || 1,
      });
    },
    stopRecording() {
      return invoke("stop_recording");
    },
    sendAudioChunk(chunk) {
      // chunk is ArrayBuffer from MediaRecorder — convert to number array for Tauri IPC
      invoke("send_audio_chunk", { chunk: Array.from(new Uint8Array(chunk)) });
    },

    async on(channel, cb) {
      if (_unlisteners[channel]) await _unlisteners[channel]();
      _unlisteners[channel] = await listen(channel, (e) => cb(e.payload));
    },
    async off(channel) {
      if (_unlisteners[channel]) {
        await _unlisteners[channel]();
        delete _unlisteners[channel];
      }
    },
  };
})();
