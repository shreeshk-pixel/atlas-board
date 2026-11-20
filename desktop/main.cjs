const { app, BrowserWindow, shell } = require("electron");

const SITE = "https://atlas-board-sigma.vercel.app";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "ATLAS",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SITE)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(SITE);
});
