import { getBlob as getStoredBlob, putBlob as putStoredBlob } from './storage'

const ONLINE_AUDIO_CACHE_NAME = 'karuta-online-audio-v1'
const ONLINE_AUDIO_BLOB_PREFIX = 'online-audio:'

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

  return fullBlob(blob)
}

function fullBlob(blob: Blob) {
  if (!blob.size) throw new Error('音频文件为空')
  return blob
}

function onlineAudioBlobKey(source: string) {
  return `${ONLINE_AUDIO_BLOB_PREFIX}${source}`
}

async function readIndexedDbAudio(source: string) {
  try {
    const blob = await getStoredBlob(onlineAudioBlobKey(source))
    return blob ? fullBlob(blob) : null
  } catch {
    return null
  }
}

async function writeIndexedDbAudio(source: string, blob: Blob) {
  try {
    await putStoredBlob(onlineAudioBlobKey(source), blob, blob.type)
    return true
  } catch {
    return false
  }
}

async function fetchAudioBlob(source: string): Promise<Blob> {
  const cache = await openAudioCache()
  if (cache) {
    try {
      const cached = await cache.match(source)
      if (cached) return fullResponse(cached, await cached.blob())
    } catch {
      await cache.delete(source).catch(() => false)
    }
  }

  const indexedDbBlob = await readIndexedDbAudio(source)
  if (indexedDbBlob) return indexedDbBlob

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
  let persisted = false
  if (cache) {
    try {
      await cache.put(source, responseForCache)
      persisted = true
    } catch {
      persisted = false
    }
  }
  if (!persisted) persisted = await writeIndexedDbAudio(source, blob)
  if (!persisted) throw new Error('浏览器无法保存完整音频，无法安全开始对局')
  return blob
}

/**
 * Download one online track completely and keep the full response in local
 * Cache Storage or IndexedDB. IndexedDB is required on plain HTTP pages,
 * where Cache Storage is unavailable because the origin is not secure. The
 * in-flight map prevents duplicate downloads in the same page.
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
