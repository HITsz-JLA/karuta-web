import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react'
import { useObjectUrl } from '../hooks/useObjectUrl'
import type { CardEntry } from '../types/models'
import type { OnlineCardView } from '../lib/onlineProtocol'

interface Props {
  meta: OnlineCardView
  card?: CardEntry | null
  available: boolean
  picked?: boolean
  result?: boolean
  pinned?: boolean
  showNumber?: boolean
  slotIndex?: number
  stateLabel?: string
  draggable?: boolean
  dragging?: boolean
  dropTarget?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: () => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

const CARD_IMAGE_CACHE_NAME = 'karuta-card-images-v1'
const CARD_IMAGE_MEMORY_LIMIT = 96
const cachedImageUrls = new Map<string, string>()
const pendingImageLoads = new Map<string, Promise<string>>()

function rememberImageUrl(imageUrl: string, objectUrl: string) {
  const previous = cachedImageUrls.get(imageUrl)
  if (previous && previous !== objectUrl) URL.revokeObjectURL(previous)
  cachedImageUrls.delete(imageUrl)
  cachedImageUrls.set(imageUrl, objectUrl)
  while (cachedImageUrls.size > CARD_IMAGE_MEMORY_LIMIT) {
    const oldest = cachedImageUrls.entries().next().value as [string, string] | undefined
    if (!oldest) break
    cachedImageUrls.delete(oldest[0])
    URL.revokeObjectURL(oldest[1])
  }
}

async function loadCachedImage(imageUrl: string) {
  const memoryUrl = cachedImageUrls.get(imageUrl)
  if (memoryUrl) {
    cachedImageUrls.delete(imageUrl)
    cachedImageUrls.set(imageUrl, memoryUrl)
    return memoryUrl
  }
  const pending = pendingImageLoads.get(imageUrl)
  if (pending) return pending

  const load = (async () => {
    try {
      if (typeof caches === 'undefined') return imageUrl
      const cache = await caches.open(CARD_IMAGE_CACHE_NAME)
      let response = await cache.match(imageUrl)
      if (!response) {
        response = await fetch(imageUrl, { cache: 'force-cache' })
        if (!response.ok) return imageUrl
        await cache.put(imageUrl, response.clone())
      }
      const objectUrl = URL.createObjectURL(await response.blob())
      rememberImageUrl(imageUrl, objectUrl)
      return objectUrl
    } catch {
      // The normal URL remains the safe fallback when Cache Storage is unavailable.
      return imageUrl
    }
  })()
  pendingImageLoads.set(imageUrl, load)
  void load.finally(() => {
    if (pendingImageLoads.get(imageUrl) === load) pendingImageLoads.delete(imageUrl)
  })
  return load
}

function useCachedImageUrl(imageUrl: string | undefined): [string | undefined, (element: HTMLButtonElement | null) => void] {
  const imageTargetRef = useRef<HTMLButtonElement | null>(null)
  const setImageTarget = useCallback((element: HTMLButtonElement | null) => {
    imageTargetRef.current = element
  }, [])
  const [shouldLoad, setShouldLoad] = useState(() => {
    if (!imageUrl) return false
    return typeof IntersectionObserver === 'undefined' || cachedImageUrls.has(imageUrl)
  })
  const [cachedImage, setCachedImage] = useState<{ source: string; url: string } | null>(() => {
    if (!imageUrl) return null
    const memoryUrl = cachedImageUrls.get(imageUrl)
    return memoryUrl ? { source: imageUrl, url: memoryUrl } : null
  })

  useEffect(() => {
    if (!imageUrl) {
      setShouldLoad(false)
      return
    }
    if (cachedImageUrls.has(imageUrl) || typeof IntersectionObserver === 'undefined' || !imageTargetRef.current) {
      setShouldLoad(true)
      return
    }

    setShouldLoad(false)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setShouldLoad(true)
        observer.disconnect()
      },
      { rootMargin: '240px' },
    )
    observer.observe(imageTargetRef.current)
    return () => observer.disconnect()
  }, [imageUrl])

  useEffect(() => {
    let active = true
    if (!imageUrl || !shouldLoad) {
      if (!imageUrl) setCachedImage(null)
      return () => {
        active = false
      }
    }
    const memoryUrl = cachedImageUrls.get(imageUrl)
    if (memoryUrl) {
      setCachedImage({ source: imageUrl, url: memoryUrl })
      return () => {
        active = false
      }
    }
    setCachedImage(null)
    void loadCachedImage(imageUrl).then((nextUrl) => {
      if (active) setCachedImage({ source: imageUrl, url: nextUrl })
    })
    return () => {
      active = false
    }
  }, [imageUrl, shouldLoad])

  if (!cachedImage || cachedImage.source !== imageUrl) return [undefined, setImageTarget]
  return [cachedImage.url, setImageTarget]
}

/** A board tile deliberately keeps the local karuta card image as its main cue. */
export const OnlineCardTile = memo(function OnlineCardTile({
  meta,
  card,
  available,
  picked,
  result,
  pinned = false,
  showNumber = true,
  slotIndex,
  stateLabel,
  draggable = false,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClick,
}: Props) {
  const localImageUrl = useObjectUrl(card?.imageBlobKey)
  const [cachedRemoteImageUrl, imageTargetRef] = useCachedImageUrl(meta.imageUrl)
  const imageUrl = cachedRemoteImageUrl || localImageUrl
  const className = [
    'online-card-tile',
    available ? 'available' : draggable ? 'arrangeable' : 'claimed',
    picked ? 'picked' : '',
    result ? 'result' : '',
    pinned ? 'pinned' : '',
    draggable ? 'draggable' : '',
    dragging ? 'dragging' : '',
    dropTarget ? 'drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={imageTargetRef}
      className={className}
      type="button"
      draggable={draggable}
      disabled={!draggable && (!available || !onClick)}
      onClick={available || draggable ? onClick : undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-online-card-key={meta.key}
      data-online-slot-index={slotIndex}
      aria-grabbed={dragging}
      aria-label={`${showNumber ? `#${meta.number} ` : ''}${meta.workName}`}
    >
      {showNumber ? <span className="online-card-number">#{meta.number}</span> : null}
      <div className="online-card-image">
        {imageUrl ? (
          <img src={imageUrl} alt={meta.workName} loading="lazy" decoding="async" />
        ) : (
          <span className="online-card-missing">{card ? '暂无卡面' : '服务器卡面加载中'}</span>
        )}
      </div>
      <span className="online-card-title">{meta.workName}</span>
      {pinned ? <span className="online-card-state">已固定</span> : stateLabel ? <span className="online-card-state">{stateLabel}</span> : !available ? <span className="online-card-state">已收取</span> : null}
    </button>
  )
})
