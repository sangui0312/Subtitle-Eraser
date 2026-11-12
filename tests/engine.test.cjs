"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Store } = require("../app/store.cjs");
const { Engine, options } = require("../app/engine.cjs");
const { Client, transfer, safeMessage } = require("../app/client.cjs");

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-eraser-test-"));
  const store = new Store(root, path.join(root, "output"));
  const calls = { submits: [], queries: [], downloads: [], uploads: [] };
  const client = {
    upload: async (file) => {
      calls.uploads.push(file);
      return "mediakit://fixture";
    },
    submit: async (body) => {
      calls.submits.push(structuredClone(body));
      return { task_id: "cloud-1" };
    },
    query: async (id) => {
      calls.queries.push(id);
      return {
        status: "completed",
        result: { video_url: "https://example.com/output.mp4" },
      };
    },
    download: async (url, target) => {
      calls.downloads.push(url);
      fs.writeFileSync(target, "simulated-video");
    },
    ...overrides,
  };
  const engine = new Engine({
    store,
    client,
    hasKey: () => true,
    identity: () => "same-test-key",
    pollMs: 3600000,
  });
  // Tests advance one queue turn explicitly, preventing background races.
  engine.schedule = () => {};
  t.after(() => {
    engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, engine, client, calls };
}

test("URL task submits v5 with one persistent client token and saves output", async (t) => {
  const { engine, calls, store } = setup(t);
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(task.state, "processing");
  assert.equal(calls.submits[0].model_version, "v5");
  assert.equal(calls.submits[0].mode, "Subtitle");
  assert.equal(calls.submits[0].client_token, task.token);
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.equal(fs.readFileSync(task.outputPath, "utf8"), "simulated-video");
  assert.equal(
    new Store(path.dirname(store.file)).data.tasks[0].state,
    "completed",
  );
});

test("elapsed time excludes the queue and persists upload through completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { engine, root, store } = setup(t, {
    upload: async () => {
      assert.equal(task.startedAt, 160000);
      t.mock.timers.tick(5000);
      return "mediakit://fixture";
    },
  });
  const file = path.join(root, "timing.mp4");
  fs.writeFileSync(file, "fixture");
  const [task] = engine.addFiles([file]);
  engine.enqueue([task.id]);
  assert.equal(task.startedAt, null);
  t.mock.timers.tick(60000);
  await engine.pump();
  assert.equal(task.startedAt, 160000);
  assert.equal(task.submittedAt, 165000);
  t.mock.timers.tick(10000);
  await engine.pump();
  assert.equal(task.completedAt - task.startedAt, 15000);
  const reopened = new Store(path.dirname(store.file));
  assert.equal(reopened.data.tasks[0].startedAt, 160000);
  assert.equal(reopened.data.tasks[0].completedAt, 175000);
});

test("uncertain submission resumes the original timer and fresh attempts reset it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const { engine, client } = setup(t, {
    submit: async () => {
      throw new Error("timeout");
    },
  });
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(task.finishedAt, 100000);
  t.mock.timers.tick(5000);
  engine.retry(task.id);
  assert.equal(task.finishedAt, null);
  client.submit = async () => ({ task_id: "recovered" });
  await engine.pump();
  assert.equal(task.startedAt, 100000);
  const fresh = engine.addURL("https://example.com/fresh.mp4");
  engine.patch(fresh, { state: "error", startedAt: 10000, finishedAt: 20000 });
  engine.enqueue([fresh.id]);
  assert.equal(fresh.startedAt, null);
  await engine.pump();
  await engine.pump();
  assert.equal(fresh.startedAt, 105000);
});

test("recovery records completion time and leaves legacy start time unknown", async (t) => {
  const { engine, root } = setup(t);
  const task = engine.addURL("https://example.com/video.mp4");
  const outputPath = path.join(root, "recovered.mp4");
  fs.writeFileSync(outputPath, "video");
  engine.patch(task, {
    taskId: "legacy-task",
    state: "download_pending",
    outputPath,
    outputSize: 5,
  });
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.equal(task.startedAt, undefined);
  assert.ok(task.completedAt > 0);
  const completedAt = task.completedAt;
  await engine.download(task);
  assert.equal(task.completedAt, completedAt);
});

