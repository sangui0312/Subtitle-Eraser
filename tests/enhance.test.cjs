"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { enhanceOptions, enhanceRequest } = require("../app/enhance.cjs");
const { Engine } = require("../app/engine.cjs");
const { Store } = require("../app/store.cjs");

function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-test-"));
  const store = new Store(root, path.join(root, "output"));
  const calls = [];
  const client = {
    upload: async () => "mediakit://test",
    submitEnhance: async (route, body) => {
      calls.push({ route, body: structuredClone(body) });
      return { task_id: "quality-task" };
    },
    query: async () => ({
      status: "completed",
      result: { video_url: "https://example.com/output.mp4" },
    }),
    download: async (_url, destination) =>
      fs.writeFileSync(destination, "test-video"),
    ...extra,
  };
  const engine = new Engine({
    store,
    client,
    hasKey: () => true,
    identity: () => "test-key",
  });
  engine.schedule = () => {};
  t.after(() => {
    engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, engine, client, calls };
}

test("all enhancement versions use the correct route and retain optional parameters", () => {
  for (const [version, expected] of [
    ["standard", "enhance-video"],
    ["professional", "enhance-video"],
    ["fast", "enhance-video-fast"],
    ["generative", "enhance-video-generative"],
  ]) {
    const config = enhanceOptions({
      version,
      settings: {
        resolution: "1080p",
        bitrate: 8000,
        fps: 30,
        queue_id: "queue",
        callback_url: "https://example.com/callback",
        callback_args: "context",
      },
    });
    const result = enhanceRequest(config, "mediakit://video", "token");
    assert.equal(result.route, expected);
    assert.equal(result.body.video_url, "mediakit://video");
    assert.equal(result.body.client_token, "token");
    assert.equal(
      result.body.tool_version,
      ["standard", "professional"].includes(version) ? version : undefined,
    );
    assert.equal(result.body.bitrate, 8000);
    assert.equal(result.body.callback_args, "context");
  }
});
test("enhancement validates version combinations and professional encoding rules", () => {
  assert.throws(
    () => enhanceOptions({ version: "fast", settings: { scene: "ugc" } }),
    /不支持/,
  );
  assert.throws(
    () =>
      enhanceOptions({ version: "generative", settings: { resolution: "8k" } }),
    /无效/,
  );
  assert.throws(
    () =>
      enhanceOptions({
        version: "professional",
        settings: { resolution: "4k", resolution_limit: 1000 },
      }),
    /只能选择/,
  );
  assert.throws(
    () =>
      enhanceOptions({
        version: "professional",
        settings: { codec: "h264", bit_depth: 10 },
      }),
    /组合/,
  );
  assert.throws(
    () =>
      enhanceOptions({
        version: "professional",
        settings: { dynamic_range: "hdr", bit_depth: 8 },
      }),
    /HDR/,
  );
  assert.throws(
    () =>
      enhanceOptions({
        version: "professional",
        settings: { scene: "old_film", skin_smoothing: 20 },
      }),
    /老片/,
  );
  assert.doesNotThrow(() =>
    enhanceOptions({
      version: "professional",
      settings: { pix_fmt: "gbrp16le", dynamic_range: "hdr" },
    }),
  );
});
test("enhancement uses the normal task queue, saves output and recovers original request", async (t) => {
  let fail = true;
  const { engine, client, calls, store } = setup(t);
  client.submitEnhance = async (route, body) => {
    calls.push({ route, body: structuredClone(body) });
    if (fail) {
      fail = false;
      throw new Error("network timeout");
    }
    return { task_id: "quality-task" };
  };
  const task = engine.addURL("https://example.com/source.mp4", "enhance");
  engine.update(task.id, { version: "fast", settings: { resolution: "4k" } });
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(task.state, "submission_unknown");
  const first = structuredClone(task.request);
  const resumed = new Engine({
    store: new Store(path.dirname(store.file)),
    client,
    hasKey: () => true,
    identity: () => "test-key",
  });
  resumed.schedule = () => {};
  t.after(() => resumed.stop());
  resumed.retry(task.id);
  await resumed.pump();
  assert.deepEqual(calls[1].body, first);
  assert.equal(calls[1].route, "enhance-video-fast");
  await resumed.pump();
  assert.equal(resumed.task(task.id).state, "completed");
  assert.equal(
    fs.readFileSync(resumed.task(task.id).outputPath, "utf8"),
    "test-video",
  );
});
test("cloud outputs stay available without treating them as HTTP downloads", async (t) => {
  const { engine } = setup(t, {
    query: async () => ({
      status: "completed",
      result: { video_url: "tos://bucket/file.mp4" },
    }),
  });
  const task = engine.addURL("tos://source/video.mp4", "enhance");
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.equal(task.cloudOutput, "tos://bucket/file.mp4");
  assert.equal(task.outputPath, undefined);
});
test("professional video filenames respect high depth output", async (t) => {
  const { engine } = setup(t);
  const task = engine.addURL("https://example.com/source.mp4", "enhance");
  engine.update(task.id, {
    version: "professional",
    settings: { bit_depth: 16 },
  });
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.match(task.outputPath, /\.mov$/);
});

test("EXR archive keeps its detected format and bytes", async (t) => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
  const { engine } = setup(t, {
    download: async (_url, destination) => fs.writeFileSync(destination, bytes),
  });
  const task = engine.addURL("https://example.com/source.mp4", "enhance");
  engine.update(task.id, {
    version: "professional",
    settings: { bit_depth: 16, codec: "exr" },
  });
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.match(task.outputPath, /\.zip$/);
  assert.deepEqual(fs.readFileSync(task.outputPath), bytes);
});
