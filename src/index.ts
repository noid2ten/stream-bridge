import { createServer } from 'http'
import { chromium, Browser, Page } from 'playwright'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs/promises'

/* ================== CONFIG ================== */

const SERVER_IP = process.env.SERVER_IP || '127.0.0.1'
const SERVER_PORT = Number(process.env.SERVER_PORT || 3001)

const GO2RTC_IP = process.env.GO2RTC_IP || '127.0.0.1'
const GO2RTC_API_PORT = 1984
const RTSP_PORT = 8554

const PAGE_BLOCK_LIST_FILE = 'assets/page_block_list.txt'
const PAGE_PRELOAD_FILE = 'assets/page_preload.js'

const VIDEO_BITRATE = Number(process.env.VIDEO_BITRATE || '6000000')

/* ================== TYPES ================== */

type StreamContext = {
  id: string
  page: Page
  ffmpeg: ChildProcess
}

/* ================== GLOBAL STATE ================== */

let browser: Browser
let pageBlockList: RegExp[] = []
let pagePreloadJs = ''

const streams = new Map<string, StreamContext>()
let cleanupTimer: NodeJS.Timeout

/* ================== HTTP SERVER ================== */

function startHttpServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      if (url.pathname !== '/api/stream') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const pageUrl = url.searchParams.get('url')
      if (!pageUrl) {
        res.writeHead(400)
        res.end('Missing url parameter')
        return
      }

      const id = `stream_${hash(pageUrl)}`

      // reuse existing stream
      if (streams.has(id)) {
        console.log(`[+] reuse stream ${id}`)
        cleanupTimer?.refresh()
        res.writeHead(200)
        res.end(`rtsp://${SERVER_IP}:${RTSP_PORT}/${id}`)
        return
      }

      console.log(`[+] create stream ${id}`)
      streams.set(id, null as any) // placeholder
      const ctx = await createStreamContext(id, pageUrl)
      cleanupTimer?.refresh()
      streams.set(id, ctx)

      res.writeHead(200)
      res.end(`rtsp://${SERVER_IP}:${RTSP_PORT}/${id}`)
    } catch (err) {
      console.error('[HTTP]', err)
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening: http://${SERVER_IP}:${SERVER_PORT}/api/stream?url=...`)
  })
}

/* ================== STREAM CONTEXT ================== */

async function createStreamContext(id: string, pageUrl: string): Promise<StreamContext> {
  await createGo2rtcStream(id)

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  })

  await page.route('**/*', route => {
    const reqUrl = route.request().url()
    for (const rule of pageBlockList) {
      if (rule.test(reqUrl)) {
        return route.fulfill({ status: 200, body: '' })
      }
    }
    route.continue()
  })

  const ffmpeg = spawnFFmpeg(id)

  page.on('close', () => {
    console.log(`[-] page closed ${id}`)
    ffmpeg.kill('SIGINT')
    streams.delete(id)
  })

  ffmpeg.on('exit', () => {
    console.log(`[-] ffmpeg exit ${id}`)
    page.close().catch(() => { })
    streams.delete(id)
  })

  await page.exposeFunction('__pushMediaChunk', (chunk: Uint8Array) => {
    if (!ffmpeg.stdin.writable) return
    try {
      ffmpeg.stdin.write(Buffer.from(chunk))
    } catch { }
  })

  await page.addInitScript((bitrate) => {
    (window as any).__VIDEO_BITRATE = bitrate
  }, VIDEO_BITRATE)
  await page.addInitScript(pagePreloadJs)
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

  await page.waitForFunction(
    () => (window as any).__media_capture_ready === true,
    { timeout: 30_000 }
  )

  await waitGo2rtcReady(id)

  return {
    id,
    page,
    ffmpeg,
  }
}

/* ================== FFMPEG ================== */

function spawnFFmpeg(id: string) {
  return spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      `rtsp://127.0.0.1:${RTSP_PORT}/${id}`,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
}

/* ================== GO2RTC ================== */

async function createGo2rtcStream(id: string) {
  await fetch(
    `http://${GO2RTC_IP}:${GO2RTC_API_PORT}/api/streams?name=${id}&src=rtsp://:${RTSP_PORT}/${id}`,
    { method: 'PUT' }
  )
}

async function waitGo2rtcReady(id: string) {
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    try {
      const json = await fetch(
        `http://${GO2RTC_IP}:${GO2RTC_API_PORT}/api/streams`
      ).then(r => r.json())

      if (json[id]?.producers?.length > 1) return
    } catch { }
    await delay(200)
  }
  throw new Error('go2rtc stream not ready')
}

/* ================== CLEANUP ================== */

function startCleanupTimer() {
  clearInterval(cleanupTimer)
  cleanupTimer = setInterval(async () => {
    try {
      const json = await fetch(`http://${GO2RTC_IP}:1984/api/streams`).then(res => res.json())
      const noConsumersStreams = Object.entries(json).filter(([_name, info]) => {
        return (!(info as any).consumers || (info as any).consumers.length === 0)
      })

      for (const [name, _info] of noConsumersStreams) {
        if (streams.has(name) && streams.get(name) !== null) {
          console.log(`[-] cleanup stream ${name}`)
          const ctx = streams.get(name)!
          ctx.ffmpeg.kill('SIGINT')
          await ctx.page.close().catch(() => { })
          streams.delete(name)
        }
      }
    } catch (err) {
      console.error('[CLEANUP] failed to fetch go2rtc streams', err)
    }
  }, 10_000)
}

/* ================== UTIL ================== */

function delay(ms: number) {
  return new Promise(res => setTimeout(res, ms))
}

function hash(input: string) {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString()
}

async function loadAssets() {
  pageBlockList = (await fs.readFile(PAGE_BLOCK_LIST_FILE, 'utf-8'))
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => new RegExp(l.replace(/\*/g, '.*')))

  pagePreloadJs = await fs.readFile(PAGE_PRELOAD_FILE, 'utf-8')
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-features=WebRTC-H264HighProfile,WebCodecs',
      '--disable-web-security',
    ],
  })
}

/* ================== MAIN ================== */

async function main() {
  await loadAssets()
  browser = await launchBrowser()
  startHttpServer()
  startCleanupTimer()
}

process.on('SIGINT', async () => {
  console.log('shutdown...')
  for (const ctx of streams.values()) {
    ctx.ffmpeg.kill('SIGINT')
    await ctx.page.close().catch(() => { })
  }
  await browser.close()
  process.exit(0)
})

main().catch(err => {
  console.error(err)
  process.exit(1)
})
