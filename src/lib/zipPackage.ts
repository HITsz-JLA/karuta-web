import JSZip from 'jszip'
import type { CardEntry, DeckRecord, SongEntry } from '../types/models'
import { cardsToCsv, csvRowsToCards, parseCsv, withBom } from './csv'
import { createId, deleteBlobs, getBlob, putBlob, saveDeck } from './storage'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'aif', 'aiff', 'flac'])

function extOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function baseName(path: string) {
  return path.replace(/^.*[\\/]/, '')
}

function lookupName(path: string) {
  return baseName(path).trim().toLowerCase()
}

function isMacOsEntry(path: string) {
  return path.toLowerCase().includes('__macosx')
}

export interface ImportProgress {
  stage: 'reading' | 'parsing' | 'resources'
  current: number
  total: number
  fileName?: string
}

export type ImportProgressHandler = (progress: ImportProgress) => void

export async function exportDeckZip(deck: DeckRecord): Promise<Blob> {
  const zip = new JSZip()
  zip.file(`${deck.name}.csv`, withBom(cardsToCsv(deck.cards)))

  const images = zip.folder('images')!
  const music = zip.folder('music')!

  for (const card of deck.cards) {
    if (card.imageBlobKey) {
      const blob = await getBlob(card.imageBlobKey)
      if (blob) images.file(card.imageName, blob)
    }
    for (const song of card.songs) {
      const blob = await getBlob(song.blobKey)
      if (blob) music.file(song.fileName, blob)
    }
  }

  return zip.generateAsync({ type: 'blob' })
}

export async function importDeckZip(
  file: File,
  preferredName?: string,
  onProgress?: ImportProgressHandler,
): Promise<DeckRecord> {
  onProgress?.({ stage: 'reading', current: 0, total: 1, fileName: file.name })
  const zip = await JSZip.loadAsync(file)
  const entries = Object.keys(zip.files)

  const csvPath =
    entries.find((path) => path.toLowerCase().endsWith('.csv') && !isMacOsEntry(path)) ||
    null
  if (!csvPath) {
    throw new Error('压缩包中未找到 CSV 数据集')
  }

  onProgress?.({ stage: 'parsing', current: 0, total: 100, fileName: baseName(csvPath) })
  const csvText = await zip.files[csvPath].async('string', (metadata) => {
    onProgress?.({
      stage: 'parsing',
      current: metadata.percent,
      total: 100,
      fileName: baseName(csvPath),
    })
  })
  const rows = parseCsv(csvText)

  const imageNames = new Set(rows.map((row) => lookupName(row.image_name)).filter(Boolean))
  const songNames = new Set(
    rows
      .flatMap((row) => (row.songs || '').split('|'))
      .map((name) => lookupName(name))
      .filter(Boolean),
  )

  const imageMap = new Map<string, string>()
  const songMap = new Map<string, string>()
  const resources = entries
    .map((path) => ({ path, entry: zip.files[path], name: baseName(path), ext: extOf(path) }))
    .filter(({ path, entry, name, ext }) => {
      if (entry.dir || !name || isMacOsEntry(path)) return false
      if (IMAGE_EXTS.has(ext)) return imageNames.has(lookupName(name))
      if (AUDIO_EXTS.has(ext)) return songNames.has(lookupName(name))
      return false
    })

  const storedBlobKeys: string[] = []
  onProgress?.({ stage: 'resources', current: 0, total: resources.length })

  try {
    for (const [index, resource] of resources.entries()) {
      const { entry, name, ext } = resource
      const blob = await entry.async('blob', (metadata) => {
        onProgress?.({
          stage: 'resources',
          current: index + metadata.percent / 100,
          total: resources.length,
          fileName: name,
        })
      })

      if (IMAGE_EXTS.has(ext)) {
        const key = createId('img')
        await putBlob(key, blob, blob.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`)
        storedBlobKeys.push(key)
        imageMap.set(lookupName(name), key)
      } else if (AUDIO_EXTS.has(ext)) {
        const key = createId('audio')
        await putBlob(key, blob, blob.type || `audio/${ext}`)
        storedBlobKeys.push(key)
        songMap.set(lookupName(name), key)
      }

      onProgress?.({
        stage: 'resources',
        current: index + 1,
        total: resources.length,
        fileName: name,
      })
    }

    const cards = csvRowsToCards(
      rows,
      (imageName) => imageMap.get(lookupName(imageName)) || null,
      (fileName, displayName) => {
        const blobKey = songMap.get(lookupName(fileName))
        if (!blobKey) return null
        const song: SongEntry = {
          id: createId('song'),
          fileName,
          displayName,
          blobKey,
        }
        return song
      },
    )

    const deckName =
      preferredName ||
      baseName(csvPath).replace(/\.csv$/i, '') ||
      file.name.replace(/\.zip$/i, '') ||
      'imported-deck'

    const deck: DeckRecord = {
      id: createId('deck'),
      name: deckName,
      updatedAt: Date.now(),
      cards,
    }

    await saveDeck(deck)
    return deck
  } catch (error) {
    await deleteBlobs(storedBlobKeys).catch(() => undefined)
    throw error
  }
}

export async function importCsvOnly(
  file: File,
  existingImages: Map<string, string>,
  existingSongs: Map<string, { blobKey: string; fileName: string }>,
): Promise<CardEntry[]> {
  const text = await file.text()
  const rows = parseCsv(text)
  return csvRowsToCards(
    rows,
    (imageName) => existingImages.get(imageName.toLowerCase()) || null,
    (fileName, displayName) => {
      const hit = existingSongs.get(fileName.toLowerCase())
      if (!hit) return null
      return {
        id: createId('song'),
        fileName,
        displayName,
        blobKey: hit.blobKey,
      }
    },
  )
}
