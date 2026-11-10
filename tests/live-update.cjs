"use strict";

// Run after publishing with: electron tests/live-update.cjs
// This checks a simulated older version against the real public release.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { NsisUpdater } = require("electron-updater");
const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const { UpdateController } = require("../app/updater.cjs");

const validation = path.resolve(__dirname, "../validation");
const profile = path.join(validation, "live-update-profile");
const cache = path.join(validation, "live-update-cache");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const adapter = {
    version: "0.0.0", name: "subtitle-eraser", isPackaged: true,
    appUpdateConfigPath: path.resolve(__dirname, "../dist/win-unpacked/resources/app-update.yml"),
    userDataPath: profile, baseCachePath: cache,
    whenReady: () => app.whenReady(), relaunch: () => {}, quit: () => {}, onQuit: () => {}
  };
  const native = new NsisUpdater(undefined, adapter);
  native.httpExecutor = new ElectronHttpExecutor();
  const controller = new UpdateController({
    native, version: "0.0.0", enabled: true,
    prepareInstall: () => { throw new Error("Live test does not install software"); }
  });
  const latest = await controller.check();
  assert.equal(latest.phase, "available", latest.error);
  assert.equal(latest.version, require("../package.json").version);
  process.stdout.write(`Public update found: ${latest.version}\n`);
  const downloaded = await controller.download();
  assert.equal(downloaded.phase, "downloaded", downloaded.error);
  const name = `SubtitleEraser-Setup-${latest.version}-x64.exe`;
  const relative = fs.readdirSync(cache, { recursive: true }).find(file => path.basename(file) === name);
  assert.ok(relative, "Downloaded installer exists in isolated cache");
  const bytes = fs.readFileSync(path.join(cache, relative));
  const local = fs.readFileSync(path.resolve(__dirname, "../dist", name));
  assert.ok(bytes.equals(local), "Public installer matches the validated local installer");
  const report = { passed: true, publicCheck: true, realDownload: true, sha512VerifiedByUpdater: true, localBinaryMatch: true, installed: false, version: latest.version, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  fs.writeFileSync(path.join(validation, "live-update-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  app.quit();
}).catch(error => {
  fs.writeFileSync(path.join(validation, "live-update-error.txt"), error.stack, "utf8");
  process.stderr.write(error.stack + "\n");
  app.exit(1);
});
