import { useEffect, useState } from 'react'
import { getBlobUrl } from '../lib/storage'

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

async function acquireObjectUrl(blobKey: string): Promise<string | null> {
  const cached = objectUrlCache.get(blobKey)
  if (cached) {
    cached.refs += 1
    touchObjectUrl(blobKey, cached)
    return cached.url
  }

  let pending = pendingObjectUrls.get(blobKey)
  if (!pending) {
    pending = getBlobUrl(blobKey).finally(() => {
      pendingObjectUrls.delete(blobKey)
    })
    pendingObjectUrls.set(blobKey, pending)
  }

  const url = await pending
  if (!url) return null

  const raced = objectUrlCache.get(blobKey)
  if (raced) {
    raced.refs += 1
    touchObjectUrl(blobKey, raced)
    if (raced.url !== url) URL.revokeObjectURL(url)
    return raced.url
  }

  objectUrlCache.set(blobKey, { url, refs: 1 })
  trimIdleObjectUrls()
  return url
}

function releaseObjectUrl(blobKey: string, url: string) {
  const cached = objectUrlCache.get(blobKey)
  if (!cached || cached.url !== url) return
  cached.refs -= 1
  if (cached.refs > 0) return
  touchObjectUrl(blobKey, cached)
  trimIdleObjectUrls()
}

export function useObjectUrl(blobKey: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let acquiredUrl: string | null = null

    if (!blobKey) {
      setUrl(null)
      return
    }

    setUrl(null)
    void acquireObjectUrl(blobKey).then((next) => {
      if (!active) {
        if (next) releaseObjectUrl(blobKey, next)
        return
      }
      acquiredUrl = next
      setUrl(next)
    })

    return () => {
      active = false
      if (acquiredUrl) releaseObjectUrl(blobKey, acquiredUrl)
    }
  }, [blobKey])

  return url
}
