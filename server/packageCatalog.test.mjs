import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { test } from 'node:test'
import { findCatalogCard, loadPackageCatalog } from './packageCatalog.mjs'

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

test('loadPackageCatalog accepts legacy root CSV filenames', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-catalog-'))
  try {
    const archivePath = path.join(temp, 'legacy.zip')
    const zip = new JSZip()
    zip.file(
      '旮一把.csv',
      '\ufeffimage_name,work_name,songs,song_display_names,card_number\ncover.jpg,作品一,song.mp3,歌曲一,7\n',
    )
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))

    const catalog = await loadPackageCatalog(archivePath, '旮一把-lite.zip')
    assert.equal(catalog.cards.length, 1)
    assert.equal(catalog.cards[0].key, '7|cover.jpg|作品一')
    assert.equal(catalog.cards[0].songs[0].displayName, '歌曲一')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
