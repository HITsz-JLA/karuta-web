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

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<KarutaDB>('karuta-web', 1, {
      upgrade(db) {
        const decks = db.createObjectStore('decks', { keyPath: 'id' })
        decks.createIndex('by-updated', 'updatedAt')
        db.createObjectStore('blobs', { keyPath: 'key' })
        db.createObjectStore('settings', { keyPath: 'id' })
      },
    })
  }
  return dbPromise
}

export function createId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`
}

export async function listDeckMeta(): Promise<DeckMeta[]> {
  const db = await getDb()
  const decks = await db.getAllFromIndex('decks', 'by-updated')
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
  const db = await getDb()
  return db.get('decks', id)
}

export async function saveDeck(deck: DeckRecord): Promise<void> {
  const db = await getDb()
  const numbered: DeckRecord = {
    ...deck,
    updatedAt: Date.now(),
    cards: deck.cards.map((card, index) => ({
      ...card,
      number: index + 1,
    })),
  }
  await db.put('decks', numbered)
}

export async function deleteDeck(id: string, deleteOrphanBlobs = true): Promise<void> {
  const db = await getDb()
  const deck = await db.get('decks', id)
  await db.delete('decks', id)

  if (!deleteOrphanBlobs || !deck) return

  const usedKeys = new Set<string>()
  for (const other of await db.getAll('decks')) {
    for (const card of other.cards) {
      if (card.imageBlobKey) usedKeys.add(card.imageBlobKey)
      for (const song of card.songs) usedKeys.add(song.blobKey)
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
    }
  }
}

export async function putBlob(key: string, blob: Blob, mime?: string): Promise<string> {
  const db = await getDb()
  await db.put('blobs', {
    key,
    mime: mime || blob.type || 'application/octet-stream',
    blob,
  })
  return key
}

export async function deleteBlobs(keys: string[]): Promise<void> {
  if (!keys.length) return
  const db = await getDb()
  const tx = db.transaction('blobs', 'readwrite')
  await Promise.all(keys.map((key) => tx.store.delete(key)))
  await tx.done
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const db = await getDb()
  const record = await db.get('blobs', key)
  return record?.blob
}

export async function getBlobUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null
  const blob = await getBlob(key)
  if (!blob) return null
  return URL.createObjectURL(blob)
}

export async function loadSettings(): Promise<GameSettings> {
  const db = await getDb()
  const stored = await db.get('settings', 'default')
  if (!stored) return { ...DEFAULT_SETTINGS }
  const { id: _id, ...settings } = stored
  return { ...DEFAULT_SETTINGS, ...settings }
}

export async function saveSettings(settings: GameSettings): Promise<void> {
  const db = await getDb()
  await db.put('settings', { id: 'default', ...settings })
}
