# Browser Stream Bridge

一个 **将视频网站中 `<video>` 元素的数据实时转发为 RTSP 流** 的 Node.js 服务，基于 **Playwright + MediaRecorder + FFmpeg + go2rtc**。

适合场景：

* 🎬 各类视频网站（HTML5 `<video>` 播放器）
* 📡 仅提供浏览器播放、**无法直接拉流** 的站点
* 🔁 将网页视频桥接到 RTSP / NVR / 传统流媒体系统
* 🧪 WebRTC / MSE / blob URL 视频转发

---

## ✨ 特性

* 🎯 **只处理 `<video>` 元素**：不做桌面录制、不截图，直接转发播放器视频流

* 🚀 **HTTP API 即开即用**：传入网页 URL，立即返回 RTSP 地址

* ♻️ **流复用**：同一 URL 自动复用已有流

* 🧹 **无人观看自动回收**（基于 go2rtc consumers）

* 🎥 **H.264 直通**：Playwright → MediaRecorder → FFmpeg `-c:v copy`

* 🔇 **可选音频**：Opus → AAC

* 🧠 **页面资源拦截**：支持 block list，减少广告 / 追踪

* 🕶 **Headless Chrome**，服务端运行

---

## 🧩 架构

```
Browser(Page)
   │
   │ video.captureStream()
   ▼
MediaRecorder (webm: h264 + opus)
   │
   │ Uint8Array chunks
   ▼
Node.js (__pushMediaChunk)
   │
   │ stdin
   ▼
FFmpeg (copy video, transcode audio)
   │
   ▼
RTSP (localhost)
   │
   ▼
go2rtc → clients (VLC / NVR / FFmpeg)
```

---

## 📦 依赖

* Node.js >= 18
* Playwright (Chromium)
* FFmpeg (需支持 H.264 / AAC)
* go2rtc

---

## 📁 目录结构

```
.
├─ src/
│  └─ index.ts             # 主服务
├─ assets/
│  ├─ page_preload.js      # 注入到页面的媒体采集逻辑
│  └─ page_block_list.txt  # 页面资源拦截规则
└─ README.md
```

---

## 🔧 环境变量配置

Browser Stream Bridge 支持通过环境变量进行运行时配置，便于在不同环境（本地 / Docker / 服务器）部署。

| 变量名            | 默认值      | 说明                                            |
| ----------------- | ----------- | ----------------------------------------------- |
| `SERVER_IP`       | `127.0.0.1` | 对外返回的 RTSP 地址使用的 IP（播放器访问地址） |
| `SERVER_PORT`     | `3001`      | HTTP 控制接口端口（`/api/stream`）              |
| `GO2RTC_IP`       | `127.0.0.1` | go2rtc 服务所在 IP                              |
| `GO2RTC_API_PORT` | `1984`      | go2rtc HTTP API 端口                            |
| `RTSP_PORT`       | `8554`      | RTSP 输出端口（go2rtc 监听）                    |
| `VIDEO_BITRATE`   | `6000000`   | MediaRecorder 视频码率（bit/s），直接影响清晰度 |

---

## 🚀 启动

### 1️⃣ 安装依赖

```bash
npm install
npx playwright install chromium
```

确保本机已有：

```bash
ffmpeg -version
go2rtc -version
```

---

### 2️⃣ 启动 go2rtc

```bash
go2rtc
```

默认：

* API: `http://127.0.0.1:1984`
* RTSP: `rtsp://127.0.0.1:8554`

---

### 3️⃣ 启动服务

```bash
npm run build
node dist/index.mjs
```

或使用环境变量：

```bash
SERVER_IP=192.168.1.10 SERVER_PORT=3001 node dist/index.mjs
```

---

## 🔌 HTTP API

### 创建 / 复用流

```
GET /api/stream?url=<page_url>
```

示例：

```
http://127.0.0.1:3001/api/stream?url=https://example.com/live
```

返回：

```
rtsp://127.0.0.1:8554/stream_12345678
```

