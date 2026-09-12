const IMAGE_LOAD_CONCURRENCY = 4
const THUMBNAIL_MAX_WIDTH = 240
const THUMBNAIL_MAX_HEIGHT = 320
const THUMBNAIL_QUALITY = 0.82

const imageLoadQueue: Array<{
  task: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}> = []
let activeImageLoads = 0

function pumpImageLoadQueue() {
  while (activeImageLoads < IMAGE_LOAD_CONCURRENCY && imageLoadQueue.length) {
    const next = imageLoadQueue.shift()!
    activeImageLoads += 1
    void next.task().then(next.resolve, next.reject).finally(() => {
      activeImageLoads -= 1
      pumpImageLoadQueue()
    })
  }
}

/** Keeps IndexedDB, ZIP and image-decoder work from running in one large burst. */
export function enqueueImageLoad<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    imageLoadQueue.push({
      task: task as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    })
    pumpImageLoadQueue()
  })
}

export function thumbnailBlobKey(imageBlobKey: string) {
  return `thumb:${imageBlobKey}`
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 200 })
      return
    }
    setTimeout(resolve, 0)
  })
}

/** Creates a small WebP preview blob while keeping the source image untouched. */
export async function createThumbnailBlob(blob: Blob, options: { idle?: boolean } = {}): Promise<Blob> {
  if (options.idle) await waitForIdle()
  if (typeof createImageBitmap !== 'function') return blob

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / bitmap.width, THUMBNAIL_MAX_HEIGHT / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    if (scale === 1 && blob.type === 'image/webp') return blob

    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : typeof document !== 'undefined'
          ? Object.assign(document.createElement('canvas'), { width, height })
          : null
    if (!canvas) return blob

    const context = canvas.getContext('2d')
    if (!context) return blob
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'medium'
    context.drawImage(bitmap, 0, 0, width, height)

    const thumbnail =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/webp', quality: THUMBNAIL_QUALITY })
        : await new Promise<Blob | null>((resolve) => {
            ;(canvas as HTMLCanvasElement).toBlob(resolve, 'image/webp', THUMBNAIL_QUALITY)
          })
    return thumbnail || blob
  } catch {
    return blob
  } finally {
    bitmap?.close()
  }
}

/** Creates a small WebP preview while keeping the source image untouched. */
export async function createThumbnailObjectUrl(blob: Blob): Promise<string> {
  return URL.createObjectURL(await createThumbnailBlob(blob))
}
