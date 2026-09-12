import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DeckMeta, DeckRecord, GameSettings } from '../types/models'
import { DEFAULT_SETTINGS } from '../types/models'
import { thumbnailBlobKey } from './imagePreview'

interface KarutaDB extends DBSchema {
  decks: {
    key: string
    value: DeckRecord
    indexes: { 'by-updated': number }
  }
  deckMeta: {
    key: string
    value: DeckMeta
    indexes: { 'by-updated': number }
  }
  blobs: {
    key: string
    value: {
      key: string
      mime: string
      blob: Blob
    }
  }
  settings: {
    key: string
    value: GameSettings & { id: string }
  }
}

const DB_NAME = 'karuta-web'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<KarutaDB>> | null = null
let dbInstance: IDBPDatabase<KarutaDB> | null = null

function resetDb(expectedPromise?: Promise<IDBPDatabase<KarutaDB>>) {
  if (expectedPromise && dbPromise !== expectedPromise) return
  dbInstance?.close()
  dbInstance = null
  dbPromise = null
}

function isClosedDatabaseError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /connection is closing|invalidstateerror|transactioninactiveerror|transaction is not active/i.test(text)
}

async function withDbRetry<T>(operation: (db: IDBPDatabase<KarutaDB>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const db = await getDb()
      return await operation(db)
    } catch (error) {
      if (attempt === 0 && isClosedDatabaseError(error)) {
        resetDb()
        continue
      }
      throw error
    }
  }
  throw new Error('IndexedDB 操作失败')
}

export function collectDeckBlobKeys(deck: DeckRecord): string[] {
  const keys = new Set<string>()
  for (const card of deck.cards) {
    if (card.imageBlobKey) {
      keys.add(card.imageBlobKey)
      keys.add(thumbnailBlobKey(card.imageBlobKey))
    }
    for (const song of card.songs) {
      keys.add(song.blobKey)
      if (song.fullBlobKey) keys.add(song.fullBlobKey)
    }
  }
  return [...keys]
}

export function toDeckMeta(deck: DeckRecord): DeckMeta {
  return {
    id: deck.id,
    name: deck.name,
    updatedAt: deck.updatedAt,
    cardCount: deck.cards.length,
    songCount: deck.cards.reduce((sum, card) => sum + card.songs.length, 0),
    blobKeys: collectDeckBlobKeys(deck),
    ...(deck.sourcePackageId ? { sourcePackageId: deck.sourcePackageId } : {}),
  }
}

function getDb() {
  if (!dbPromise) {
    let opening: Promise<IDBPDatabase<KarutaDB>> | undefined
    let ready: Promise<IDBPDatabase<KarutaDB>> | undefined
    let needsDeckMetaBackfill = false
    opening = openDB<KarutaDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const decks = db.createObjectStore('decks', { keyPath: 'id' })
          decks.createIndex('by-updated', 'updatedAt')
          db.createObjectStore('blobs', { keyPath: 'key' })
          db.createObjectStore('settings', { keyPath: 'id' })
        }
        if (oldVersion < 2) {
          const meta = db.createObjectStore('deckMeta', { keyPath: 'id' })
          meta.createIndex('by-updated', 'updatedAt')
          needsDeckMetaBackfill = oldVersion >= 1
        }
      },
      blocking() {
        if (ready) resetDb(ready)
      },
      terminated() {
        if (ready) resetDb(ready)
      },
    })
    ready = opening.then(async (db) => {
      dbInstance = db
      // Never await IDB reads/writes from the versionchange callback. A
      // versionchange transaction can become inactive between awaits, which
      // made existing v1 databases fail before the editor could open them.
      if (needsDeckMetaBackfill) {
        const decks = await db.getAll('decks')
        const existingMetaKeys = new Set(await db.getAllKeys('deckMeta'))
        const missing = decks.filter((deck) => !existingMetaKeys.has(deck.id))
        if (missing.length) {
          const tx = db.transaction('deckMeta', 'readwrite')
          for (const deck of missing) tx.store.put(toDeckMeta(deck))
          await tx.done
        }
      }
      return db
    })
    dbPromise = ready
    void ready
      .catch(() => {
        if (dbPromise === ready) resetDb(ready)
      })
  }
  return dbPromise
}

