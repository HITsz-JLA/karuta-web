import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import express from 'express'
import multer from 'multer'
import { WebSocketServer } from 'ws'
import { OnlineRoomManager } from './onlineRooms.mjs'
import { readZipAssetRange } from './zipAsset.mjs'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(serverDir, '..')
const distDir = path.join(projectDir, 'dist')
const sessionTtlMs = 8 * 60 * 60 * 1000

async function loadDotEnv() {
  const envPath = path.join(projectDir, '.env')
  try {
    const text = await fs.readFile(envPath, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      const key = line.slice(0, separator).trim()
      const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

await loadDotEnv()

const dataDir = path.resolve(projectDir, process.env.KARUTA_DATA_DIR || 'data-packages')
const tempDir = path.join(dataDir, '.tmp')
const metadataDir = path.join(dataDir, '.metadata')
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
const websocketHeartbeatMs = 1_000
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024
const onlineRooms = new OnlineRoomManager(dataDir, {
  maxRooms: Number(process.env.ONLINE_MAX_ROOMS || 100),
})
// packageCatalog returns the same object while the archive's size and mtime
// are unchanged. Cache only the derived wire body by that object identity, so
// an invalidated catalog can never reuse a stale response.
const catalogResponseCache = new WeakMap()

async function getAdminPassword() {
  const configured = process.env.ADMIN_PASSWORD?.trim()
  if (configured) return configured

  const passwordPath = path.join(dataDir, '.admin-password')
  try {
    const saved = (await fs.readFile(passwordPath, 'utf8')).trim()
    if (saved) return saved
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const generated = crypto.randomBytes(18).toString('base64url')
  try {
    await fs.writeFile(passwordPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return (await fs.readFile(passwordPath, 'utf8')).trim()
  }
}

await fs.mkdir(dataDir, { recursive: true })
await fs.mkdir(tempDir, { recursive: true })
await fs.mkdir(metadataDir, { recursive: true })
const adminPassword = await getAdminPassword()
const sessions = new Map()

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function parseCookies(request) {
  const header = request.headers.cookie || ''
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=')
        return separator < 0
          ? [part, '']
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]
      }),
  )
}

function currentSession(request) {
  const token = parseCookies(request).karuta_admin
  if (!token) return null
  const expiresAt = sessions.get(token)
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  return token
}

function requireAdmin(request, response, next) {
  if (!currentSession(request)) {
    response.status(401).json({ message: '需要管理员登录' })
    return
  }
  next()
}

function packageNameFromUpload(originalName) {
  const originalBase = path.basename(originalName || 'package.zip')
  const normalized = originalBase.replace(/[^\p{L}\p{N}._() -]/gu, '_').trim()
  const visibleName = normalized.replace(/^\.+/, '').trim() || 'package'
  return visibleName.toLowerCase().endsWith('.zip') ? visibleName : `${visibleName}.zip`
}

function packagePathFromId(id) {
  let decoded
  try {
    decoded = decodeURIComponent(id)
  } catch {
    return null
  }
  if (!decoded || decoded !== path.basename(decoded) || !decoded.toLowerCase().endsWith('.zip')) return null
  const resolved = path.resolve(dataDir, decoded)
  if (!resolved.startsWith(`${dataDir}${path.sep}`)) return null
  return resolved
}

function isPackageMode(mode) {
  return mode === 'full' || mode === 'lite'
}

function packageMetadataPath(fileName) {
  return path.join(metadataDir, `${fileName}.json`)
}

async function readPackageMode(fileName) {
  try {
    const text = await fs.readFile(packageMetadataPath(fileName), 'utf8')
    const metadata = JSON.parse(text)
    return isPackageMode(metadata?.mode) ? metadata.mode : 'lite'
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`无法读取数据包元数据：${fileName}`, error)
    return 'lite'
  }
}

