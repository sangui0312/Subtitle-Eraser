"use strict";
const fs = require("node:fs");
const path = require("node:path");

function validateSource(config, source, rules) {
  if (!rules.includes("INSTALLER_APP_DIRECTORY_REQUIRED"))
    throw new Error("缺少安装器默认软件文件夹规则。");
  if (
    config.productName !== "SubtitleEraser" ||
    config.nsis?.include !== "build/installer.nsh"
  )
    throw new Error("安装器未使用项目指定的英文软件目录及 NSIS 配置。");
  if (
    !/^\s*InstallDir\s+"\$LOCALAPPDATA\\Programs\\\$\{APP_FILENAME\}"\s*$/m.test(
      source,
    )
  )
    throw new Error(
      "必须显式声明带软件子文件夹的 InstallDir，以覆盖浏览选目录行为。",
    );
  if (
    !source.includes("MUI_PAGE_CUSTOMFUNCTION_SHOW ShowAppDirectory") ||
    !source.includes("!insertmacro NormalizeAppDirectory")
  )
    throw new Error("缺少目录页显示或安装前的路径保护。");
}

async function checkInstaller(context) {
  const root = context?.packager?.projectDir || path.resolve(__dirname, "..");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const config = context?.packager?.config || pkg.build;
  validateSource(
    config,
    fs.readFileSync(path.join(root, "build/installer.nsh"), "utf8"),
    fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
  );
  process.stdout.write(
    "INSTALLER_APP_DIRECTORY_REQUIRED static configuration check passed.\n",
  );
}

module.exports = checkInstaller;
module.exports.validateSource = validateSource;
if (require.main === module)
  checkInstaller().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