export function createId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID?.()
  const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${uuid || fallback}`
}

export async function listDeckMeta(): Promise<DeckMeta[]> {
  return withDbRetry(async (db) => {
    let metas = await db.getAllFromIndex('deckMeta', 'by-updated')
    if (!metas.length) {
      const decks = await db.getAllFromIndex('decks', 'by-updated')
      if (decks.length) {
        metas = decks.map((deck) => toDeckMeta(deck))
        const tx = db.transaction('deckMeta', 'readwrite')
        await Promise.all(metas.map((meta) => tx.store.put(meta)))
        await tx.done
      }
    }
    return metas.sort((left, right) => right.updatedAt - left.updatedAt)
  })
}

export async function getDeck(id: string): Promise<DeckRecord | undefined> {
  return withDbRetry((db) => db.get('decks', id))
}

export async function saveDeck(deck: DeckRecord): Promise<void> {
  const numbered: DeckRecord = {
    ...deck,
    updatedAt: Date.now(),
    cards: deck.cards.map((card, index) => ({
      ...card,
      number: Number.isFinite(card.number) && card.number > 0 ? card.number : index + 1,
    })),
  }
  await withDbRetry(async (db) => {
    const tx = db.transaction(['decks', 'deckMeta'], 'readwrite')
    await tx.objectStore('decks').put(numbered)
    await tx.objectStore('deckMeta').put(toDeckMeta(numbered))
    await tx.done
  })
}

export async function deleteDeck(id: string, deleteOrphanBlobs = true): Promise<void> {
  await withDbRetry(async (db) => {
    const [deck, meta] = await Promise.all([db.get('decks', id), db.get('deckMeta', id)])
    const ownedKeys = meta?.blobKeys?.length ? meta.blobKeys : deck ? collectDeckBlobKeys(deck) : []

    const tx = db.transaction(['decks', 'deckMeta', 'blobs'], 'readwrite')
    await tx.objectStore('decks').delete(id)
    await tx.objectStore('deckMeta').delete(id)

    if (deleteOrphanBlobs && ownedKeys.length) {
      const others = await tx.objectStore('deckMeta').getAll()
      const usedKeys = new Set<string>()
      for (const other of others) {
        for (const key of other.blobKeys || []) usedKeys.add(key)
      }
      const blobStore = tx.objectStore('blobs')
      await Promise.all(ownedKeys.filter((key) => !usedKeys.has(key)).map((key) => blobStore.delete(key)))
    }

    await tx.done
  })
}

export async function putBlob(key: string, blob: Blob, mime?: string): Promise<string> {
  await withDbRetry((db) => db.put('blobs', {
    key,
    mime: mime || blob.type || 'application/octet-stream',
    blob,
  }))
  return key
}

export async function deleteBlobs(keys: string[]): Promise<void> {
  if (!keys.length) return
  await withDbRetry(async (db) => {
    const tx = db.transaction('blobs', 'readwrite')
    await Promise.all(keys.map((key) => tx.store.delete(key)))
    await tx.done
  })
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const record = await withDbRetry((db) => db.get('blobs', key))
  return record?.blob
}

export async function getBlobUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null
  const blob = await getBlob(key)
  if (!blob) return null
  return URL.createObjectURL(blob)
}

export async function loadSettings(): Promise<GameSettings> {
  const stored = await withDbRetry((db) => db.get('settings', 'default'))
  if (!stored) return { ...DEFAULT_SETTINGS }
  const { id: _id, ...settings } = stored
  return { ...DEFAULT_SETTINGS, ...settings }
}

export async function saveSettings(settings: GameSettings): Promise<void> {
  await withDbRetry((db) => db.put('settings', { id: 'default', ...settings }))
}
