"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { UpdateController, newer } = require("../app/updater.cjs");
const { createUpdater, release } = require("./updater-fixture.cjs");

function setup(overrides = {}) {
  const native = createUpdater();
  const controller = new UpdateController({
    native,
    version: "1.1.0",
    enabled: true,
    ...overrides,
  });
  return { native, controller };
}
test("stable versions compare numerically", () => {
  assert.equal(newer("1.10.0", "1.2.0"), true);
  assert.equal(newer("1.1.0", "1.1.0"), false);
  assert.equal(newer("1.0.0", "1.1.0"), false);
  assert.equal(newer("1.2.0-beta", "1.1.0"), false);
});
test("manual update checks, downloads and recovers failed installer launch", async () => {
  let prepared = 0,
    recovered = 0;
  const { controller, native } = setup({
    prepareInstall: () => {
      prepared++;
    },
    recoverInstall: () => {
      recovered++;
    },
  });
  assert.equal(native.autoDownload, false);
  assert.equal(native.autoInstallOnAppQuit, false);
  assert.equal((await controller.check()).phase, "available");
  assert.equal((await controller.download()).phase, "downloaded");
  assert.equal((await controller.install()).phase, "downloaded");
  assert.equal(prepared, 1);
  assert.equal(recovered, 1);
});
test("invalid release file and missing checksum cannot be downloaded", async () => {
  const { controller, native } = setup();
  native.checkForUpdates = async () => {
    const info = release();
    info.files[0].url = "https://example.com/untrusted.exe";
    native.emit("update-available", info);
  };
  assert.equal((await controller.check()).phase, "error");
  await assert.rejects(controller.download());
});
test("integrity failure leaves no installable update", async () => {
  const { controller, native } = setup();
  await controller.check();
  native.downloadUpdate = async () => {
    throw new Error("checksum failure");
  };
  assert.equal((await controller.download()).phase, "error");
  await assert.rejects(controller.install());
});
test("install preparation guard keeps the verified download available", async () => {
  let installs = 0;
  const { controller, native } = setup({
    prepareInstall: () => {
      throw new Error("请等待上传完成");
    },
  });
  native.quitAndInstall = () => {
    installs++;
  };
  await controller.check();
  await controller.download();
  assert.match((await controller.install()).error, /等待上传/);
  assert.equal(installs, 0);
});
test("current release and disabled development mode are handled", async () => {
  const { controller, native } = setup();
  native.checkForUpdates = async () => {
    native.emit("update-not-available");
  };
  assert.equal((await controller.check()).phase, "current");
  const disabled = new UpdateController({ version: "1.1.0", enabled: false });
  await assert.rejects(disabled.check(), /正式安装版/);
});