test("manual region uses Text and normalized coordinates including top half", async (t) => {
  const { engine, calls } = setup(t);
  const task = engine.addURL("https://example.com/video.mp4");
  const rect = {
    top_left_x: 0.1,
    top_left_y: 0.1,
    bottom_right_x: 0.8,
    bottom_right_y: 0.3,
  };
  engine.update(task.id, { selection: "region", rect, modelVersion: "v5.6" });
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(calls.submits[0].mode, "Text");
  assert.deepEqual(calls.submits[0].erase_ratio_location, [rect]);
  assert.equal(calls.submits[0].model_version, "v5.6");
});

test("processing mode and region selection serialize independently with multiple rectangles", async (t) => {
  const { engine, calls } = setup(t);
  const rects = [
    {
      top_left_x: 0.1,
      top_left_y: 0.1,
      bottom_right_x: 0.4,
      bottom_right_y: 0.3,
    },
    {
      top_left_x: 0.2,
      top_left_y: 0.7,
      bottom_right_x: 0.8,
      bottom_right_y: 0.9,
    },
  ];
  for (const mode of ["Text", "Subtitle"]) {
    for (const selection of ["auto", "region"]) {
      const task = engine.addURL("https://example.com/video.mp4");
      engine.update(task.id, { mode, selection, rects });
      engine.enqueue([task.id]);
      await engine.pump();
      const request = calls.submits.at(-1);
      assert.equal(request.mode, mode);
      assert.deepEqual(
        request.erase_ratio_location,
        selection === "region" ? rects : undefined,
      );
      await engine.pump();
    }
  }
});

test("time ranges and custom subtitle filters serialize with their supported modes", async (t) => {
  const { engine, calls } = setup(t);
  const filter = {
    min_text_height_ratio: 0.02,
    max_text_height_ratio: 0.15,
    center_offset_ratio: 0.12,
  };
  for (const mode of ["Subtitle", "Text"]) {
    for (const rangeMode of ["selected", "skip"]) {
      const task = engine.addURL("https://example.com/video.mp4");
      engine.metadata(task.id, { duration: 20, width: 1280, height: 720 });
      engine.update(task.id, {
        mode,
        timeFilter: {
          mode: rangeMode,
          segments: [
            { start: 10, end: 12 },
            { start: 1.25, end: 5 },
          ],
        },
        subtitleFilter: filter,
      });
      engine.enqueue([task.id]);
      await engine.pump();
      const request = calls.submits.at(-1);
      assert.deepEqual(request.time_segment_filter, {
        mode: rangeMode,
        segments: [
          { start_time: 1.25, end_time: 5 },
          { start_time: 10, end_time: 12 },
        ],
      });
      assert.deepEqual(
        request.subtitle_filter,
        mode === "Subtitle" ? filter : undefined,
      );
      await engine.pump();
    }
  }
});

test("invalid region counts, time ranges and subtitle filters are rejected", (t) => {
  const { engine } = setup(t);
  const rect = {
    top_left_x: 0,
    top_left_y: 0,
    bottom_right_x: 1,
    bottom_right_y: 1,
  };
  assert.equal(options({ rects: Array(20).fill(rect) }).rects.length, 20);
  assert.throws(() => options({ rects: Array(21).fill(rect) }), /20/);
  assert.throws(() => options({ rects: [null] }), /框选/);
  assert.throws(() => options({ mode: "other" }), /模式/);
  assert.throws(
    () =>
      options({
        timeFilter: { mode: "selected", segments: [{ start: 2, end: 1 }] },
      }),
    /时间段/,
  );
  assert.throws(
    () => options({ timeFilter: { mode: "other", segments: [] } }),
    /时间段/,
  );
  assert.throws(
    () =>
      options({
        subtitleFilter: {
          min_text_height_ratio: 0.2,
          max_text_height_ratio: 0.1,
          center_offset_ratio: 0.08,
        },
      }),
    /最小高度/,
  );
  const task = engine.addURL("https://example.com/video.mp4");
  engine.metadata(task.id, { duration: 20, width: 1280, height: 720 });
  engine.update(task.id, { timeFilter: { mode: "selected", segments: [] } });
  assert.throws(() => engine.enqueue([task.id]), /至少/);
  engine.update(task.id, {
    timeFilter: { mode: "skip", segments: [{ start: 10, end: 21 }] },
  });
  assert.throws(() => engine.enqueue([task.id]), /超出/);
  engine.update(task.id, {
    mode: "Subtitle",
    selection: "region",
    rects: [{ ...rect, bottom_right_y: 0.4 }],
  });
  assert.throws(() => engine.enqueue([task.id]), /下半部分/);
  assert.equal(task.state, "draft");
});

