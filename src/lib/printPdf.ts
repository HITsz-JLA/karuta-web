import type { CardEntry, PrintMode } from '../types/models'
import { getBlob } from './storage'

const CARDS_PER_PAGE = 4
const PAGE_WIDTH_PX = 2480
const PAGE_HEIGHT_PX = 3508
const PAGE_WIDTH_PT = 595.28
const PAGE_HEIGHT_PT = 841.89
const OUTER_MARGIN_PX = 140
const CARD_GAP_PX = 90
const CARD_RADIUS = 42

export interface PrintableCard {
  title: string
  number: number
  imageBlob: Blob | null
}

export async function buildPrintableCards(cards: CardEntry[]): Promise<PrintableCard[]> {
  const result: PrintableCard[] = []
  for (const card of cards) {
    const imageBlob = card.imageBlobKey ? (await getBlob(card.imageBlobKey)) || null : null
    result.push({
      title: card.workName,
      number: card.number,
      imageBlob,
    })
  }
  return result
}

export async function exportPrintPdf(
  cards: PrintableCard[],
  printMode: PrintMode,
): Promise<Blob> {
  if (!cards.length) throw new Error('数据集为空，无法导出打印 PDF。')

  const pageCount = Math.ceil(cards.length / CARDS_PER_PAGE)
  const pageJpegs: Uint8Array[] = []

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const slice = cards.slice(pageIndex * CARDS_PER_PAGE, (pageIndex + 1) * CARDS_PER_PAGE)
    const canvas = document.createElement('canvas')
    canvas.width = PAGE_WIDTH_PX
    canvas.height = PAGE_HEIGHT_PX
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')

    await renderPage(ctx, slice, printMode)
    const jpeg = await canvasToJpegBytes(canvas)
    pageJpegs.push(jpeg)
  }

  return buildPdfFromJpegs(pageJpegs)
}

async function renderPage(
  ctx: CanvasRenderingContext2D,
  cards: PrintableCard[],
  printMode: PrintMode,
) {
  ctx.fillStyle = '#faf8f4'
  ctx.fillRect(0, 0, PAGE_WIDTH_PX, PAGE_HEIGHT_PX)

  const layout = calculateCardLayout()
  for (let index = 0; index < cards.length; index += 1) {
    const column = index % 2
    const row = Math.floor(index / 2)
    const x = layout.startX + column * (layout.cardWidth + CARD_GAP_PX)
    const y = layout.startY + row * (layout.cardHeight + CARD_GAP_PX)
    await drawCard(ctx, cards[index], x, y, layout.cardWidth, layout.cardHeight, printMode)
  }
}

function calculateCardLayout() {
  let cardWidth = Math.floor((PAGE_WIDTH_PX - 2 * OUTER_MARGIN_PX - CARD_GAP_PX) / 2)
  let cardHeight = Math.floor((cardWidth * 4) / 3)
  const availableHeight = PAGE_HEIGHT_PX - 2 * OUTER_MARGIN_PX - CARD_GAP_PX
  if (cardHeight * 2 > availableHeight) {
    cardHeight = Math.floor(availableHeight / 2)
    cardWidth = Math.floor((cardHeight * 3) / 4)
  }
  const startX = Math.floor((PAGE_WIDTH_PX - (cardWidth * 2 + CARD_GAP_PX)) / 2)
  const startY = Math.floor((PAGE_HEIGHT_PX - (cardHeight * 2 + CARD_GAP_PX)) / 2)
  return { startX, startY, cardWidth, cardHeight }
}

async function drawCard(
  ctx: CanvasRenderingContext2D,
  card: PrintableCard,
  x: number,
  y: number,
  width: number,
  height: number,
  printMode: PrintMode,
) {
  ctx.fillStyle = 'rgba(0,0,0,0.09)'
  roundRect(ctx, x + 14, y + 18, width, height, CARD_RADIUS)
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  roundRect(ctx, x, y, width, height, CARD_RADIUS)
  ctx.fill()
  ctx.strokeStyle = '#dce0e6'
  ctx.lineWidth = 4
  roundRect(ctx, x, y, width, height, CARD_RADIUS)
  ctx.stroke()

  if (printMode === 'ALBUM') {
    await drawAlbumCard(ctx, card, x, y, width, height)
    return
  }

  ctx.save()
  roundRect(ctx, x, y, width, height, CARD_RADIUS)
  ctx.clip()
  await drawCardImage(ctx, card.imageBlob, x, y, width, height, true)
  ctx.restore()
}

