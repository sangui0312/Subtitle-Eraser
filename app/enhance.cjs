"use strict";

const versions = new Set(["standard", "professional", "fast", "generative"]);
const common = new Set([
  "resolution",
  "bitrate_level",
  "bitrate",
  "fps",
  "media_output_destination",
  "queue_id",
  "callback_url",
  "callback_args",
]);
const standard = new Set(["scene", "enhance_style", "resolution_limit"]);
const professional = new Set([
  "color_style",
  "skin_smoothing",
  "face_sharpness",
  "glare_suppression",
  "bit_depth",
  "codec",
  "pix_fmt",
  "dynamic_range",
]);

function enhanceOptions(input = {}) {
  const version = input.version || "standard";
  if (!versions.has(version)) throw new Error("请选择有效的画质增强版本。");
  const settings = {};
  for (const [key, value] of Object.entries(input.settings || {})) {
    if (value === "" || value === null || value === undefined) continue;
    const allowed =
      common.has(key) ||
      (version !== "generative" && key === "resolution_limit") ||
      (["standard", "professional"].includes(version) && standard.has(key)) ||
      (version === "professional" && professional.has(key));
    if (!allowed) throw new Error(`当前版本不支持参数 ${key}。`);
    settings[key] = value;
  }
  const choices = {
    resolution:
      version === "generative"
        ? ["720p", "1080p", "2k", "4k"]
        : version === "fast"
          ? ["240p", "360p", "480p", "540p", "720p", "1080p", "2k", "4k"]
          : [
              "240p",
              "360p",
              "480p",
              "540p",
              "720p",
              "1080p",
              "2k",
              "4k",
              "6k",
              "8k",
            ],
    bitrate_level: ["low", "medium", "high"],
    scene: ["common", "ugc", "short_series", "aigc", "old_film"],
    enhance_style:
      version === "standard"
        ? ["balanced", "clear"]
        : ["natural", "soft", "balanced", "clear", "hd"],
    color_style: ["original", "natural", "vivid"],
    glare_suppression: ["close", "generic", "face_safe"],
    bit_depth: [8, 10, 12, 16],
    codec: ["h264", "h265", "prores", "ffv1", "exr"],
    pix_fmt: ["gbrp16le"],
    dynamic_range: ["sdr", "hdr"],
  };
  for (const [key, allowed] of Object.entries(choices))
    if (settings[key] !== undefined && !allowed.includes(settings[key]))
      throw new Error(`${key} 参数无效。`);
  const bounds = {
    resolution_limit: [128, version === "fast" ? 2160 : 4320],
    bitrate: [10, 150000],
    fps: [15, 120],
    skin_smoothing: [0, 100],
    face_sharpness: [0, 100],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (settings[key] === undefined) continue;
    if (
      !Number.isFinite(settings[key]) ||
      settings[key] < min ||
      settings[key] > max ||
      (key !== "fps" && !Number.isInteger(settings[key]))
    )
      throw new Error(`${key} 应在 ${min} 至 ${max} 之间。`);
  }
  if (settings.resolution && settings.resolution_limit)
    throw new Error("分辨率档位和短边像素只能选择一个。");
  if (settings.bitrate && settings.bitrate_level)
    throw new Error("精确码率和码率档位只能选择一个。");
  if (
    settings.scene === "old_film" &&
    [
      "enhance_style",
      "color_style",
      "skin_smoothing",
      "face_sharpness",
      "glare_suppression",
    ].some((key) => settings[key] !== undefined)
  )
    throw new Error("老片修复场景不支持所选画面风格和人像参数。");
  const depth = settings.pix_fmt ? 16 : settings.bit_depth;
  if (
    settings.pix_fmt &&
    ((settings.codec && settings.codec !== "ffv1") ||
      (settings.bit_depth && settings.bit_depth !== 16))
  )
    throw new Error("GBR 16 位像素格式需要 FFV1 和 16 位色深。");
  if (settings.codec && !depth)
    throw new Error("选择编码格式时请同时选择色深。");
  const codecs = {
    8: ["h264", "h265"],
    10: ["h265", "prores"],
    12: ["h265"],
    16: ["ffv1", "exr"],
  };
  if (settings.codec && !codecs[depth]?.includes(settings.codec))
    throw new Error("编码格式与色深组合无效。");
  if (settings.dynamic_range === "hdr" && ![10, 12, 16].includes(depth))
    throw new Error("HDR 需要 10、12 或 16 位色深。");
  if (
    (depth === 16 || ["prores", "ffv1", "exr"].includes(settings.codec)) &&
    (settings.bitrate || settings.bitrate_level)
  )
    throw new Error("当前编码自动决定码率，请清空码率设置。");
  for (const key of [
    "media_output_destination",
    "queue_id",
    "callback_url",
    "callback_args",
  ]) {
    if (
      settings[key] !== undefined &&
      (typeof settings[key] !== "string" ||
        settings[key].length > (key === "callback_args" ? 512 : 4096))
    )
      throw new Error(`${key} 参数无效。`);
  }
  if (
    settings.media_output_destination &&
    !/^(vod|tos):\/\/.+/.test(settings.media_output_destination)
  )
    throw new Error("云端保存地址需以 vod:// 或 tos:// 开头。");
  if (settings.callback_url) {
    const url = new URL(settings.callback_url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("回调地址无效。");
  }
  return { version, settings };
}

function enhanceRequest(config, videoURL, token) {
  const route =
    config.version === "fast"
      ? "enhance-video-fast"
      : config.version === "generative"
        ? "enhance-video-generative"
        : "enhance-video";
  const body = { video_url: videoURL, client_token: token, ...config.settings };
  if (["standard", "professional"].includes(config.version))
    body.tool_version = config.version;
  return { route, body };
}
module.exports = { enhanceOptions, enhanceRequest };
