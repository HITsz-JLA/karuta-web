import JSZip from 'jszip'
import type { CardEntry, DeckRecord, SongEntry } from '../types/models'
import { cardsToCsv, csvRowsToCards, parseCsv, withBom } from './csv'
import { createId, getBlob, putBlob, saveDeck } from './storage'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'aif', 'aiff', 'flac'])

function extOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function baseName(path: string) {
  return path.replace(/^.*[\\/]/, '')
}

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

export async function importDeckZip(file: File, preferredName?: string): Promise<DeckRecord> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.keys(zip.files)

  const csvPath =
    entries.find((path) => path.toLowerCase().endsWith('.csv') && !path.includes('__MACOSX')) ||
    null
  if (!csvPath) {
    throw new Error('压缩包中未找到 CSV 数据集')
  }

  const csvText = await zip.files[csvPath].async('string')
  const rows = parseCsv(csvText)

  const imageMap = new Map<string, string>()
  const songMap = new Map<string, string>()

  for (const path of entries) {
    const entry = zip.files[path]
    if (entry.dir || path.includes('__MACOSX')) continue
    const name = baseName(path)
    const ext = extOf(name)
    const blob = await entry.async('blob')

    if (IMAGE_EXTS.has(ext)) {
      const key = createId('img')
      await putBlob(key, blob, blob.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`)
      imageMap.set(name.toLowerCase(), key)
    } else if (AUDIO_EXTS.has(ext)) {
      const key = createId('audio')
      await putBlob(key, blob, blob.type || `audio/${ext}`)
      songMap.set(name.toLowerCase(), key)
    }
  }

  const cards = csvRowsToCards(
    rows,
    (imageName) => imageMap.get(imageName.toLowerCase()) || null,
    (fileName, displayName) => {
      const blobKey = songMap.get(fileName.toLowerCase())
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
