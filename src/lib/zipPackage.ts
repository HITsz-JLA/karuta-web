import JSZip from 'jszip'
import type { CardEntry, DeckRecord, PackageMode, SongEntry } from '../types/models'
import { cardsToCsv, csvRowsToCards, parseCsv, withBom } from './csv'
import { createId, deleteBlobs, getBlob, putBlob, saveDeck } from './storage'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'aif', 'aiff', 'flac'])
const MANIFEST_NAME = 'karuta-manifest.json'

export interface PackageManifest {
  format: 'karuta-web'
  version: 1
  mode: PackageMode
}

interface ZipResource {
  path: string
  entry: JSZip.JSZipObject
  name: string
  ext: string
}

type ResourceKind = 'image' | 'segment' | 'full'

interface ResourceRequest {
  resource: ZipResource
  kind: ResourceKind
  references: string[]
}

export interface ImportProgress {
  stage: 'reading' | 'parsing' | 'resources'
  current: number
  total: number
  fileName?: string
}

export type ImportProgressHandler = (progress: ImportProgress) => void

export function createPackageManifest(mode: PackageMode): PackageManifest {
  return { format: 'karuta-web', version: 1, mode }
}

export async function exportDeckZip(deck: DeckRecord, mode: PackageMode = 'lite'): Promise<Blob> {
  const zip = new JSZip()
  const archiveName = safeArchiveName(deck.name) || 'karuta-deck'
  zip.file(MANIFEST_NAME, JSON.stringify(createPackageManifest(mode), null, 2))
  zip.file(`${archiveName}.csv`, withBom(cardsToCsv(deck.cards)))

  const images = zip.folder('images')!
  const segmentMusic = mode === 'full' ? zip.folder('music/seg_30')! : zip.folder('music')!
  const fullMusic = mode === 'full' ? zip.folder('music/full')! : null

  for (const card of deck.cards) {
    if (card.imageBlobKey) {
      const blob = await getBlob(card.imageBlobKey)
      if (blob) images.file(safeArchiveName(card.imageName) || `card-${card.number}.jpg`, blob)
    }

    for (const song of card.songs) {
      const segmentBlob = await getBlob(song.blobKey)
      if (segmentBlob) {
        segmentMusic.file(safeArchiveName(song.fileName) || `${song.id}.audio`, segmentBlob)
      }

      if (fullMusic && song.fullBlobKey) {
        const fullBlob = await getBlob(song.fullBlobKey)
        if (fullBlob) {
          fullMusic.file(safeArchiveName(song.fileName) || `${song.id}.audio`, fullBlob)
        }
      }
    }
  }

  return zip.generateAsync({ type: 'blob' })
}