---

## 📺 播放

### VLC

```
vlc rtsp://127.0.0.1:8554/stream_xxx
```

### FFmpeg

```bash
ffmpeg -i rtsp://127.0.0.1:8554/stream_xxx -c copy out.mp4
```

---

## 🧠 页面预加载逻辑（核心）

`assets/page_preload.js` 核心思路：

* 找到页面 `<video>`
* 使用 `video.captureStream()`
* `MediaRecorder` 录制为 `video/webm; codecs=h264,opus`
* 通过 `window.__pushMediaChunk()` 把数据推回 Node.js

关键代码：

```js
var stream = video.captureStream();

var recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=h264,opus',
  videoBitsPerSecond: 4000000,
  audioBitsPerSecond: 128000
});

recorder.ondataavailable = function (e) {
  if (!e.data || e.data.size === 0) return;
  window.__media_capture_ready = true;
  e.data.arrayBuffer().then(buf => {
    window.__pushMediaChunk(new Uint8Array(buf));
  });
};

recorder.start(1000);
```

---

## 🧹 自动回收策略

* 定时查询 go2rtc `/api/streams`
* 如果 `consumers.length === 0`
* 自动关闭：

  * FFmpeg
  * Playwright Page

避免僵尸浏览器 / 流泄漏

---

## ⚠️ 注意事项

* 页面必须使用 **H.264 可播放**（Chrome 支持）
* DRM（Widevine）页面 **无法捕获**
* 某些站点需要用户交互（可扩展自动点击）
* 高分辨率 / 高码率会增加 CPU 占用

---

## ❌ 局限性 / 缺点（Limitations)

在设计上，Browser Stream Bridge 选择了 **通用性优先**，这也带来了一些不可避免的代价。

### 1️⃣ 启动速度慢于传统直播源

- 需要启动 Chromium 并完整加载网页
- 等待播放器初始化、`<video>` 元数据就绪
- MediaRecorder 产生首个分片后才能推流

通常首帧可用时间为 **3–10 秒**，明显慢于原生 RTSP / HLS。

---

### 2️⃣ 端到端延迟较高

链路包含多级缓冲：

- `video.captureStream()`
- MediaRecorder 分段编码（timeslice）
- FFmpeg → RTSP → go2rtc

即使调优，整体延迟也通常在 **秒级**，不适合超低延迟场景。

---

### 3️⃣ 画质与码率受视频网站播放器限制

- 无法获取源站的原始编码流
- 分辨率、帧率、码率由网页播放器决定
- Headless / 后台标签页可能被自动降清晰度

---

### 4️⃣ 自适应码率（ABR）不可控

视频网站常见行为包括：

- 网络波动自动降码率
- 切换清晰度导致短暂黑屏
- 广告或切源引发流参数变化

下游 RTSP 客户端可能不适应动态变化的流参数。

---

### 5️⃣ 资源消耗高

每一路流都需要：

- 一个浏览器 Page
- JS 执行 + 解码 + 编码

相比直接拉 RTSP / HLS，CPU 与内存占用显著更高，不适合大规模并发。

---

### 6️⃣ 横向扩展能力有限

- Playwright 并非为高并发流媒体设计
- 浏览器实例数量直接限制可用流数量

该方案更适合 **少量但不可替代** 的视频源。

---

### 7️⃣ 稳定性依赖目标网站

- DOM / 播放器结构变化
- 反自动化策略升级
- 登录态、IP、区域限制

这些因素都可能在代码未变的情况下导致流不可用。

---

### 8️⃣ DRM 内容无法支持

- 使用 Widevine / DRM 的视频网站
- `captureStream()` 将返回空轨道或黑屏

这是浏览器安全模型的硬限制，而非实现问题。

---

### 9️⃣ 部署与调试复杂度较高

依赖组件包括：

- Node.js
- Playwright + Chromium
- FFmpeg
- go2rtc

链路较长，问题定位成本高于传统流媒体方案。

---

## 📜 License

MIT
