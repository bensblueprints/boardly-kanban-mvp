// Desktop mode: boots the same Express server on a free local port,
// stores data in Electron's userData dir, and opens a window auto-logged-in as admin.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');

let win;

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const autologinToken = crypto.randomBytes(24).toString('hex');

  const { createApp } = require(path.join(__dirname, '..', 'server', 'app.js'));
  const server = await createApp({
    dataDir,
    autologinToken,
    adminPassword: process.env.ADMIN_PASSWORD || 'admin',
    // Local app writing to your own disk — allow big attachments (installers,
    // videos, design files) rather than the conservative shared-server default.
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 4096)
  });

  // listen on port 0 → OS picks a free port (no collisions with a VPS install)
  const listener = server.listen(0, '127.0.0.1', async () => {
    const port = listener.address().port;
    // MCP (if the user enabled it) binds its own fixed port so the endpoint
    // URL configured in an AI client keeps working across restarts.
    await server.startMcpIfEnabled();
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      autoHideMenuBar: true,
      backgroundColor: '#09090b',
      title: 'Boardly',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    // open external links in the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL(`http://127.0.0.1:${port}/auth/auto?token=${autologinToken}`);
  });

  app.on('window-all-closed', async () => {
    listener.close();
    try { await server.shutdownMcp(); } catch {}
    app.quit();
  });
});
