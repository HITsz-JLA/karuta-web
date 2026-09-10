import { useEffect, useState } from 'react'
import { getBlob, getBlobUrl } from '../lib/storage'
import { createThumbnailObjectUrl, enqueueImageLoad } from '../lib/imagePreview'

interface CachedObjectUrl {
  url: string
  refs: number
}

const IDLE_OBJECT_URL_LIMIT = 96
const objectUrlCache = new Map<string, CachedObjectUrl>()
const pendingObjectUrls = new Map<string, Promise<string | null>>()

function touchObjectUrl(blobKey: string, cached: CachedObjectUrl) {
  objectUrlCache.delete(blobKey)
  objectUrlCache.set(blobKey, cached)
}

function trimIdleObjectUrls() {
  if (objectUrlCache.size <= IDLE_OBJECT_URL_LIMIT) return
  for (const [blobKey, cached] of objectUrlCache) {
    if (objectUrlCache.size <= IDLE_OBJECT_URL_LIMIT) break
    if (cached.refs > 0) continue
    objectUrlCache.delete(blobKey)
    URL.revokeObjectURL(cached.url)
  }
}

async function acquireObjectUrl(blobKey: string, thumbnail: boolean): Promise<string | null> {
  const cacheKey = thumbnail ? `thumbnail:${blobKey}` : blobKey
  const cached = objectUrlCache.get(cacheKey)
  if (cached) {
    cached.refs += 1
    touchObjectUrl(cacheKey, cached)
    return cached.url
  }

  let pending = pendingObjectUrls.get(cacheKey)
  if (!pending) {
    pending = enqueueImageLoad(async () => {
      if (!thumbnail) return getBlobUrl(blobKey)
      const blob = await getBlob(blobKey)
      return blob ? createThumbnailObjectUrl(blob) : null
    }).finally(() => {
      pendingObjectUrls.delete(cacheKey)
    })
    pendingObjectUrls.set(cacheKey, pending)
  }

  const url = await pending
  if (!url) return null

  const raced = objectUrlCache.get(cacheKey)
  if (raced) {
    raced.refs += 1
    touchObjectUrl(cacheKey, raced)
    if (raced.url !== url) URL.revokeObjectURL(url)
    return raced.url
  }

  objectUrlCache.set(cacheKey, { url, refs: 1 })
  trimIdleObjectUrls()
  return url
}

function releaseObjectUrl(cacheKey: string, url: string) {
  const cached = objectUrlCache.get(cacheKey)
  if (!cached || cached.url !== url) return
  cached.refs -= 1
  if (cached.refs > 0) return
  touchObjectUrl(cacheKey, cached)
  trimIdleObjectUrls()
}

export function useObjectUrl(blobKey: string | null | undefined, options: { thumbnail?: boolean } = {}) {
  const [url, setUrl] = useState<string | null>(null)
  const thumbnail = options.thumbnail === true

  useEffect(() => {
    let active = true
    let acquiredUrl: string | null = null
    const cacheKey = blobKey ? (thumbnail ? `thumbnail:${blobKey}` : blobKey) : null

    if (!blobKey) {
      setUrl(null)
      return
    }

    setUrl(null)
    void acquireObjectUrl(blobKey, thumbnail).then((next) => {
      if (!active) {
        if (next && cacheKey) releaseObjectUrl(cacheKey, next)
        return
      }
      acquiredUrl = next
      setUrl(next)
    })

    return () => {
      active = false
      if (acquiredUrl && cacheKey) releaseObjectUrl(cacheKey, acquiredUrl)
    }
  }, [blobKey, thumbnail])

  return url
}