export async function importDeckZip(
  file: File,
  preferredName?: string,
  onProgress?: ImportProgressHandler,
  preferredMode?: PackageMode,
): Promise<DeckRecord> {
  onProgress?.({ stage: 'reading', current: 0, total: 1, fileName: file.name })
  const zip = await JSZip.loadAsync(file)
  const entries = Object.keys(zip.files)
  const manifest = await readManifest(zip, entries)
  // A server-side administrator choice is authoritative for server packages;
  // standalone ZIP imports fall back to the embedded manifest.
  const packageMode = preferredMode || manifest?.mode || inferPackageMode(entries)

  const csvPath = findCsvPath(entries)
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
  const zipResources = entries
    .map((path) => ({ path, entry: zip.files[path], name: baseName(path), ext: extOf(path) }))
    .filter(({ path, entry, name, ext }) => !entry.dir && Boolean(name) && !isMacOsEntry(path) && (IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext)))

  const imageMap = new Map<string, string>()
  const segmentMap = new Map<string, string>()
  const fullMap = new Map<string, string>()
  const requests: ResourceRequest[] = []

  for (const row of rows) {
    const imageReferences = compact([row.image_path, row.image_name])
    const imageResource = findResource(zipResources, imageReferences, 'image')
    if (imageResource) requests.push({ resource: imageResource, kind: 'image', references: imageReferences })

    const songFiles = splitPipe(row.songs)
    songFiles.forEach((fileName, songIndex) => {
      const references = compact([row.song_paths?.[songIndex], fileName])
      const segmentResource = findResource(zipResources, references, 'segment')
      if (segmentResource) requests.push({ resource: segmentResource, kind: 'segment', references })

      if (packageMode === 'full') {
        const fullResource = findResource(zipResources, references, 'full')
        if (fullResource) requests.push({ resource: fullResource, kind: 'full', references })
      }
    })
  }

  const resourceByPath = new Map<string, ZipResource>()
  for (const request of requests) resourceByPath.set(normalizePath(request.resource.path), request.resource)
  const resources = [...resourceByPath.values()]
  const storedBlobKeys: string[] = []
  const blobKeysByPath = new Map<string, string>()
  onProgress?.({ stage: 'resources', current: 0, total: resources.length })

  try {
    for (const [index, resource] of resources.entries()) {
      const blob = await resource.entry.async('blob', (metadata) => {
        onProgress?.({
          stage: 'resources',
          current: index + metadata.percent / 100,
          total: resources.length,
          fileName: resource.name,
        })
      })
      const key = createId(IMAGE_EXTS.has(resource.ext) ? 'img' : 'audio')
      await putBlob(key, blob, blob.type || mimeForExtension(resource.ext))
      storedBlobKeys.push(key)
      blobKeysByPath.set(normalizePath(resource.path), key)
      onProgress?.({
        stage: 'resources',
        current: index + 1,
        total: resources.length,
        fileName: resource.name,
      })
    }

    for (const request of requests) {
      const key = blobKeysByPath.get(normalizePath(request.resource.path))
      if (!key) continue
      const map = request.kind === 'image' ? imageMap : request.kind === 'segment' ? segmentMap : fullMap
      registerAliases(map, [...request.references, request.resource.path], key)
    }

    const cards = csvRowsToCards(
      rows,
      (imageName, imagePath) => resolveAlias(imageMap, [imagePath, imageName]),
      (fileName, displayName, songPath) => {
        const references = compact([songPath, fileName])
        const blobKey = resolveAlias(segmentMap, references)
        if (!blobKey) return null
        const fullBlobKey = packageMode === 'full' ? resolveAlias(fullMap, references) : undefined
        const song: SongEntry = {
          id: createId('song'),
          fileName: baseName(fileName) || baseName(songPath || fileName),
          displayName,
          blobKey,
          ...(fullBlobKey ? { fullBlobKey } : {}),
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
    (imageName, imagePath) =>
      existingImages.get((imagePath || imageName).toLowerCase()) || existingImages.get(imageName.toLowerCase()) || null,
    (fileName, displayName, songPath) => {
      const hit = existingSongs.get((songPath || fileName).toLowerCase()) || existingSongs.get(fileName.toLowerCase())
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

async function readManifest(zip: JSZip, entries: string[]): Promise<PackageManifest | null> {
  const manifestPath = entries.find((path) => normalizePath(path).endsWith(`/${MANIFEST_NAME}`) || normalizePath(path) === MANIFEST_NAME)
  if (!manifestPath) return null

  try {
    const value = JSON.parse(await zip.files[manifestPath].async('string')) as Partial<PackageManifest>
    if (value.format !== 'karuta-web' || value.version !== 1 || !isPackageMode(value.mode)) {
      throw new Error('格式或版本不受支持')
    }
    return value as PackageManifest
  } catch (error) {
    if (error instanceof Error && error.message === '格式或版本不受支持') throw error
    throw new Error('数据包 manifest 无效')
  }
}

function findCsvPath(entries: string[]) {
  const metadataPath = entries.find((path) => normalizePath(path).endsWith('/meta/metadata.csv') || normalizePath(path) === 'meta/metadata.csv')
  if (metadataPath && !isMacOsEntry(metadataPath)) return metadataPath
  return entries.find((path) => normalizePath(path).endsWith('.csv') && !isMacOsEntry(path)) || null
}

function inferPackageMode(entries: string[]): PackageMode {
  const normalized = entries.map(normalizePath)
  const hasFull = normalized.some((path) => /(^|\/)full\//.test(path))
  const hasSegment = normalized.some((path) => /(^|\/)(seg_30|segments?)\//.test(path))
  return hasFull && hasSegment ? 'full' : 'lite'
}

function findResource(resources: ZipResource[], references: string[], kind: ResourceKind): ZipResource | null {
  const candidates = resources.filter((resource) => {
    if (kind === 'image') return IMAGE_EXTS.has(resource.ext)
    return AUDIO_EXTS.has(resource.ext)
  })
  let best: { resource: ZipResource; score: number } | null = null
  let bestCount = 0

  for (const resource of candidates) {
    const score = Math.max(...references.map((reference) => resourceScore(resource.path, reference, kind)), 0)
    if (!score) continue
    if (!best || score > best.score) {
      best = { resource, score }
      bestCount = 1
    } else if (score === best.score) {
      bestCount += 1
    }
  }

  // A basename-only match is unsafe when different categories contain the same filename.
  if (!best || (best.score <= 20 && bestCount > 1)) return null
  return best.resource
}

function resourceScore(path: string, reference: string, kind: ResourceKind) {
  const candidate = normalizePath(reference)
  const actual = normalizePath(path)
  const name = baseName(candidate)
  if (!candidate || !name) return 0

  if (actual === candidate || actual.endsWith(`/${candidate}`)) return 100

  if (kind === 'image') {
    const relative = imageRelativePath(candidate)
    const expected = [`music_cover/${relative}`, `images/${relative}`, `covers/${relative}`]
    if (expected.some((suffix) => actual === suffix || actual.endsWith(`/${suffix}`))) {
      return relative.includes('/') ? 90 : 20
    }
  } else {
    const relative = audioRelativePath(candidate)
    const folder = kind === 'full' ? 'full' : 'seg_30'
    const expected = [
      `mp3_files/${folder}/${relative}`,
      `music/${folder}/${relative}`,
      `${folder}/${relative}`,
    ]
    if (expected.some((suffix) => actual === suffix || actual.endsWith(`/${suffix}`))) {
      return relative.includes('/') ? 90 : 20
    }
    if (kind === 'segment') {
      const legacy = [`mp3_files/${relative}`, `music/${relative}`]
      if (legacy.some((suffix) => actual === suffix || actual.endsWith(`/${suffix}`))) {
        return relative.includes('/') ? 80 : 20
      }
    }
  }

  return actual.endsWith(`/${name}`) || actual === name ? 10 : 0
}

function audioRelativePath(value: string) {
  const normalized = normalizePath(value)
  const match = normalized.match(/(?:^|\/)(?:mp3_files|music)\/(?:(?:seg_30|full)\/)?(.+)$/)
  return match?.[1] || normalized
}

function imageRelativePath(value: string) {
  const normalized = normalizePath(value)
  const match = normalized.match(/(?:^|\/)(?:music_cover|images|covers)\/(.+)$/)
  return match?.[1] || normalized
}

function registerAliases(map: Map<string, string>, references: string[], key: string) {
  for (const reference of references) {
    const normalized = normalizePath(reference)
    if (normalized) map.set(normalized, key)
    const name = lookupName(reference)
    if (name && !map.has(`name:${name}`)) map.set(`name:${name}`, key)
  }
}

function resolveAlias(map: Map<string, string>, references: (string | undefined)[]) {
  for (const reference of references) {
    if (!reference) continue
    const exact = map.get(normalizePath(reference))
    if (exact) return exact
  }
  for (const reference of references) {
    if (!reference) continue
    const byName = map.get(`name:${lookupName(reference)}`)
    if (byName) return byName
  }
  return null
}

function compact(values: (string | undefined)[]) {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
}

function splitPipe(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isPackageMode(value: unknown): value is PackageMode {
  return value === 'full' || value === 'lite'
}

function isMacOsEntry(path: string) {
  return normalizePath(path).includes('__macosx')
}

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

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '').trim().toLowerCase()
}

function safeArchiveName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function mimeForExtension(ext: string) {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (IMAGE_EXTS.has(ext)) return `image/${ext}`
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'flac') return 'audio/flac'
  if (AUDIO_EXTS.has(ext)) return `audio/${ext}`
  return 'application/octet-stream'
}
