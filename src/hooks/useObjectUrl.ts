import { useEffect, useState } from 'react'
import { getBlobUrl } from '../lib/storage'

interface CachedObjectUrl {
  url: string
  refs: number
}

const objectUrlCache = new Map<string, CachedObjectUrl>()
const pendingObjectUrls = new Map<string, Promise<string | null>>()

async function acquireObjectUrl(blobKey: string): Promise<string | null> {
  const cached = objectUrlCache.get(blobKey)
  if (cached) {
    cached.refs += 1
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
    if (raced.url !== url) URL.revokeObjectURL(url)
    return raced.url
  }

  objectUrlCache.set(blobKey, { url, refs: 1 })
  return url
}

function releaseObjectUrl(blobKey: string, url: string) {
  const cached = objectUrlCache.get(blobKey)
  if (!cached || cached.url !== url) return
  cached.refs -= 1
  if (cached.refs > 0) return
  objectUrlCache.delete(blobKey)
  URL.revokeObjectURL(url)
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
