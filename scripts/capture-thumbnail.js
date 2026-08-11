// Renders launch-kit/thumbnail.html at exactly 1280x720 and saves a PNG
// (Whop product thumbnail) via the repo's Electron devDependency.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(ROOT, 'launch-kit', 'thumbnail.html'));
  await new Promise((r) => setTimeout(r, 700)); // let images/fonts settle
  const img = await win.webContents.capturePage();
  const out = path.join(ROOT, 'launch-kit', 'whop-thumbnail.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out);
  app.quit();
});
