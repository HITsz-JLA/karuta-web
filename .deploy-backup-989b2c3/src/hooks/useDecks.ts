import { useCallback, useEffect, useState } from 'react'
import type { DeckMeta, DeckRecord, GameSettings } from '../types/models'
import { DEFAULT_SETTINGS } from '../types/models'
import {
  deleteDeck,
  getDeck,
  listDeckMeta,
  loadSettings,
  saveDeck,
  saveSettings,
} from '../lib/storage'

export function useDeckList() {
  const [decks, setDecks] = useState<DeckMeta[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setDecks(await listDeckMeta())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { decks, loading, refresh }
}

export function useDeck(deckId: string | undefined) {
  const [deck, setDeck] = useState<DeckRecord | null>(null)
  const [loading, setLoading] = useState(Boolean(deckId))

  const refresh = useCallback(async () => {
    if (!deckId) {
      setDeck(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setDeck((await getDeck(deckId)) || null)
    } finally {
      setLoading(false)
    }
  }, [deckId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persist = useCallback(async (next: DeckRecord) => {
    await saveDeck(next)
    setDeck({
      ...next,
      updatedAt: Date.now(),
      cards: next.cards.map((card, index) => ({
        ...card,
        number: Number.isFinite(card.number) && card.number > 0 ? card.number : index + 1,
      })),
    })
  }, [])

  const remove = useCallback(async (deleteBlobs = true) => {
    if (!deckId) return
    await deleteDeck(deckId, deleteBlobs)
    setDeck(null)
  }, [deckId])

  return { deck, loading, refresh, persist, remove }
}

export function useSettings() {
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void loadSettings().then((value) => {
      setSettings(value)
      setReady(true)
    })
  }, [])

  const update = useCallback(async (patch: Partial<GameSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      void saveSettings(next)
      return next
    })
  }, [])

  return { settings, ready, update }
}
