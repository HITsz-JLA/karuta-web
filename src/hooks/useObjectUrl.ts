import { useEffect, useState } from 'react'
import { getBlobUrl } from '../lib/storage'

export function useObjectUrl(blobKey: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null

    if (!blobKey) {
      setUrl(null)
      return
    }

    void getBlobUrl(blobKey).then((next) => {
      if (!active) {
        if (next) URL.revokeObjectURL(next)
        return
      }
      objectUrl = next
      setUrl(next)
    })

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [blobKey])

  return url
}
