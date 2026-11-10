# 字幕擦除

独立编写的精简 Electron 桌面工具，界面参照工作区无限画布的圆角面板和明暗主题。通过火山引擎 AI MediaKit 精细化字幕擦除接口处理视频。

## 使用

1. 安装 `dist/SubtitleEraser-Setup-1.0.0-x64.exe`。
2. 打开设置，填写自己的 AI MediaKit API Key。
3. 拖入视频、点击添加视频，或者添加 HTTP/HTTPS 视频直链。
4. 使用自动识别处理底部字幕，或者切换手动框选，在原视频预览上拖动选区。
5. 选择算法和保存位置，点击开始擦除并确认费用。
6. 等待上传、云端处理和自动下载，完成后切换“擦除结果”预览，或打开成片文件夹。

多个视频可依次处理。手动框选参数分别保存在各个任务中。移除任务记录后，已保存的成片仍保存在输出文件夹。

## 参数与费用

- 默认 V5，适合中英文字幕。V5.6 支持更多语种，处理时间更长。
- 自动识别对应 `Subtitle`，主要处理下半画面居中的白色字幕。
- 手动框选对应 `Text`，对选区内检测到的文本执行擦除。
- 输入最高 2K，输出最高 1080P，单个本地文件最大 5 GB。
- 精细化字幕擦除当前单价 1 元/分钟，按完整视频处理时长计算。软件显示估算金额，实际费用以火山账户账单为准。
- 云端算法可能在复杂背景和动画文字上留下残留，具体效果由服务决定。
- MP4/H.264 通常可以直接预览。部分容器或编码无法在内置播放器中预览，仍可使用自动识别提交。

## 数据与恢复

- 本机设置和任务记录位于 `%APPDATA%\SubtitleEraser`。
- API Key 使用 Electron safeStorage 调用 Windows 加密能力保存，界面只显示配置状态。
- 默认成片位置为当前用户的视频文件夹下的“字幕擦除”，可在界面中更改。已排队任务使用开始时确定的保存位置。
- 重新打开软件后，已取得任务 ID 的任务继续查询或下载。尚未提交的任务恢复为待开始。
- 提交结果不确定时保留原请求。23 小时内可使用同一个 Key 和请求标识恢复提交，超出时间需在火山控制台核对。
- 查询与下载重试复用原任务。默认云端成片链接自生成起有效 24 小时，软件会自动下载。
- 关闭软件后，已提交的云端任务继续执行。再次打开后继续获取结果。

## 开发与验证

使用 Node.js 24。

```powershell
npm install
npm run dev
npm test
npm run dist:win
```

`npm run smoke` 使用 `validation/fixture.mp4` 和隔离的测试数据目录，模拟上传、提交、查询和下载流程。验证包含窗口布局、视频播放、鼠标框选及密钥加密。测试入口仅在开发模式可用，安装包使用真实官方接口。

本次验证使用模拟上游，真实 API 权限、账户余额和实际字幕擦除效果需要配置自己的 Key 后验证。

## 官方文档

- [精细化字幕擦除 API](https://docs.volcengine.com/docs/intelligent-processing/erase-video-subtitle-pro?lang=zh)
- [视频上传](https://docs.volcengine.com/docs/intelligent-processing/media-input-and-upload?lang=zh)
- [计费说明](https://docs.volcengine.com/docs/intelligent-processing/video-tool-billing?lang=zh)
