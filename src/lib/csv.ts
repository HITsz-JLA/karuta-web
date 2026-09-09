import Papa from 'papaparse'
import type { CardEntry, SongEntry } from '../types/models'
import { createId } from './storage'

export interface CsvWorkRow {
  image_name: string
  work_name: string
  songs: string
  song_display_names: string
  card_number?: string
  /** Original cover path, used by the JLA-MUCA metadata importer. */
  image_path?: string
  /** Original audio paths in the same order as `songs`. */
  song_paths?: string[]
}

type RawCsvRow = Record<string, unknown>

export function cardsToCsv(cards: CardEntry[]): string {
  const rows = cards.map((card) => ({
    image_name: card.imageName,
    work_name: card.workName,
    songs: card.songs.map((song) => song.fileName).join('|'),
    song_display_names: card.songs.map((song) => song.displayName).join('|'),
    card_number: String(card.number),
  }))

  return Papa.unparse({
    fields: ['image_name', 'work_name', 'songs', 'song_display_names', 'card_number'],
    data: rows,
  })
}

export function parseCsv(text: string): CsvWorkRow[] {
  const cleaned = text.replace(/^\uFEFF/, '')
  const result = Papa.parse<RawCsvRow>(cleaned, {
    header: true,
    skipEmptyLines: true,
  })

  if (result.errors.length) {
    throw new Error(result.errors[0]?.message || 'CSV 解析失败')
  }

  const rows = (result.data || []).filter((row) =>
    Object.values(row).some((value) => String(value ?? '').trim()),
  )
  const fields = new Set((result.meta.fields || []).map(normalizeHeader))

  if (
    fields.has('category') &&
    fields.has('work_number') &&
    (fields.has('audio_path') || fields.has('audio_file'))
  ) {
    return normalizeMetadataRows(rows)
  }

  return rows
    .map((row) => ({
      image_name: readField(row, 'image_name'),
      work_name: readField(row, 'work_name'),
      songs: readField(row, 'songs'),
      song_display_names: readField(row, 'song_display_names'),
      card_number: readField(row, 'card_number') || undefined,
    }))
    .filter((row) => row.image_name || row.work_name || row.songs)
}

export function csvRowsToCards(
  rows: CsvWorkRow[],
  resolveImageKey: (imageName: string, imagePath?: string) => string | null,
  resolveSong: (fileName: string, displayName: string, songPath?: string) => SongEntry | null,
): CardEntry[] {
  return rows.map((row, index) => {
    const songFiles = splitPipe(row.songs)
    const displayNames = splitPipe(row.song_display_names)
    const songs: SongEntry[] = []

    songFiles.forEach((fileName, songIndex) => {
      const displayName = displayNames[songIndex] || stripExtension(fileName)
      const song = resolveSong(fileName, displayName, row.song_paths?.[songIndex] || fileName)
      if (song) songs.push(song)
    })

    const parsedNumber = Number.parseInt(String(row.card_number || '').trim(), 10)

    return {
      id: createId('card'),
      number: Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : index + 1,
      imageName: row.image_name || `card_${index + 1}.jpg`,
      imageBlobKey: resolveImageKey(row.image_name || '', row.image_path),
      workName: row.work_name || `作品 ${index + 1}`,
      songs,
    }
  })
}

function normalizeMetadataRows(rows: RawCsvRow[]): CsvWorkRow[] {
  const groups = new Map<string, { category: string; workNumber: string; rows: RawCsvRow[] }>()

  for (const row of rows) {
    const category = readField(row, 'category')
    const workNumber = readField(row, 'work_number')
    const key = `${category}\u0000${workNumber || `row-${groups.size}`}`
    const group = groups.get(key)
    if (group) {
      group.rows.push(row)
    } else {
      groups.set(key, { category, workNumber, rows: [row] })
    }
  }

  const grouped = [...groups.values()]

  return grouped.map((group, index) => {
    const orderedRows = [...group.rows].sort((left, right) => {
      const leftSlot = Number.parseInt(readField(left, 'song_slot'), 10)
      const rightSlot = Number.parseInt(readField(right, 'song_slot'), 10)
      if (Number.isFinite(leftSlot) && Number.isFinite(rightSlot)) return leftSlot - rightSlot
      if (Number.isFinite(leftSlot)) return -1
      if (Number.isFinite(rightSlot)) return 1
      return 0
    })

    const songs = orderedRows
      .map((row) => {
        const audioPath = readField(row, 'audio_path')
        const audioFile = baseName(readField(row, 'audio_file') || audioPath)
        return {
          fileName: audioFile,
          path: audioPath || audioFile,
          displayName: readField(row, 'song_title') || stripExtension(audioFile),
        }
      })
      .filter((song) => song.fileName || song.path)

    const coverFiles = firstListValue(orderedRows, 'cover_files')
    const coverPaths = firstListValue(orderedRows, 'cover_paths')
    const imageName = baseName(coverFiles[0] || coverPaths[0] || `card_${index + 1}.jpg`)
    const workName =
      readField(orderedRows[0] || {}, 'work_name') ||
      [group.category, group.workNumber].filter(Boolean).join(' ') ||
      `作品 ${index + 1}`

    return {
      image_name: imageName,
      image_path: coverPaths[0] || coverFiles[0] || undefined,
      work_name: workName,
      songs: songs.map((song) => song.fileName).join('|'),
      song_display_names: songs.map((song) => song.displayName).join('|'),
      song_paths: songs.map((song) => song.path),
      // Keep the source work_number, including intentional gaps or duplicates.
      card_number: Number.parseInt(group.workNumber, 10) > 0 ? group.workNumber : String(index + 1),
    }
  })
}

function firstListValue(rows: RawCsvRow[], field: string): string[] {
  for (const row of rows) {
    const values = splitMetadataList(readField(row, field))
    if (values.length) return values
  }
  return []
}

function splitMetadataList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean)
      }
    } catch {
      // Fall through to the delimiter-based format used by older exports.
    }
  }

  const delimited = trimmed
    .split(/[|\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)

  if (delimited.length === 1 && trimmed.includes(';')) {
    const semicolonValues = trimmed
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
    if (semicolonValues.length > 1 && semicolonValues.every((item) => /\.[a-z0-9]{2,5}$/i.test(item))) {
      return semicolonValues
    }
  }

  return delimited
}

function splitPipe(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
}

function readField(row: RawCsvRow, field: string): string {
  const hit = Object.entries(row).find(([key]) => normalizeHeader(key) === field)
  return String(hit?.[1] ?? '').trim()
}

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase()
}

function baseName(path: string) {
  return path.replace(/^.*[\\/]/, '').trim()
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

export function withBom(csv: string): Blob {
  return new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
}
