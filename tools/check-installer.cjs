"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
  if (process.platform !== "win32")
    throw new Error(
      "安装目录回归检查须在 Windows 执行，请使用 Windows 打包环境。",
    );
  const { getMakeNsisPath } = require("app-builder-lib/out/toolsets/windows");
  const compiler = await getMakeNsisPath(
    config.toolsets?.nsis,
    config.nsis?.customNsisBinary,
  );
  fs.mkdirSync(path.join(root, "validation"), { recursive: true });
  const result = path.join(root, "validation/installer-path-test.txt");
  if (fs.existsSync(result)) fs.unlinkSync(result);
  const compiled = spawnSync(
    compiler.path,
    ["/V1", "tests/installer-paths.nsi"],
    {
      cwd: root,
      env: { ...process.env, ...compiler.env },
      windowsHide: true,
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (compiled.error || compiled.status !== 0)
    throw new Error(
      `安装路径测试编译失败。${compiled.error?.message || compiled.stderr || compiled.stdout}`,
    );
  const tested = spawnSync(
    path.join(root, "validation/installer-path-test.exe"),
    ["/S"],
    { cwd: root, windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  if (
    tested.error ||
    tested.status !== 0 ||
    !fs.existsSync(result) ||
    !fs.readFileSync(result, "utf8").startsWith("PASS:")
  )
    throw new Error("安装目录回归测试失败，已阻止打包。");
  process.stdout.write(
    "INSTALLER_APP_DIRECTORY_REQUIRED passed. Final installer UI validation is still required.\n",
  );
}

module.exports = checkInstaller;
module.exports.validateSource = validateSource;
if (require.main === module)
  checkInstaller().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
