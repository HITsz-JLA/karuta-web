import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findCatalogCard } from './packageCatalog.mjs'

test('findCatalogCard uses the catalog key index when available', () => {
  const target = { key: 'target', number: 2 }
  const catalog = {
    cards: [target],
    cardByKey: new Map([[target.key, target]]),
  }

  const cards = catalog.cards
  cards.find = () => {
    throw new Error('linear fallback should not run for indexed catalogs')
  }

  assert.equal(findCatalogCard(catalog, target.key), target)
})

test('findCatalogCard keeps a linear fallback for plain catalogs', () => {
  const target = { key: 'target', number: 2 }
  assert.equal(findCatalogCard({ cards: [target] }, target.key), target)
  assert.equal(findCatalogCard({ cards: [target] }, 'missing'), null)
})
