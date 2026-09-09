import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'

const inflateRawAsync = promisify(inflateRaw)
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * Read one small media member from a ZIP without inflating the whole server
 * package. The existing data packages can be hundreds of megabytes, so loading
 * them through JSZip for every online round would make a room unusable.
 */
export async function readZipAsset(filePath, requestPath, fallbackName = '', kind = 'audio') {
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const tailSize = Math.min(size, 0xffff + 22)
    const tail = Buffer.alloc(tailSize)
    await readAt(handle, tail, size - tailSize)
    const eocd = findSignatureFromEnd(tail, END_OF_CENTRAL_DIRECTORY)
    if (eocd < 0 || eocd + 22 > tail.length) throw new Error('ZIP 目录不存在')

    const disk = tail.readUInt16LE(eocd + 4)
    const directoryDisk = tail.readUInt16LE(eocd + 6)
    const entries = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (disk !== 0 || directoryDisk !== 0 || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error('不支持多磁盘或 Zip64 数据包')
    }
    if (directorySize > 64 * 1024 * 1024) throw new Error('ZIP 目录过大')

    const directory = Buffer.alloc(directorySize)
    await readAt(handle, directory, directoryOffset)
    const members = parseDirectory(directory, entries)
    const member = findMember(members, requestPath, fallbackName, kind)
    if (!member) throw new Error(`找不到${kind === 'image' ? '卡面' : kind === 'catalog' ? '目录' : '音频'}资源`)
    if (member.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`${kind === 'image' ? '卡面' : kind === 'catalog' ? '目录' : '音频'}资源过大`)

    const localHeader = Buffer.alloc(30)
    await readAt(handle, localHeader, member.localHeaderOffset)
    if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER) throw new Error('ZIP 资源头无效')
    const localNameLength = localHeader.readUInt16LE(26)
    const localExtraLength = localHeader.readUInt16LE(28)
    const dataOffset = member.localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = Buffer.alloc(member.compressedSize)
    await readAt(handle, compressed, dataOffset)

    let data
    if (member.compression === 0) data = compressed
    else if (member.compression === 8) data = await inflateRawAsync(compressed)
    else throw new Error('ZIP 资源压缩格式不受支持')
    if (data.byteLength !== member.uncompressedSize) throw new Error('ZIP 资源大小校验失败')
    return { data, name: member.name }
  } finally {
    await handle.close()
  }
}

async function readAt(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesRead) throw new Error('ZIP 文件读取不完整')
    offset += bytesRead
  }
}

function parseDirectory(buffer, expectedEntries) {
  const members = []
  let offset = 0
  while (offset + 46 <= buffer.length && members.length < expectedEntries) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) break
    const flags = buffer.readUInt16LE(offset + 8)
    const compression = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > buffer.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('ZIP 目录项无效')
    }
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (!(flags & 0x0001) && !name.endsWith('/')) {
      members.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset })
    }
    offset = end
  }
  if (members.length === 0) throw new Error('ZIP 没有可读取的资源')
  return members
}

function findMember(members, requestPath, fallbackName, kind) {
  const requested = normalize(requestPath)
  const fallback = normalize(fallbackName)
  const direct = members.find((member) => {
    const name = normalize(member.name)
    return requested && (name === requested || name.endsWith(`/${requested}`))
  })
  if (direct) return direct

  const relative = kind === 'image' ? imageRelativePath(requested) : audioRelativePath(requested)
  if (relative) {
    const segment = members.find((member) => {
      const name = normalize(member.name)
      return (kind === 'image' ? isImageName(name) : isSegmentName(name)) && name.endsWith(`/${relative}`)
    })
    if (segment) return segment
  }

  if (!fallback) return null
  const byName = members.filter((member) => normalize(member.name).endsWith(`/${fallback}`) || normalize(member.name) === fallback)
  return byName.find((member) => (kind === 'image' ? isImageName(normalize(member.name)) : isSegmentName(normalize(member.name)))) || byName[0] || null
}

function audioRelativePath(value) {
  if (!value) return ''
  return value
    .replace(/^.*\/(?:mp3_files|music)\//, '')
    .replace(/^(?:seg_30|full)\//, '')
}

function isSegmentName(value) {
  return /(?:^|\/)(?:seg_30|segments?|music)\//.test(value) && !/(?:^|\/)full\//.test(value)
}

function imageRelativePath(value) {
  if (!value) return ''
  return value.replace(/^.*\/(?:music_cover|images|covers)\//, '')
}

function isImageName(value) {
  return /(?:^|\/)(?:music_cover|images|covers)\//.test(value)
}

function normalize(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
    .toLowerCase()
}

function findSignatureFromEnd(buffer, signature) {
  for (let index = buffer.length - 4; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === signature) return index
  }
  return -1
}
