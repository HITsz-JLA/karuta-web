import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { test } from 'node:test'
import { readZipAsset, readZipAssetRange } from './zipAsset.mjs'

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

test('coalesces concurrent reads of the same ZIP member', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-zip-in-flight-'))
  try {
    const archivePath = path.join(temp, 'package.zip')
    const zip = new JSZip()
    zip.file('mp3_files/seg_30/answer.mp3', Buffer.from('audio-bytes'))
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))

    const first = readZipAsset(archivePath, 'mp3_files/seg_30/answer.mp3', 'answer.mp3')
    const second = readZipAsset(archivePath, 'mp3_files/seg_30/answer.mp3', 'answer.mp3')
    assert.strictEqual(first, second)
    const asset = await first
    assert.deepEqual(asset.data, Buffer.from('audio-bytes'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readZipAssetRange reads only the requested bytes from a stored member', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-zip-range-stored-'))
  try {
    const archivePath = path.join(temp, 'package.zip')
    const source = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
    const zip = new JSZip()
    zip.file('mp3_files/seg_30/answer.mp3', source, { compression: 'STORE' })
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))

    const asset = await readZipAssetRange(archivePath, 'mp3_files/seg_30/answer.mp3', 'answer.mp3', 'bytes=7-15')
    assert.equal(asset.name, 'mp3_files/seg_30/answer.mp3')
    assert.equal(asset.totalBytes, source.byteLength)
    assert.deepEqual(asset.data, source.subarray(7, 16))
    assert.equal(asset.direct, true)
    assert.deepEqual(asset.range, { start: 7, end: 15 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readZipAssetRange keeps the inflate fallback for compressed members', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-zip-range-deflate-'))
  try {
    const archivePath = path.join(temp, 'package.zip')
    const source = Buffer.from('compressed-audio-payload')
    const zip = new JSZip()
    zip.file('mp3_files/seg_30/answer.mp3', source, { compression: 'DEFLATE' })
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const asset = await readZipAssetRange(archivePath, 'mp3_files/seg_30/answer.mp3', 'answer.mp3', 'bytes=3-11')
    assert.equal(asset.totalBytes, source.byteLength)
    assert.deepEqual(asset.data, source.subarray(3, 12))
    assert.equal(asset.direct, false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readZipAssetRange reports invalid ranges without reading member data', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'karuta-zip-range-invalid-'))
  try {
    const archivePath = path.join(temp, 'package.zip')
    const source = Buffer.from('audio')
    const zip = new JSZip()
    zip.file('mp3_files/seg_30/answer.mp3', source, { compression: 'STORE' })
    await writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))

    const asset = await readZipAssetRange(archivePath, 'mp3_files/seg_30/answer.mp3', 'answer.mp3', 'bytes=99-100')
    assert.equal(asset.totalBytes, source.byteLength)
    assert.equal(asset.data, null)
    assert.deepEqual(asset.range, { invalid: true })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
