import Papa from 'papaparse'
import type { CardEntry, SongEntry } from '../types/models'
import { createId } from './storage'

export interface CsvWorkRow {
  image_name: string
  work_name: string
  songs: string
  song_display_names: string
  card_number?: string
}

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
  const result = Papa.parse<CsvWorkRow>(cleaned, {
    header: true,
    skipEmptyLines: true,
  })

  if (result.errors.length) {
    throw new Error(result.errors[0]?.message || 'CSV 解析失败')
  }

  return (result.data || []).filter((row) => row.image_name || row.work_name)
}

export function csvRowsToCards(
  rows: CsvWorkRow[],
  resolveImageKey: (imageName: string) => string | null,
  resolveSong: (fileName: string, displayName: string) => SongEntry | null,
): CardEntry[] {
  return rows.map((row, index) => {
    const songFiles = splitPipe(row.songs)
    const displayNames = splitPipe(row.song_display_names)
    const songs: SongEntry[] = []

    songFiles.forEach((fileName, songIndex) => {
      const displayName = displayNames[songIndex] || stripExtension(fileName)
      const song = resolveSong(fileName, displayName)
      if (song) songs.push(song)
    })

    const parsedNumber = Number.parseInt(String(row.card_number || '').trim(), 10)

    return {
      id: createId('card'),
      number: Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : index + 1,
      imageName: row.image_name || `card_${index + 1}.jpg`,
      imageBlobKey: resolveImageKey(row.image_name || ''),
      workName: row.work_name || `作品 ${index + 1}`,
      songs,
    }
  })
}

function splitPipe(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

export function withBom(csv: string): Blob {
  return new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
}
