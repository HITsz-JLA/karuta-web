import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DeckMeta, DeckRecord, GameSettings } from '../types/models'
import { DEFAULT_SETTINGS } from '../types/models'

interface KarutaDB extends DBSchema {
  decks: {
    key: string
    value: DeckRecord
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

function getDb() {
  if (!dbPromise) {
    let opening: Promise<IDBPDatabase<KarutaDB>> | undefined
    opening = openDB<KarutaDB>('karuta-web', 1, {
      upgrade(db) {
        const decks = db.createObjectStore('decks', { keyPath: 'id' })
        decks.createIndex('by-updated', 'updatedAt')
        db.createObjectStore('blobs', { keyPath: 'key' })
        db.createObjectStore('settings', { keyPath: 'id' })
      },
      blocking() {
        if (opening) resetDb(opening)
      },
      terminated() {
        if (opening) resetDb(opening)
      },
    })
    dbPromise = opening
    void opening
      .then((db) => {
        if (dbPromise === opening) dbInstance = db
      })
      .catch(() => {
        if (dbPromise === opening) resetDb(opening)
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
  const decks = await withDbRetry((db) => db.getAllFromIndex('decks', 'by-updated'))
  return decks
    .map((deck) => ({
      id: deck.id,
      name: deck.name,
      updatedAt: deck.updatedAt,
      cardCount: deck.cards.length,
      songCount: deck.cards.reduce((sum, card) => sum + card.songs.length, 0),
    }))
    .reverse()
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
  await withDbRetry((db) => db.put('decks', numbered))
}

export async function deleteDeck(id: string, deleteOrphanBlobs = true): Promise<void> {
  await withDbRetry(async (db) => {
    const deck = await db.get('decks', id)
    await db.delete('decks', id)

    if (!deleteOrphanBlobs || !deck) return

    const usedKeys = new Set<string>()
    for (const other of await db.getAll('decks')) {
      for (const card of other.cards) {
        if (card.imageBlobKey) usedKeys.add(card.imageBlobKey)
        for (const song of card.songs) {
          usedKeys.add(song.blobKey)
          if (song.fullBlobKey) usedKeys.add(song.fullBlobKey)
        }
      }
    }

    for (const card of deck.cards) {
      if (card.imageBlobKey && !usedKeys.has(card.imageBlobKey)) {
        await db.delete('blobs', card.imageBlobKey)
      }
      for (const song of card.songs) {
        if (!usedKeys.has(song.blobKey)) {
          await db.delete('blobs', song.blobKey)
        }
        if (song.fullBlobKey && !usedKeys.has(song.fullBlobKey)) {
          await db.delete('blobs', song.fullBlobKey)
        }
      }
    }
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