async function writePackageMetadata(fileName, mode) {
  const metadataPath = packageMetadataPath(fileName)
  const temporaryPath = `${metadataPath}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(
      temporaryPath,
      JSON.stringify({ format: 'karuta-web', version: 1, mode }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    await fs.rename(temporaryPath, metadataPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function listPackages() {
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const packages = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue
    const fullPath = path.join(dataDir, entry.name)
    const stats = await fs.stat(fullPath)
    packages.push({
      id: entry.name,
      name: entry.name.replace(/\.zip$/i, ''),
      fileName: entry.name,
      size: stats.size,
      updatedAt: stats.mtimeMs,
      mode: await readPackageMode(entry.name),
    })
  }
  return packages.sort((left, right) => right.updatedAt - left.updatedAt)
}

async function isZipFile(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead >= 2 && header[0] === 0x50 && header[1] === 0x4b
  } finally {
    await handle.close()
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: tempDir,
    filename: (_request, _file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: maxUploadBytes },
  fileFilter: (_request, file, callback) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      callback(new Error('只允许上传 ZIP 数据包'))
      return
    }
    callback(null, true)
  },
})

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.get('/api/admin/session', (request, response) => {
  response.json({ authenticated: Boolean(currentSession(request)) })
})

app.post('/api/admin/login', (request, response) => {
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  if (!safeEqual(password, adminPassword)) {
    response.status(401).json({ message: '管理员密码错误' })
    return
  }

  const token = crypto.randomBytes(32).toString('base64url')
  sessions.set(token, Date.now() + sessionTtlMs)
  response.setHeader(
    'Set-Cookie',
    `karuta_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionTtlMs / 1000}`,
  )
  response.json({ authenticated: true })
})

app.post('/api/admin/logout', (request, response) => {
  const token = parseCookies(request).karuta_admin
  if (token) sessions.delete(token)
  response.setHeader('Set-Cookie', 'karuta_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  response.json({ authenticated: false })
})

app.get('/api/packages', async (_request, response, next) => {
  try {
    response.json({ packages: await listPackages() })
  } catch (error) {
    next(error)
  }
})

app.get('/api/packages/:id/catalog', async (request, response, next) => {
  try {
    const catalog = await onlineRooms.getPackageCatalog(request.params.id)
    if (!catalog) {
      response.status(404).json({ message: '在线 MUCA 牌组不存在' })
      return
    }
    const cached = catalogResponseCache.get(catalog) || buildCatalogResponse(catalog)
    response.type('json')
    response.setHeader('Content-Length', String(cached.byteLength))
    response.send(cached.body)
  } catch (error) {
    next(error)
  }
})

app.get('/api/packages/:id/card-image', async (request, response, next) => {
  try {
    const cardKey = typeof request.query.cardKey === 'string' ? request.query.cardKey : ''
    const image = await onlineRooms.getPackageCardImage(request.params.id, cardKey)
    if (!image) {
      response.status(404).json({ message: '歌牌卡面不存在' })
      return
    }
    response.setHeader('Content-Type', imageMime(image.name))
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable')
    response.setHeader('Content-Length', String(image.data.byteLength))
    response.send(image.data)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.status(404).json({ message: '歌牌卡面资源不存在' })
      return
    }
    next(error)
  }
})

app.get('/api/packages/:id/download', async (request, response, next) => {
  try {
    const packagePath = packagePathFromId(request.params.id)
    if (!packagePath) {
      response.status(400).json({ message: '数据包名称无效' })
      return
    }
    await fs.access(packagePath)
    response.download(packagePath, path.basename(packagePath), (error) => {
      if (error && !response.headersSent) next(error)
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.status(404).json({ message: '数据包不存在' })
      return
    }
    next(error)
  }
})

app.post('/api/packages', requireAdmin, upload.single('file'), async (request, response, next) => {
  const uploadedPath = request.file?.path
  let finalPath = null
  let moved = false
  try {
    if (!request.file) {
      response.status(400).json({ message: '请选择 ZIP 数据包' })
      return
    }
    const mode = request.body?.mode
    if (!isPackageMode(mode)) {
      response.status(400).json({ message: '请选择数据包模式：完整包或精简包' })
      return
    }
    if (!(await isZipFile(uploadedPath))) {
      response.status(400).json({ message: '上传文件不是有效 ZIP' })
      return
    }

    const safeName = packageNameFromUpload(request.file.originalname)
    const parsed = path.parse(safeName)
    let finalName = safeName
    finalPath = path.join(dataDir, finalName)
    try {
      await fs.access(finalPath)
      finalName = `${parsed.name}-${Date.now()}${parsed.ext}`
      finalPath = path.join(dataDir, finalName)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    await fs.rename(uploadedPath, finalPath)
    moved = true
    await writePackageMetadata(finalName, mode)
    const stats = await fs.stat(finalPath)
    response.status(201).json({
      package: {
        id: finalName,
        name: finalName.replace(/\.zip$/i, ''),
        fileName: finalName,
        size: stats.size,
        updatedAt: stats.mtimeMs,
        mode,
      },
    })
  } catch (error) {
    if (uploadedPath) await fs.rm(uploadedPath, { force: true }).catch(() => undefined)
    if (moved && finalPath) await fs.rm(finalPath, { force: true }).catch(() => undefined)
    next(error)
  }
})

app.get('/api/online/room/:code/audio/:token', async (request, response, next) => {
  try {
    const asset = await onlineRooms.getAudio(request.params.code, request.params.token)
    if (!asset) {
      response.status(404).json({ message: '音频凭证无效或已过期' })
      return
    }
    const media = await readZipAssetRange(asset.packagePath, asset.sourcePath, asset.fileName, request.headers.range)
    const range = media.range
    const totalBytes = media.totalBytes
    response.setHeader('Content-Type', audioMime(media.name || asset.fileName))
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Accept-Ranges', 'bytes')
    if (range?.invalid) {
      response.status(416)
      response.setHeader('Content-Range', `bytes */${totalBytes}`)
      response.end()
      return
    }
    if (range) {
      response.status(206)
      response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalBytes}`)
      response.setHeader('Content-Length', String(media.data.byteLength))
      response.send(media.data)
      return
    }
    response.setHeader('Content-Length', String(totalBytes))
    response.send(media.data)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      response.status(404).json({ message: '音频资源不存在' })
      return
    }
    next(error)
  }
})

