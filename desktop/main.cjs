const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORT = 47321;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function lanOrigins() {
  const origins = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      const v4 = net.family === "IPv4" || net.family === 4;
      if (v4 && !net.internal) origins.push(`http://${net.address}:${PORT}`);
    }
  }
  return origins;
}

function authSecret() {
  const file = path.join(app.getPath("userData"), "auth-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first launch */
  }
  const value = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

let child = null;
let win = null;

function startServer() {
  const root = app.getAppPath();
  const entry = path.join(root, ".output", "server", "index.mjs");
  const dataDir = path.join(app.getPath("userData"), "board");
  fs.mkdirSync(dataDir, { recursive: true });
  const phone = lanOrigins();
  child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      NITRO_PORT: String(PORT),
      HOST: "0.0.0.0",
      NITRO_HOST: "0.0.0.0",
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: authSecret(),
      ATLAS_DATA_DIR: dataDir,
      ATLAS_EXTRA_ORIGINS: phone.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const keep = (chunk) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (code) => {
    if (code && !app.isQuitting) {
      dialog.showErrorBox("ATLAS stopped", log || `The board exited (${code}).`);
    }
  });
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > 90000) reject(new Error("The board did not start."));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

app.whenReady().then(async () => {
  startServer();
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "ATLAS",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await waitForServer();
    const phone = lanOrigins()[0];
    if (phone) win.setTitle(`ATLAS — on your phone open ${phone}`);
    await win.loadURL(ORIGIN);
  } catch (error) {
    dialog.showErrorBox("ATLAS", error instanceof Error ? error.message : "The board did not start.");
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (child && !child.killed) child.kill();
});