test("legacy options migrate with a verified backup while saved requests stay identical", async (t) => {
  const { engine, store, client, calls } = setup(t);
  const task = engine.addURL("https://example.com/legacy.mp4");
  const rect = {
    top_left_x: 0.1,
    top_left_y: 0.1,
    bottom_right_x: 0.5,
    bottom_right_y: 0.3,
  };
  task.options = {
    selection: "region",
    modelVersion: "v5.6",
    encodeMode: "Quality",
    rect,
  };
  task.state = "submission_unknown";
  task.request = {
    client_token: "original-token",
    mode: "Text",
    erase_ratio_location: [rect],
  };
  task.submittedAt = Date.now();
  task.identity = "same-test-key";
  engine.commit();
  const original = fs.readFileSync(store.file);
  const recovered = new Engine({
    store: new Store(path.dirname(store.file)),
    client,
    hasKey: () => true,
    identity: () => "same-test-key",
  });
  recovered.schedule = () => {};
  t.after(() => recovered.stop());
  const migrated = recovered.tasks[0];
  assert.equal(migrated.options.mode, "Text");
  assert.deepEqual(migrated.options.rects, [rect]);
  assert.deepEqual(migrated.request, task.request);
  const backups = fs.readdirSync(
    path.join(path.dirname(store.file), "backups"),
  );
  assert.equal(backups.length, 1);
  assert.ok(
    fs
      .readFileSync(path.join(path.dirname(store.file), "backups", backups[0]))
      .equals(original),
  );
  recovered.retry(task.id);
  await recovered.pump();
  assert.deepEqual(calls.submits[0], task.request);
});

