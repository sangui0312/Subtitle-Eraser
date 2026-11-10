"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateSource } = require("../tools/check-installer.cjs");
const root = path.resolve(__dirname, "..");
const config = require("../package.json").build;
const source = fs.readFileSync(path.join(root, "build/installer.nsh"), "utf8");
const rules = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

test("packaging invokes the installer directory rule", () => {
  assert.equal(config.beforePack, "tools/check-installer.cjs");
  assert.doesNotThrow(() => validateSource(config, source, rules));
});
test("omitting InstallDir prevents packaging", () => {
  const broken = source.replace(/^\s*InstallDir[^\r\n]+/m, "");
  assert.throws(() => validateSource(config, broken, rules), /InstallDir/);
});
test("omitting the rule or substituting installer configuration prevents packaging", () => {
  assert.throws(() => validateSource(config, source, ""), /规则/);
  assert.throws(
    () => validateSource({ ...config, nsis: {} }, source, rules),
    /配置/,
  );
});
