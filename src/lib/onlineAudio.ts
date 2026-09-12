const ONLINE_AUDIO_CACHE_NAME = 'karuta-online-audio-v1'

let audioCachePromise: Promise<Cache | null> | null = null
const pendingAudioLoads = new Map<string, Promise<Blob>>()

function openAudioCache() {
  if (typeof caches === 'undefined') return Promise.resolve(null)
  if (!audioCachePromise) {
    audioCachePromise = caches.open(ONLINE_AUDIO_CACHE_NAME).catch(() => {
      audioCachePromise = null
      return null
    })
  }
  return audioCachePromise
}

function fullResponse(response: Response, blob: Blob) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== blob.size) {
    throw new Error('音频响应不完整')
  }

  const contentRange = response.headers.get('content-range')
  if (contentRange) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
    if (!match || Number(match[1]) !== 0 || Number(match[2]) + 1 !== Number(match[3]) || blob.size !== Number(match[3])) {
      throw new Error('音频响应不是完整文件')
    }
  }

  if (!blob.size) throw new Error('音频文件为空')
  return blob
}

async function fetchAudioBlob(source: string): Promise<Blob> {
  const cache = await openAudioCache()
  if (!cache) throw new Error('浏览器无法使用本地音频缓存，无法安全开始对局')

  const cached = await cache.match(source)
  if (cached) {
    try {
      return fullResponse(cached, await cached.blob())
    } catch {
      await cache.delete(source).catch(() => false)
    }
  }

  // Do not use the media element's Range/streaming loader here. Waiting for
  // blob() makes the complete response local before the ready acknowledgement
  // can reach the server.
  const response = await fetch(source, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`音频加载失败（HTTP ${response.status}）`)
  const responseForCache = response.clone()
  const blob = fullResponse(response, await response.blob())
  await cache.put(source, responseForCache)
  return blob
}

/**
 * Download one online track completely and keep the full response in the
 * browser's Cache Storage. The in-flight map prevents two media consumers in
 * the same page from issuing duplicate downloads.
 */
export async function preloadOnlineAudioMany(
  sources: string[],
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
) {
  const unique = [...new Set(sources.filter(Boolean))]
  const total = unique.length
  if (!total) {
    options.onProgress?.(0, 0)
    return
  }
  let done = 0
  const queue = [...unique]
  const workerCount = Math.max(1, Math.min(options.concurrency || 4, queue.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const source = queue.shift()
        if (!source) break
        await preloadOnlineAudio(source)
        done += 1
        options.onProgress?.(done, total)
      }
    }),
  )
}

export function preloadOnlineAudio(source: string): Promise<Blob> {
  const pending = pendingAudioLoads.get(source)
  if (pending) return pending

  const load = fetchAudioBlob(source)
  pendingAudioLoads.set(source, load)
  void load.then(
    () => {
      if (pendingAudioLoads.get(source) === load) pendingAudioLoads.delete(source)
    },
    () => {
      if (pendingAudioLoads.get(source) === load) pendingAudioLoads.delete(source)
    },
  )
  return load
}