test("cloud timestamps persist for successful and failed tasks without replacing local timing", async (t) => {
  const { engine, store, client } = setup(t, {
    query: async () => ({
      status: "completed",
      created_at: 100,
      finished_at: 142,
      result: { video_url: "https://example.com/result.mp4" },
    }),
  });
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  const localStart = task.startedAt;
  await engine.pump();
  const saved = new Store(path.dirname(store.file)).data.tasks[0];
  assert.equal(saved.cloudFinishedAt - saved.cloudCreatedAt, 42000);
  assert.equal(saved.startedAt, localStart);
  client.query = async () => ({
    status: "failed",
    created_at: 200,
    finished_at: 215,
  });
  const failed = engine.addURL("https://example.com/failed.mp4");
  engine.enqueue([failed.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(failed.cloudFinishedAt - failed.cloudCreatedAt, 15000);
});

test("local source uploads before task submission and rejects modified files", async (t) => {
  const { engine, root, calls } = setup(t);
  const file = path.join(root, "中文 视频.mp4");
  fs.writeFileSync(file, "fixture");
  const [task] = engine.addFiles([file]);
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.submits[0].video_url, "mediakit://fixture");
  const [changed] = engine.addFiles([file]);
  fs.appendFileSync(file, "changed");
  engine.enqueue([changed.id]);
  // The first cloud task is handled before the second queued task.
  await engine.pump();
  await engine.pump();
  assert.equal(changed.state, "error");
  assert.match(changed.error, /发生变化/);
  assert.equal(calls.submits.length, 1);
});

test("network uncertainty preserves exact submission body and token", async (t) => {
  let first = true;
  const attempts = [];
  const { engine } = setup(t, {
    submit: async (body) => {
      attempts.push(structuredClone(body));
      if (first) {
        first = false;
        throw new Error("network timeout");
      }
      return { task_id: "cloud-recovered" };
    },
  });
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  assert.equal(task.state, "submission_unknown");
  engine.retry(task.id);
  await engine.pump();
  assert.equal(task.taskId, "cloud-recovered");
  assert.deepEqual(attempts[1], attempts[0]);
});

test("uncertain submissions outside recovery window or with another key stay blocked", async (t) => {
  const { engine } = setup(t, {
    submit: async () => {
      throw new Error("timeout");
    },
  });
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  engine.identity = () => "other-test-key";
  assert.throws(() => engine.retry(task.id), /同一个 API Key/);
  engine.identity = () => "same-test-key";
  task.submittedAt = Date.now() - 24 * 3600000;
  assert.throws(() => engine.retry(task.id), /安全恢复时间/);
});

test("query interruption retries the original task without resubmitting", async (t) => {
  let failed = false;
  const { engine, calls } = setup(t, {
    query: async () => {
      if (!failed) {
        failed = true;
        throw new Error("query offline");
      }
      return { status: "running" };
    },
  });
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(task.state, "query_error");
  engine.retry(task.id);
  await engine.pump();
  assert.equal(task.state, "processing");
  assert.equal(calls.submits.length, 1);
  assert.equal(task.taskId, "cloud-1");
});

test("failed download resumes the same result without another paid submission", async (t) => {
  let fail = true;
  const { engine, calls, client } = setup(t);
  client.download = async (_url, file) => {
    if (fail) {
      fail = false;
      fs.writeFileSync(file, "partial");
      throw new Error("offline");
    }
    fs.writeFileSync(file, "complete");
  };
  const task = engine.addURL("https://example.com/video.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(task.state, "download_error");
  assert.equal(fs.existsSync(`${task.outputPath}.part`), false);
  engine.retry(task.id);
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.equal(calls.submits.length, 1);
});

test("restart recovers cloud tasks, downloaded results and uncertain requests", (t) => {
  const { engine, store, client } = setup(t);
  const a = engine.addURL("https://example.com/a.mp4");
  const b = engine.addURL("https://example.com/b.mp4");
  const c = engine.addURL("https://example.com/c.mp4");
  const d = engine.addURL("https://example.com/d.mp4");
  Object.assign(a, { taskId: "existing-a", state: "processing" });
  Object.assign(b, {
    taskId: "existing-b",
    resultURL: "https://example.com/result.mp4",
    state: "downloading",
  });
  Object.assign(c, {
    state: "submitting",
    request: { client_token: "original" },
  });
  Object.assign(d, { state: "queued" });
  engine.commit();
  const recovered = new Engine({
    store: new Store(path.dirname(store.file)),
    client,
    hasKey: () => true,
  });
  t.after(() => recovered.stop());
  assert.deepEqual(
    recovered.tasks.map((item) => item.state),
    ["processing", "download_pending", "submission_unknown", "draft"],
  );
  assert.equal(recovered.tasks[0].taskId, "existing-a");
});

test("serial queue waits for cloud completion and freezes submitted options", async (t) => {
  const { engine, calls } = setup(t);
  const first = engine.addURL("https://example.com/a.mp4");
  const second = engine.addURL("https://example.com/b.mp4");
  engine.enqueue([first.id, second.id]);
  await engine.pump();
  assert.equal(second.state, "queued");
  assert.throws(
    () => engine.update(first.id, { modelVersion: "v4" }),
    /已提交/,
  );
  assert.throws(() => engine.remove(first.id), /仍在执行/);
  await engine.pump();
  await engine.pump();
  assert.equal(calls.submits.length, 2);
  assert.equal(first.state, "completed");
});

test("restart while recovery is queued retains the original request", (t) => {
  const { engine, store, client } = setup(t);
  const task = engine.addURL("https://example.com/a.mp4");
  Object.assign(task, {
    state: "queued",
    request: { client_token: "original-paid-attempt" },
    submittedAt: Date.now(),
    identity: "same-test-key",
  });
  engine.commit();
  const recovered = new Engine({
    store: new Store(path.dirname(store.file)),
    client,
    hasKey: () => true,
  });
  t.after(() => recovered.stop());
  assert.equal(recovered.tasks[0].state, "submission_unknown");
  assert.equal(
    recovered.tasks[0].request.client_token,
    "original-paid-attempt",
  );
  assert.throws(() => recovered.enqueue([task.id]), /已有处理记录/);
});

test("a conflicting output file is preserved and a new name is chosen", async (t) => {
  const { engine, root } = setup(t);
  const task = engine.addURL("https://example.com/a.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  task.outputPath = path.join(root, "already-exists.mp4");
  fs.writeFileSync(task.outputPath, "original-file");
  const originalPath = task.outputPath;
  await engine.pump();
  assert.equal(task.state, "completed");
  assert.equal(fs.readFileSync(originalPath, "utf8"), "original-file");
  assert.notEqual(task.outputPath, originalPath);
  assert.equal(fs.readFileSync(task.outputPath, "utf8"), "simulated-video");
});

test("invalid inputs are rejected before creating or queueing tasks", (t) => {
  const { engine } = setup(t);
  assert.throws(() => engine.addFiles([]), /没有读取到视频文件/);
  assert.throws(() => engine.addURL("file:///C:/private.mp4"));
  assert.throws(() => engine.addURL("https://name:password@example.com/a.mp4"));
  assert.throws(() =>
    options({
      rect: {
        top_left_x: 0.5,
        top_left_y: 0.1,
        bottom_right_x: 0.2,
        bottom_right_y: 0.3,
      },
    }),
  );
  const task = engine.addURL("https://example.com/a.mp4");
  engine.update(task.id, { selection: "region" });
  assert.throws(() => engine.enqueue([task.id]), /框选/);
  engine.update(task.id, { selection: "auto" });
  engine.hasKey = () => false;
  assert.throws(() => engine.enqueue([task.id]), /API Key/);
});

test("cloud failure and expired result never cause paid resubmission", async (t) => {
  const { engine, calls, client } = setup(t, {
    query: async () => ({
      status: "failed",
      error: { message: "unsupported video" },
    }),
  });
  const task = engine.addURL("https://example.com/a.mp4");
  engine.enqueue([task.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(task.state, "cloud_failed");
  assert.throws(() => engine.retry(task.id));
  client.query = async () => ({
    status: "completed",
    expires_at: 1,
    result: { video_url: "https://example.com/old.mp4" },
  });
  const next = engine.addURL("https://example.com/b.mp4");
  engine.enqueue([next.id]);
  await engine.pump();
  await engine.pump();
  assert.equal(next.state, "download_error");
  assert.match(next.error, /过期/);
  assert.equal(calls.submits.length, 2);
});

test("transfer streams raw upload bytes, follows downloads and rejects HTTP errors", async (t) => {
  const { root } = setup(t);
  let received = Buffer.alloc(0);
  let receivedType;
  const server = http.createServer((request, response) => {
    if (request.method === "PUT") {
      receivedType = request.headers["content-type"];
      request.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      request.on("end", () => {
        response.writeHead(200);
        response.end();
      });
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/video" });
      response.end();
    } else if (request.url === "/video") {
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.end("video-bytes");
    } else {
      response.writeHead(403);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = path.join(root, "input.mp4");
  fs.writeFileSync(source, "raw-video");
  await transfer(`${base}/upload`, {
    method: "PUT",
    file: source,
    headers: { "Content-Type": "video/mp4", "Content-Length": 9 },
  });
  assert.equal(received.toString(), "raw-video");
  assert.equal(receivedType, "video/mp4");
  const target = path.join(root, "download.mp4");
  await transfer(`${base}/redirect`, { destination: target });
  assert.equal(fs.readFileSync(target, "utf8"), "video-bytes");
  await assert.rejects(
    transfer(`${base}/forbidden`, { destination: `${target}.other` }),
    /403/,
  );
});

test("error messages remove credentials and signed URLs", () => {
  const message = safeMessage(
    new Error(
      "secret-token Bearer abc https://example.com/file?Signature=private",
    ),
    "secret-token",
  );
  assert.equal(message.includes("secret-token"), false);
  assert.equal(message.includes("abc"), false);
  assert.equal(message.includes("Signature"), false);
});

test("client sends official bearer JSON requests and recognizes explicit rejection", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(
      JSON.stringify({ success: true, task_id: "accepted" }),
      { status: 200 },
    );
  };
  const client = new Client(() => "placeholder-test-key");
  const body = {
    video_url: "https://example.com/a.mp4",
    client_token: "one-request",
  };
  assert.equal((await client.submit(body)).task_id, "accepted");
  assert.equal(
    request.url,
    "https://mediakit.cn-beijing.volces.com/api/v1/tools/erase-video-subtitle-pro",
  );
  assert.equal(
    request.init.headers.Authorization,
    "Bearer placeholder-test-key",
  );
  assert.deepEqual(JSON.parse(request.init.body), body);
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: { message: "Invalid parameter" },
      }),
      { status: 200 },
    );
  await assert.rejects(client.submit(body), (error) => error.definite === true);
  global.fetch = async () => {
    throw new Error("network timeout");
  };
  await assert.rejects(
    client.submit(body),
    (error) => error.definite === false,
  );
});
