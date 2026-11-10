"use strict";
const fs = require("node:fs");
const path = require("node:path");

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const handle = fs.openSync(temp, "w");
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
}

class Store {
  constructor(root, outputDir) {
    this.file = path.join(root, "workspace.json");
    this.data = {
      schema: 1,
      settings: { outputDir, theme: "light" },
      tasks: [],
    };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        saved.schema !== 1 ||
        !Array.isArray(saved.tasks) ||
        !saved.settings
      ) {
        throw new Error(
          "任务记录格式无法读取，请保留个人数据目录并联系维护者。",
        );
      }
      this.data = saved;
    }
  }
  save() {
    writeJSON(this.file, this.data);
  }
}

module.exports = { Store, writeJSON };
