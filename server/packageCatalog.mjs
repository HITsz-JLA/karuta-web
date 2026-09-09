import path from 'node:path'
import { promises as fs } from 'node:fs'
import Papa from 'papaparse'
import { readZipAsset } from './zipAsset.mjs'

export const CURATED_PACKAGE_IDS = new Set([
  'jla-muca-pjsk-lite.zip',
  'jla-muca-bangdream-lite.zip',
  'jla-muca-galgame-lite.zip',
  'jla-muca-anime-lite.zip',
])

const catalogCache = new Map()

export async function loadPackageCatalog(packagePath, packageId = path.basename(packagePath)) {
  const stats = await fs.stat(packagePath)
  const cached = catalogCache.get(packagePath)
  if (cached && cached.size === stats.size && cached.updatedAt === stats.mtimeMs) return cached.catalog

  const csv = await readZipAsset(packagePath, 'meta/metadata.csv', 'metadata.csv', 'catalog')
  const rows = parseCsv(csv.data.toString('utf8'))
  const cards = rows
    .map((row, index) => normalizeRow(row, index))
    .filter((card) => card && card.songs.length)

  const catalog = {
    packageId,
    deckName: path.basename(packageId).replace(/\.zip$/i, ''),
    cards,
  }
  catalogCache.set(packagePath, { size: stats.size, updatedAt: stats.mtimeMs, catalog })
  return catalog
}

export function clearPackageCatalogCache() {
  catalogCache.clear()
}

export function findCatalogCard(catalog, key) {
  return catalog.cards.find((card) => card.key === key) || null
}

function parseCsv(text) {
  const result = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true })
  if (result.errors.length) throw new Error(result.errors[0]?.message || 'CSV 解析失败')
  const rows = (result.data || []).filter((row) => Object.values(row).some((value) => String(value ?? '').trim()))
  const fields = new Set((result.meta.fields || []).map(normalizeHeader))
  if (fields.has('category') && fields.has('work_number') && (fields.has('audio_path') || fields.has('audio_file'))) {
    return normalizeMetadataRows(rows)
  }
  return rows
    .map((row) => ({
      imageName: readField(row, 'image_name'),
      imagePath: readField(row, 'image_path') || undefined,
      workName: readField(row, 'work_name'),
      songs: splitPipe(readField(row, 'songs')).map((fileName, index) => ({
        fileName: baseName(fileName),
        sourcePath: splitPipe(readField(row, 'song_paths'))[index] || fileName,
        displayName: splitPipe(readField(row, 'song_display_names'))[index] || stripExtension(fileName),
      })),
      number: Number.parseInt(readField(row, 'card_number'), 10),
    }))
    .filter((row) => row.imageName || row.workName || row.songs.length)
}

function normalizeMetadataRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    const category = readField(row, 'category')
    const workNumber = readField(row, 'work_number')
    const key = `${category}\u0000${workNumber || `row-${groups.size}`}`
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else groups.set(key, { category, workNumber, rows: [row] })
  }

  return [...groups.values()].map((group, index) => {
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
        const sourcePath = readField(row, 'audio_path')
        const fileName = baseName(readField(row, 'audio_file') || sourcePath)
        return {
          fileName,
          sourcePath: sourcePath || fileName,
          displayName: readField(row, 'song_title') || stripExtension(fileName),
        }
      })
      .filter((song) => song.fileName && song.displayName)
    const imagePaths = firstListValue(orderedRows, 'cover_paths')
    const imageFiles = firstListValue(orderedRows, 'cover_files')
    const imagePath = imagePaths[0] || imageFiles[0] || ''
    if (!imagePath) return null
    const imageName = baseName(imageFiles[0] || imagePath || `card_${index + 1}.jpg`)
    const workName = readField(orderedRows[0] || {}, 'work_name') || [group.category, group.workNumber].filter(Boolean).join(' ') || `作品 ${index + 1}`
    return {
      imageName,
      imagePath: imagePath || undefined,
      workName,
      songs,
      number: Number.parseInt(group.workNumber, 10) > 0 ? Number.parseInt(group.workNumber, 10) : index + 1,
    }
  }).filter(Boolean)
}

function normalizeRow(row, index) {
  const imageName = baseName(row.imageName || `card_${index + 1}.jpg`)
  const imagePath = row.imagePath || imageName
  const workName = String(row.workName || `作品 ${index + 1}`).trim()
  const number = Number.isInteger(row.number) && row.number > 0 ? row.number : index + 1
  const songs = (row.songs || [])
    .map((song) => ({
      fileName: baseName(song.fileName || song.sourcePath),
      sourcePath: String(song.sourcePath || song.fileName || '').trim(),
      displayName: String(song.displayName || stripExtension(song.fileName || song.sourcePath || '')).trim(),
    }))
    .filter((song) => song.fileName && song.sourcePath && song.displayName)
  if (!imageName || !workName || !songs.length) return null
  const key = [String(number), imagePath, workName].join('|')
  return { key, number, imageName, imagePath, workName, songs }
}

function firstListValue(rows, field) {
  for (const row of rows) {
    const values = splitMetadataList(readField(row, field))
    if (values.length) return values
  }
  return []
}

function splitMetadataList(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean)
    } catch {
      // Fall through to the delimiter-based format.
    }
  }
  const delimited = trimmed.split(/[|\r\n]+/).map((item) => item.trim()).filter(Boolean)
  if (delimited.length === 1 && trimmed.includes(';')) {
    const semicolonValues = trimmed.split(';').map((item) => item.trim()).filter(Boolean)
    if (semicolonValues.length > 1 && semicolonValues.every((item) => /\.[a-z0-9]{2,5}$/i.test(item))) return semicolonValues
  }
  return delimited
}

function splitPipe(value) {
  return String(value || '').split('|').map((item) => item.trim()).filter(Boolean)
}

function readField(row, field) {
  const hit = Object.entries(row).find(([key]) => normalizeHeader(key) === field)
  return String(hit?.[1] ?? '').trim()
}

function normalizeHeader(value) {
  return String(value).replace(/^\uFEFF/, '').trim().toLowerCase()
}

function baseName(value) {
  return String(value || '').replace(/^.*[\\/]/, '').trim()
}

function stripExtension(value) {
  const name = baseName(value)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