async function drawAlbumCard(
  ctx: CanvasRenderingContext2D,
  card: PrintableCard,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const horizontalPadding = Math.max(34, Math.floor(width / 14))
  const topPadding = Math.max(34, Math.floor(height / 18))
  const bottomPadding = Math.max(30, Math.floor(height / 18))
  const titleGap = Math.max(22, Math.floor(height / 36))
  const titleAreaHeight = Math.max(160, Math.floor(height / 3))
  const imageAreaHeight = Math.max(1, height - topPadding - bottomPadding - titleGap - titleAreaHeight)
  const imageSize = Math.max(1, Math.min(width - horizontalPadding * 2, imageAreaHeight))

  const imageX = x + Math.floor((width - imageSize) / 2)
  const imageY = y + topPadding
  const titleX = x + horizontalPadding
  const titleY = imageY + imageSize + titleGap
  const titleWidth = width - horizontalPadding * 2

  ctx.fillStyle = '#f6f8fc'
  roundRect(ctx, imageX, imageY, imageSize, imageSize, 28)
  ctx.fill()

  ctx.save()
  roundRect(ctx, imageX, imageY, imageSize, imageSize, 28)
  ctx.clip()
  // 专辑打印模式：保持原图方向，不做横向图旋转/翻转
  await drawCardImage(ctx, card.imageBlob, imageX, imageY, imageSize, imageSize, false)
  ctx.restore()

  ctx.strokeStyle = '#e4e8ef'
  ctx.lineWidth = 2.5
  roundRect(ctx, imageX, imageY, imageSize, imageSize, 28)
  ctx.stroke()

  drawCardTitle(ctx, `#${card.number}  ${card.title || 'Untitled'}`, titleX, titleY, titleWidth, titleAreaHeight)
}

async function drawCardImage(
  ctx: CanvasRenderingContext2D,
  blob: Blob | null,
  x: number,
  y: number,
  width: number,
  height: number,
  rotateLandscape: boolean,
) {
  if (!blob) {
    drawMissing(ctx, x, y, width, height)
    return
  }

  try {
    const bitmap = await createImageBitmap(blob)
    let source: ImageBitmap | HTMLCanvasElement = bitmap

    if (rotateLandscape && bitmap.width > bitmap.height) {
      const rotated = document.createElement('canvas')
      rotated.width = bitmap.height
      rotated.height = bitmap.width
      const rctx = rotated.getContext('2d')!
      rctx.fillStyle = '#ffffff'
      rctx.fillRect(0, 0, rotated.width, rotated.height)
      rctx.translate(rotated.width, 0)
      rctx.rotate(Math.PI / 2)
      rctx.drawImage(bitmap, 0, 0)
      source = rotated
      bitmap.close()
    }

    const sw = 'width' in source && typeof source.width === 'number' ? source.width : (source as HTMLCanvasElement).width
    const sh = 'height' in source && typeof source.height === 'number' ? source.height : (source as HTMLCanvasElement).height
    const targetAspect = width / height
    const sourceAspect = sw / sh

    let sx = 0
    let sy = 0
    let sWidth = sw
    let sHeight = sh

    if (sourceAspect > targetAspect) {
      sWidth = Math.max(1, Math.round(sh * targetAspect))
      sx = Math.floor((sw - sWidth) / 2)
    } else if (sourceAspect < targetAspect) {
      sHeight = Math.max(1, Math.round(sw / targetAspect))
      sy = Math.floor((sh - sHeight) / 2)
    }

    ctx.drawImage(source as CanvasImageSource, sx, sy, sWidth, sHeight, x, y, width, height)
    if ('close' in source && typeof source.close === 'function') {
      source.close()
    }
  } catch {
    drawMissing(ctx, x, y, width, height)
  }
}

