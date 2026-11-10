"use strict";
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const API = "https://mediakit.cn-beijing.volces.com";
const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
  ".wmv": "video/x-ms-wmv",
  ".webm": "video/webm",
};

function publicURL(value) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("请填写 HTTP 或 HTTPS 视频直链。");
  }
  return url.href;
}

function safeMessage(error, key = "") {
  let message = String(error?.message || error || "操作失败");
  if (key) message = message.split(key).join("[已隐藏]");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[资源地址]")
    .replace(/mediakit:\/\/[^\s"'<>]+/gi, "[上传文件]")
    .slice(0, 600);
}

function transfer(
  url,
  {
    method = "GET",
    headers = {},
    file,
    destination,
    onProgress = () => {},
    signal,
    redirects = 0,
  },
) {
  return new Promise((resolve, reject) => {
    const target = new URL(publicURL(url));
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      { method, headers, signal },
      (response) => {
        const code = response.statusCode;
        if (method === "GET" && [301, 302, 303, 307, 308].includes(code)) {
          response.resume();
          if (redirects >= 5 || !response.headers.location)
            return reject(new Error("下载地址重定向异常。"));
          let redirected;
          try {
            redirected = publicURL(
              new URL(response.headers.location, target).href,
            );
          } catch (error) {
            return reject(error);
          }
          transfer(redirected, {
            method,
            headers,
            destination,
            onProgress,
            signal,
            redirects: redirects + 1,
          }).then(resolve, reject);
          return;
        }
        if (code < 200 || code >= 300) {
          response.resume();
          return reject(
            new Error(
              `文件${method === "PUT" ? "上传" : "下载"}失败（HTTP ${code}）。`,
            ),
          );
        }
        if (!destination) {
          response.resume();
          response.once("end", resolve);
          response.once("error", reject);
          return;
        }
        const total = Number(response.headers["content-length"]) || 0;
        let received = 0;
        const progress = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            onProgress(received, total);
            callback(null, chunk);
          },
        });
        pipeline(
          response,
          progress,
          fs.createWriteStream(destination, { flags: "wx" }),
          { signal },
        )
          .then(() => {
            if (!received) throw new Error("下载结果为空，请重试下载。");
            const contentType = String(response.headers["content-type"] || "");
            if (/text\/|json|xml/i.test(contentType))
              throw new Error(
                "下载地址返回了错误页面，请检查结果链接是否过期。",
              );
          })
          .then(resolve, reject);
      },
    );
    request.setTimeout(120000, () =>
      request.destroy(new Error("文件传输超时，请检查网络后重试。")),
    );
    request.once("error", reject);
    if (file) {
      let sent = 0;
      const total = fs.statSync(file).size;
      const progress = new Transform({
        transform(chunk, _encoding, callback) {
          sent += chunk.length;
          onProgress(sent, total);
          callback(null, chunk);
        },
      });
      pipeline(fs.createReadStream(file), progress, request, { signal }).catch(
        reject,
      );
    } else request.end();
  });
}

class Client {
  constructor(getKey) {
    this.getKey = getKey;
  }
  async json(route, body, signal) {
    const key = this.getKey();
    if (!key) throw new Error("请先在设置中填写 API Key。");
    let response;
    try {
      response = await fetch(`${API}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(60000),
        ]),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) {
        const error = new Error(
          safeMessage(
            data.error?.message || `接口请求失败（HTTP ${response.status}）。`,
            key,
          ),
        );
        error.definite =
          data.success === false ||
          (response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408);
        throw error;
      }
      if (data.error?.message)
        data.error.message = safeMessage(data.error.message, key);
      return data;
    } catch (error) {
      const wrapped = new Error(safeMessage(error, key));
      wrapped.definite = error.definite === true;
      throw wrapped;
    }
  }
  async upload(file, onProgress, signal) {
    const response = await this.json(
      "/api/v1/tools-sync/request-media-upload-url",
      {},
      signal,
    );
    const result = response.result;
    if (
      !result?.file_id ||
      !result?.upload_url ||
      (result.method && result.method !== "PUT")
    ) {
      throw new Error("上传接口返回的地址或文件标识不完整。");
    }
    const headers = {};
    const supplied = result.upload_headers || [];
    if (Array.isArray(supplied)) {
      for (const item of supplied) {
        const name = item.name || item.key || item.Key;
        if (name) headers[name] = item.value ?? item.Value;
      }
    } else Object.assign(headers, supplied);
    // Only headers issued by the upload service are sent to the signed URL.
    headers["Content-Type"] ||=
      MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    headers["Content-Length"] = fs.statSync(file).size;
    await transfer(result.upload_url, {
      method: "PUT",
      headers,
      file,
      onProgress,
      signal,
    });
    return result.file_id.startsWith("mediakit://")
      ? result.file_id
      : `mediakit://${result.file_id}`;
  }
  submit(body, signal) {
    return this.json("/api/v1/tools/erase-video-subtitle-pro", body, signal);
  }
  query(id, signal) {
    return this.json(
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
  }
  download(url, file, onProgress, signal) {
    return transfer(url, { destination: file, onProgress, signal });
  }
}

module.exports = { Client, MIME, publicURL, safeMessage, transfer };
