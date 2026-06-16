const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execSync, spawn }  = require("child_process");
const path  = require("path");
const fs    = require("fs");
const os    = require("os");

const INSTALL_DIR = path.join("C:\\", "SalesAnalyzer");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width:  620,
    height: 580,
    resizable:      false,
    title:          "Sales Analyzer — Установка бекенда",
    backgroundColor:"#0a0a0f",
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// ── helpers ──────────────────────────────────────────────────────────────────

function send(channel, data) {
  win?.webContents.send(channel, data);
}

function log(msg) {
  send("log", msg);
}

function isDockerInstalled() {
  try {
    execSync("docker --version", { stdio: "ignore" });
    return true;
  } catch (_) { return false; }
}

function isDockerRunning() {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch (_) { return false; }
}

function resourcePath(name) {
  // In production electron-builder puts extraResources next to the exe
  const prod = path.join(process.resourcesPath, name);
  // In dev — relative to project root
  const dev  = path.join(__dirname, "..", "..", name);
  return fs.existsSync(prod) ? prod : dev;
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle("check-docker", () => ({
  installed: isDockerInstalled(),
  running:   isDockerInstalled() && isDockerRunning(),
}));

ipcMain.handle("open-docker-download", () => {
  shell.openExternal("https://www.docker.com/products/docker-desktop/");
  return { ok: true };
});

ipcMain.handle("install-backend", async (_, { websiteUrl, groqKey }) => {
  try {
    // 1. Create install dir
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.mkdirSync(path.join(INSTALL_DIR, "backend"), { recursive: true });

    // 2. Copy docker-compose.local.yml
    const composeSrc = resourcePath("docker-compose.local.yml");
    fs.copyFileSync(composeSrc, path.join(INSTALL_DIR, "docker-compose.local.yml"));

    // 3. Write backend/.env
    const envSrc  = resourcePath("backend.env.example");
    let   envText = fs.readFileSync(envSrc, "utf8");

    if (websiteUrl) {
      envText = envText.replace(/^WEBSITE_URL=.*/m, `WEBSITE_URL=${websiteUrl.trim()}`);
    }
    if (groqKey) {
      envText = envText.replace(/^GROQ_API_KEY=.*/m, `GROQ_API_KEY=${groqKey.trim()}`);
    }
    // Generate random device id
    const deviceId = `${os.hostname()}-${Date.now()}`;
    envText = envText.replace(/^DEVICE_ID=.*/m, `DEVICE_ID=${deviceId}`);

    fs.writeFileSync(path.join(INSTALL_DIR, "backend", ".env"), envText, "utf8");

    log("✓ Файлы скопированы в " + INSTALL_DIR);

    // 4. docker compose pull + up
    log("⏳ Загружаем Docker-образы (это может занять несколько минут)...");

    await new Promise((resolve, reject) => {
      const proc = spawn(
        "docker",
        ["compose", "-f", path.join(INSTALL_DIR, "docker-compose.local.yml"), "up", "-d", "--build"],
        { cwd: INSTALL_DIR, shell: true }
      );

      proc.stdout.on("data", d => log(d.toString().trim()));
      proc.stderr.on("data", d => log(d.toString().trim()));

      proc.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`docker compose завершился с кодом ${code}`));
      });
    });

    // 5. Create start/stop scripts on desktop
    const desktop = path.join(os.homedir(), "Desktop");
    fs.writeFileSync(
      path.join(desktop, "Запустить Sales Backend.bat"),
      `@echo off\ndocker compose -f "${INSTALL_DIR}\\docker-compose.local.yml" up -d\necho Бекенд запущен! Порт 3001.\npause\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(desktop, "Остановить Sales Backend.bat"),
      `@echo off\ndocker compose -f "${INSTALL_DIR}\\docker-compose.local.yml" down\necho Бекенд остановлен.\npause\n`,
      "utf8"
    );

    log("✓ Ярлыки запуска/остановки созданы на рабочем столе");
    log("✅ Установка завершена! Бекенд работает на порту 3001.");
    return { ok: true };

  } catch (e) {
    log("❌ Ошибка: " + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("get-local-ip", () => {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "192.168.1.x";
});