function drawCardTitle(
  ctx: CanvasRenderingContext2D,
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const text = title.trim() || 'Untitled'
  let fontSize = Math.max(34, Math.floor(width / 11))
  const minFontSize = Math.max(18, Math.floor(width / 20))
  let lines: string[] = []

  while (fontSize >= minFontSize) {
    ctx.font = `bold ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
    lines = wrapText(ctx, text, width, 4)
    const lineHeight = fontSize * 1.35
    if (lines.length * lineHeight <= height) break
    fontSize -= 2
  }

  ctx.font = `bold ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.fillStyle = '#2a3447'
  const lineHeight = fontSize * 1.35
  const totalHeight = lines.length * lineHeight
  let currentY = y + Math.max(fontSize, (height - totalHeight) / 2 + fontSize)

  for (const line of lines) {
    const metrics = ctx.measureText(line)
    const lineX = x + (width - metrics.width) / 2
    ctx.fillText(line, lineX, currentY)
    currentY += lineHeight
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const chars = Array.from(text)
  const lines: string[] = []
  let current = ''

  for (const ch of chars) {
    const candidate = current + ch
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = ch
    if (lines.length >= maxLines) break
  }
  if (current && lines.length < maxLines) lines.push(current)

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines)
  }

  if (lines.length === maxLines) {
    let last = lines[maxLines - 1]
    while (last.length && ctx.measureText(`${last}...`).width > maxWidth) {
      last = last.slice(0, -1)
    }
    if (last !== lines[maxLines - 1]) lines[maxLines - 1] = `${last}...`
  }

  return lines.length ? lines : ['']
}

function drawMissing(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  ctx.fillStyle = '#e8ecf2'
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = '#788191'
  ctx.font = `bold ${Math.max(28, Math.floor(width / 18))}px sans-serif`
  const label = 'Image Missing'
  const metrics = ctx.measureText(label)
  ctx.fillText(label, x + (width - metrics.width) / 2, y + height / 2)
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('JPEG 编码失败'))),
      'image/jpeg',
      0.9,
    )
  })
  return new Uint8Array(await blob.arrayBuffer())
}

function buildPdfFromJpegs(pages: Uint8Array[]): Blob {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = [0]
  let offset = 0

  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    parts.push(bytes)
    offset += bytes.length
  }

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  const objectCount = 2 + pages.length * 3
  const objectBodies: (Uint8Array | string)[] = new Array(objectCount + 1)

  objectBodies[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  let kids = ''
  for (let i = 0; i < pages.length; i += 1) {
    kids += `${3 + i * 3} 0 R `
  }
  objectBodies[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`

  for (let i = 0; i < pages.length; i += 1) {
    const pageObjectNumber = 3 + i * 3
    const contentObjectNumber = pageObjectNumber + 1
    const imageObjectNumber = pageObjectNumber + 2
    const jpeg = pages[i]

    objectBodies[pageObjectNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH_PT.toFixed(2)} ${PAGE_HEIGHT_PT.toFixed(2)}] ` +
      `/Resources << /XObject << /Im ${imageObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`

    const content =
      `q\n${PAGE_WIDTH_PT.toFixed(2)} 0 0 ${PAGE_HEIGHT_PT.toFixed(2)} 0 0 cm\n/Im Do\nQ\n`
    const contentBytes = encoder.encode(content)
    objectBodies[contentObjectNumber] = concatBytes(
      encoder.encode(`<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      encoder.encode('\nendstream'),
    )

    objectBodies[imageObjectNumber] = concatBytes(
      encoder.encode(
        `<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH_PX} /Height ${PAGE_HEIGHT_PX} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      encoder.encode('\nendstream'),
    )
  }

  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets[objectNumber] = offset
    push(`${objectNumber} 0 obj\n`)
    push(objectBodies[objectNumber])
    push('\nendobj\n')
  }

  const xrefOffset = offset
  push(`xref\n0 ${objectCount + 1}\n`)
  push('0000000000 65535 f \n')
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    push(`${String(offsets[objectNumber]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n`)
  push(`startxref\n${xrefOffset}\n%%EOF`)

  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

function concatBytes(...chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