app.use('/api', (_request, response) => {
  response.status(404).json({ message: 'API 不存在' })
})

try {
  await fs.access(distDir)
  app.use(express.static(distDir))
  app.use((request, response, next) => {
    if (request.method !== 'GET') {
      next()
      return
    }
    response.sendFile(path.join(distDir, 'index.html'))
  })
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ message: `文件超过 ${Math.floor(maxUploadBytes / 1024 / 1024)} MB 限制` })
    return
  }
  if (error?.message === '只允许上传 ZIP 数据包') {
    response.status(400).json({ message: error.message })
    return
  }
  console.error(error)
  response.status(500).json({ message: '服务器处理失败' })
})

function audioMime(fileName) {
  const ext = path.extname(fileName || '').toLowerCase()
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.flac') return 'audio/flac'
  return 'audio/mpeg'
}

function imageMime(fileName) {
  const ext = path.extname(fileName || '').toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

function buildCatalogResponse(catalog) {
  const body = JSON.stringify({
    catalog: {
      packageId: catalog.packageId,
      deckName: catalog.deckName,
      cards: catalog.cards.map(({ key, number, imageName, workName, songs }) => ({
        key,
        number,
        imageName,
        workName,
        songCount: songs.length,
      })),
    },
  })
  const cached = { body, byteLength: Buffer.byteLength(body) }
  catalogResponseCache.set(catalog, cached)
  return cached
}

const httpServer = createServer(app)
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })

function pingWebsocket(socket) {
  if (socket.readyState !== 1) return
  socket.isAlive = false
  socket.karutaPingAt = Date.now()
  try {
    socket.ping()
  } catch {
    socket.terminate()
  }
}

httpServer.on('upgrade', (request, socket, head) => {
  let url
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  } catch {
    socket.destroy()
    return
  }
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit('connection', websocket, request)
  })
})

websocketServer.on('connection', (socket, request) => {
  const session = onlineRooms.connect(socket, request.socket.remoteAddress || 'unknown')
  let disconnected = false
  socket.isAlive = true
  socket.karutaPingAt = 0
  socket.karutaMissedPongs = 0
  const disconnect = () => {
    if (disconnected) return
    disconnected = true
    onlineRooms.disconnect(session)
  }
  socket.on('message', (message) => {
    void onlineRooms.handle(session, message)
  })
  socket.on('pong', () => {
    socket.isAlive = true
    socket.karutaMissedPongs = 0
    const sentAt = socket.karutaPingAt
    socket.karutaPingAt = 0
    if (sentAt) onlineRooms.recordPong(session, Date.now() - sentAt)
  })
  socket.on('close', disconnect)
  socket.on('error', disconnect)
  pingWebsocket(socket)
})

const websocketHeartbeatTimer = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (socket.isAlive === false) {
      socket.karutaMissedPongs = (socket.karutaMissedPongs || 0) + 1
      if (socket.karutaMissedPongs >= 3) {
        socket.terminate()
      }
      continue
    }
    socket.karutaMissedPongs = 0
    pingWebsocket(socket)
  }
}, websocketHeartbeatMs)
websocketHeartbeatTimer.unref?.()

httpServer.listen(port, host, () => {
  console.log(`Karuta Web server listening on http://${host}:${port}`)
  if (!process.env.ADMIN_PASSWORD) {
    console.log('管理员密码已保存到受保护文件，不会写入服务日志')
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    onlineRooms.dispose()
    clearInterval(websocketHeartbeatTimer)
    websocketServer.close()
    httpServer.close(() => process.exit(0))
  })
}
