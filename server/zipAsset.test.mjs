import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { test } from 'node:test'
import { readZipAsset } from './zipAsset.mjs'

test('readZipAsset reads a seg_30 member without exposing the archive', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-zip-'))
  try {
    const archivePath = path.join(temp, 'package.zip')
    const zip = new JSZip()
    zip.file('root/mp3_files/seg_30/ANIME/answer.mp3', Buffer.from('audio-bytes'))
    zip.file('root/images/card.jpg', Buffer.from('image-bytes'))
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const asset = await readZipAsset(archivePath, 'mp3_files/ANIME/answer.mp3', 'answer.mp3')
    assert.equal(asset.name, 'root/mp3_files/seg_30/ANIME/answer.mp3')
    assert.deepEqual(asset.data, Buffer.from('audio-bytes'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
