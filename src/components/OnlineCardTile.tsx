import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react'
import { observeNearViewport } from '../hooks/useNearViewportImage'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { createThumbnailObjectUrl, enqueueImageLoad } from '../lib/imagePreview'
import type { CardEntry } from '../types/models'
import type { OnlineCardView } from '../lib/onlineProtocol'

interface Props {
  meta: OnlineCardView
  card?: CardEntry | null
  available: boolean
  picked?: boolean
  result?: boolean
  wrong?: boolean
  readOnly?: boolean
  pinned?: boolean
  showNumber?: boolean
  thumbnail?: boolean
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
let imageCachePromise: Promise<Cache> | null = null

async function openImageCache() {
  if (typeof caches === 'undefined') return null
  if (!imageCachePromise) {
    imageCachePromise = caches.open(CARD_IMAGE_CACHE_NAME).catch((error: unknown) => {
      imageCachePromise = null
      throw error
    })
  }
  return imageCachePromise
}

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

  const load = enqueueImageLoad(async () => {
    try {
      const cache = await openImageCache()
      if (!cache) return imageUrl
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
  })
  pendingImageLoads.set(imageUrl, load)
  void load.finally(() => {
    if (pendingImageLoads.get(imageUrl) === load) pendingImageLoads.delete(imageUrl)
  })
  return load
}

async function loadCachedThumbnail(imageUrl: string) {
  const cacheKey = `thumbnail:${imageUrl}`
  const memoryUrl = cachedImageUrls.get(cacheKey)
  if (memoryUrl) {
    cachedImageUrls.delete(cacheKey)
    cachedImageUrls.set(cacheKey, memoryUrl)
    return memoryUrl
  }
  const pending = pendingImageLoads.get(cacheKey)
  if (pending) return pending

  const load = enqueueImageLoad(async () => {
    try {
      const cache = await openImageCache()
      let response = cache ? await cache.match(imageUrl) : undefined
      if (!response) {
        response = await fetch(imageUrl, { cache: 'force-cache' })
        if (!response.ok) return imageUrl
        if (cache) await cache.put(imageUrl, response.clone())
      }
      const objectUrl = await createThumbnailObjectUrl(await response.blob())
      rememberImageUrl(cacheKey, objectUrl)
      return objectUrl
    } catch {
      return imageUrl
    }
  })
  pendingImageLoads.set(cacheKey, load)
  void load.finally(() => {
    if (pendingImageLoads.get(cacheKey) === load) pendingImageLoads.delete(cacheKey)
  })
  return load
}

function useCachedImageUrl(
  imageUrl: string | undefined,
  thumbnail = false,
): [string | undefined, (element: HTMLButtonElement | null) => void] {
  const imageTargetRef = useRef<HTMLButtonElement | null>(null)
  const setImageTarget = useCallback((element: HTMLButtonElement | null) => {
    imageTargetRef.current = element
  }, [])
  const [shouldLoad, setShouldLoad] = useState(() => {
    if (!imageUrl) return false
    const cacheKey = thumbnail ? `thumbnail:${imageUrl}` : imageUrl
    return typeof IntersectionObserver === 'undefined' || cachedImageUrls.has(cacheKey)
  })
  const [cachedImage, setCachedImage] = useState<{ source: string; url: string } | null>(() => {
    if (!imageUrl) return null
    const cacheKey = thumbnail ? `thumbnail:${imageUrl}` : imageUrl
    const memoryUrl = cachedImageUrls.get(cacheKey)
    return memoryUrl ? { source: imageUrl, url: memoryUrl } : null
  })

  useEffect(() => {
    if (!imageUrl) {
      setShouldLoad(false)
      return
    }
    const target = imageTargetRef.current
    const cacheKey = thumbnail ? `thumbnail:${imageUrl}` : imageUrl
    if (cachedImageUrls.has(cacheKey) || typeof IntersectionObserver === 'undefined' || !target) {
      setShouldLoad(true)
      return
    }

    setShouldLoad(false)
    const root = target.closest('.online-select-viewport, .draft-card-grid')
    return observeNearViewport(target, () => setShouldLoad(true), root)
  }, [imageUrl, thumbnail])

  useEffect(() => {
    let active = true
    if (!imageUrl || !shouldLoad) {
      if (!imageUrl) setCachedImage(null)
      return () => {
        active = false
      }
    }
    const cacheKey = thumbnail ? `thumbnail:${imageUrl}` : imageUrl
    const memoryUrl = cachedImageUrls.get(cacheKey)
    if (memoryUrl) {
      setCachedImage({ source: imageUrl, url: memoryUrl })
      return () => {
        active = false
      }
    }
    setCachedImage(null)
    void (thumbnail ? loadCachedThumbnail(imageUrl) : loadCachedImage(imageUrl)).then((nextUrl) => {
      if (active) setCachedImage({ source: imageUrl, url: nextUrl })
    })
    return () => {
      active = false
    }
  }, [imageUrl, shouldLoad, thumbnail])

  if (!cachedImage || cachedImage.source !== imageUrl) return [undefined, setImageTarget]
  return [cachedImage.url, setImageTarget]
}

function sameCardMeta(previous: OnlineCardView, next: OnlineCardView) {
  return (
    previous.key === next.key &&
    previous.number === next.number &&
    previous.imageName === next.imageName &&
    previous.workName === next.workName &&
    previous.imageUrl === next.imageUrl
  )
}

function areOnlineCardTilePropsEqual(previous: Props, next: Props) {
  if (!sameCardMeta(previous.meta, next.meta)) return false
  if (Boolean(previous.card) !== Boolean(next.card) || previous.card?.imageBlobKey !== next.card?.imageBlobKey) return false
  return (
    previous.available === next.available &&
    previous.picked === next.picked &&
    previous.result === next.result &&
    previous.wrong === next.wrong &&
    previous.readOnly === next.readOnly &&
    previous.pinned === next.pinned &&
    previous.showNumber === next.showNumber &&
    previous.thumbnail === next.thumbnail &&
    previous.slotIndex === next.slotIndex &&
    previous.stateLabel === next.stateLabel &&
    previous.draggable === next.draggable &&
    previous.dragging === next.dragging &&
    previous.dropTarget === next.dropTarget &&
    previous.onDragStart === next.onDragStart &&
    previous.onDragOver === next.onDragOver &&
    previous.onDrop === next.onDrop &&
    previous.onDragEnd === next.onDragEnd &&
    previous.onPointerDown === next.onPointerDown &&
    previous.onPointerMove === next.onPointerMove &&
    previous.onPointerUp === next.onPointerUp &&
    previous.onPointerCancel === next.onPointerCancel &&
    previous.onClick === next.onClick
  )
}

/** A board tile deliberately keeps the local karuta card image as its main cue. */
export const OnlineCardTile = memo(function OnlineCardTile({
  meta,
  card,
  available,
  picked,
  result,
  wrong = false,
  readOnly = false,
  pinned = false,
  showNumber = true,
  thumbnail = false,
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
  const [cachedRemoteImageUrl, imageTargetRef] = useCachedImageUrl(meta.imageUrl, thumbnail)
  const imageUrl = cachedRemoteImageUrl || localImageUrl
  const interactive = !readOnly && (draggable || (available && Boolean(onClick)))
  const className = [
    'online-card-tile',
    available ? 'available' : readOnly ? 'observed' : draggable ? 'arrangeable' : 'claimed',
    picked ? 'picked' : '',
    result ? 'result' : '',
    wrong ? 'wrong' : '',
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
      draggable={interactive && draggable}
      disabled={!interactive}
      onClick={interactive ? onClick : undefined}
      onDragStart={interactive ? onDragStart : undefined}
      onDragOver={interactive ? onDragOver : undefined}
      onDrop={interactive ? onDrop : undefined}
      onDragEnd={interactive ? onDragEnd : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerCancel : undefined}
      data-online-card-key={meta.key}
      data-online-slot-index={slotIndex}
      aria-grabbed={dragging}
      aria-disabled={!interactive}
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
      {wrong ? <span className="online-card-wrong" aria-label="选错">×</span> : null}
      <span className="online-card-title">{meta.workName}</span>
      {pinned ? <span className="online-card-state">已固定</span> : stateLabel ? <span className="online-card-state">{stateLabel}</span> : !available && !readOnly ? <span className="online-card-state">已收取</span> : null}
    </button>
  )
}, areOnlineCardTilePropsEqual)
