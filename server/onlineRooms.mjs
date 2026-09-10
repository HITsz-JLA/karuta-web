import crypto from 'node:crypto'
import path from 'node:path'
import { CURATED_PACKAGE_IDS, findCatalogCard, loadPackageCatalog } from './packageCatalog.mjs'
import { logOnlineEvent } from './onlineLog.mjs'
import { readZipAsset } from './zipAsset.mjs'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 6
const MAX_NICKNAME_LENGTH = 20
const MAX_ROOM_NAME_LENGTH = 40
const MIN_CANDIDATE_CARDS = 60
const MAX_CARDS = 500
const ONLINE_CANDIDATE_LIMIT = 200
const DRAFT_SELECTION_SIZE = 30
const BAN_SIZE = 5
const HAND_SIZE = DRAFT_SELECTION_SIZE - BAN_SIZE
const MAX_HAND_SLOTS = 33
const EMPTY_SONG_COUNT = 20
const ARRANGE_WINDOW_MS = 3 * 60 * 1000
const REST_WINDOW_MS = 40_000
const WRONG_TRANSFER_TIMEOUT_MS = REST_WINDOW_MS
const REST_AUDIO_GRACE_MS = 10_000
const ROUND_WINDOW_MS = 10_000
// Give clients enough time to start the media request before the authoritative
// round timestamp. The server still evaluates claims against startAt, so this
// does not change the fair claim window.
const ROUND_LEAD_MS = 2_000
const ROOM_TTL_MS = 30 * 60 * 1000
const RESUME_TTL_MS = 90 * 1000
const MAX_SPECTATORS = 32
const MAX_MESSAGE_BYTES = 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])

export const NETWORK_MIN_SAMPLES = 3
export const NETWORK_MAX_RTT_GAP_MS = 80
export const NETWORK_MAX_JITTER_MS = 60
export const NETWORK_MAX_JITTER_GAP_MS = 40
export const CLAIM_COMPENSATION_CAP_MS = 60
export const CLAIM_SETTLE_DELAY_MS = 125

const NETWORK_MAX_SAMPLES = 12
const NETWORK_MAX_RTT_MS = 5_000

const EMPTY_SCORES = () => ({ A: 0, B: 0 })

function roundMetric(value) {
  return Math.round(value)
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function networkMetrics(samples) {
  const rttMs = median(samples)
  const jitterSamples = samples.slice(1).map((sample, index) => Math.abs(sample - samples[index]))
  const jitterMs = median(jitterSamples)
  return {
    rttMs: rttMs === null ? null : roundMetric(rttMs),
    jitterMs: jitterMs === null ? null : roundMetric(jitterMs),
    samples: samples.length,
  }
}

function emptyNetwork() {
  return { samples: [], rttMs: null, jitterMs: null }
}

function shuffle(values) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1)
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

function otherPlayer(playerId) {
  return playerId === 'A' ? 'B' : 'A'
}

function effectiveLayout(layout, handCardKeys) {
  const hand = new Set(handCardKeys)
  const used = new Set()
  const result = Array.from({ length: MAX_HAND_SLOTS }, (_, index) => {
    const key = layout?.[index]
    if (typeof key !== 'string' || !hand.has(key) || used.has(key)) return null
    used.add(key)
    return key
  })
  const unplaced = handCardKeys.filter((key) => !used.has(key))
  let nextUnplaced = 0
  for (let index = 0; index < result.length && nextUnplaced < unplaced.length; index += 1) {
    if (result[index] === null) result[index] = unplaced[nextUnplaced++]
  }
  return result
}

export class OnlineRoomManager {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir
    this.maxRooms = options.maxRooms || 100
    this.rooms = new Map()
    this.sessions = new Map()
    this.resumeIndex = new Map()
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000)
    this.cleanupTimer.unref?.()
  }

  connect(socket, ip = 'unknown') {
    const session = {
      id: crypto.randomBytes(6).toString('hex'),
      socket,
      ip,
      room: null,
      playerId: null,
      resumeToken: null,
      spectator: false,
      replaced: false,
      network: emptyNetwork(),
    }
    this.sessions.set(socket, session)
    logOnlineEvent('ws.connected', { sessionId: session.id })
    this.send(session, { t: 'welcome', resumed: false })
    return session
  }

  recordPong(session, rttMs) {
    if (!session || !this.sessions.has(session.socket)) return
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > NETWORK_MAX_RTT_MS) return
    const previousSampleCount = session.network.samples.length
    const previousRttMs = session.network.rttMs
    const previousJitterMs = session.network.jitterMs
    session.network.samples.push(roundMetric(rttMs))
    if (session.network.samples.length > NETWORK_MAX_SAMPLES) session.network.samples.shift()
    const metrics = networkMetrics(session.network.samples)
    session.network.rttMs = metrics.rttMs
    session.network.jitterMs = metrics.jitterMs
    const changed =
      previousSampleCount !== metrics.samples || previousRttMs !== metrics.rttMs || previousJitterMs !== metrics.jitterMs
    // Heartbeats still update the authoritative rolling samples, but identical
    // metrics do not need to wake every player and spectator.
    if (session.room && changed) session.room.networkChanged()
  }

  async handle(session, rawMessage) {
    if (!this.sessions.has(session.socket)) return
    if (Buffer.byteLength(String(rawMessage), 'utf8') > MAX_MESSAGE_BYTES) {
      this.sendError(session, 'message_too_large', '消息过大')
      return
    }

    let message
    try {
      message = JSON.parse(String(rawMessage))
    } catch {
      this.sendError(session, 'bad_message', '消息格式无效')
      return
    }

    try {
      switch (message?.t) {
        case 'hello':
          this.hello(session, message.resumeToken)
          break
        case 'listRooms':
          this.send(session, { t: 'roomList', rooms: this.roomList() })
          break
        case 'createRoom':
          await this.createRoom(session, message)
          break
        case 'joinRoom':
          this.joinRoom(session, message)
          break
        case 'spectateRoom':
          this.spectateRoom(session, message)
          break
        case 'ready':
          this.currentRoom(session)?.setReady(session, message.ready === true)
          break
        case 'selectCards':
          this.currentRoom(session)?.selectCards(session, message)
          break
        case 'banCards':
          this.currentRoom(session)?.banCards(session, message)
          break
        case 'arrangeLayout':
          this.currentRoom(session)?.arrangeLayout(session, message)
          break
        case 'giveCard':
          this.currentRoom(session)?.giveCard(session, message)
          break
        case 'claim':
          this.currentRoom(session)?.claim(session, message)
          break
        case 'leaveRoom':
          this.leave(session)
          break
        case 'ping':
          if (Number.isFinite(message.clientAt)) {
            this.send(session, { t: 'pong', clientAt: message.clientAt, serverAt: Date.now() })
          }
          break
        default:
          this.sendError(session, 'unknown_message', '不支持的操作')
      }
    } catch (error) {
      console.error('在线歌牌消息处理失败', error)
      this.sendError(session, 'server_error', '服务器处理失败')
    }
  }

  disconnect(session) {
    if (!this.sessions.delete(session.socket)) return
    const room = session.room
    logOnlineEvent('ws.disconnected', {
      sessionId: session.id,
      room: room?.code,
      playerId: session.playerId,
      spectator: session.spectator,
      phase: room?.phase,
      reason: session.disconnectReason,
    })
    if (!room) return
    if (session.spectator) {
      room.removeSpectator(session)
      return
    }
    if (!session.playerId) return
    room.disconnect(session.playerId)
  }

  async getAudio(roomCode, token) {
    const normalizedRoomCode = normalizeCode(roomCode)
    const room = this.rooms.get(normalizedRoomCode)
    const asset = room?.assetForToken(token)
    if (!asset) {
      logOnlineEvent('audio.miss', { room: normalizedRoomCode })
      return null
    }
    return { ...asset, packagePath: path.join(this.dataDir, asset.packageId) }
  }

  async getPackageCatalog(packageId) {
    if (!CURATED_PACKAGE_IDS.has(packageId)) return null
    const packagePath = path.join(this.dataDir, packageId)
    try {
      return await loadPackageCatalog(packagePath, packageId)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async getPackageCardImage(packageId, cardKey) {
    const catalog = await this.getPackageCatalog(packageId)
    const card = catalog && findCatalogCard(catalog, cardKey)
    if (!card) return null
    const packagePath = path.join(this.dataDir, packageId)
    return readZipAsset(packagePath, card.imagePath, card.imageName, 'image')
  }

  dispose() {
    clearInterval(this.cleanupTimer)
    for (const room of this.rooms.values()) room.dispose()
    this.rooms.clear()
    this.resumeIndex.clear()
    this.sessions.clear()
  }

  currentRoom(session) {
    return session.room
  }

  hello(session, resumeToken) {
    // A socket that already belongs to a room must never be rebound through a
    // resume token. In particular, a spectator must not be able to present a
    // player's token and become an input-capable session in the same room.
    if (session.room || session.spectator) {
      logOnlineEvent('resume.rejected', {
        reason: 'session_already_bound',
        sessionId: session.id,
        room: session.room?.code,
      })
      this.send(session, { t: 'welcome', resumed: false, resumeRejected: true })
      return
    }
    if (typeof resumeToken !== 'string' || !resumeToken) return
    const record = this.resumeIndex.get(resumeToken)
    if (!record || record.expiresAt < Date.now()) {
      this.resumeIndex.delete(resumeToken)
      logOnlineEvent('resume.rejected', {
        reason: 'invalid_or_expired',
        sessionId: session.id,
        room: record?.room?.code,
      })
      this.send(session, { t: 'welcome', resumed: false, resumeRejected: true })
      return
    }
    const seat = record.room.seats[record.playerId]
    if (!seat) {
      logOnlineEvent('resume.rejected', {
        reason: 'seat_missing',
        sessionId: session.id,
        room: record.room.code,
        playerId: record.playerId,
      })
      this.send(session, { t: 'welcome', resumed: false, resumeRejected: true })
      return
    }
    let replacedSessionId
    if (seat.socket) {
      const previousSession = seat.socket
      // A browser refresh can open the replacement WebSocket before the old
      // WebSocket's close event reaches Node. The resume token authenticates
      // the same player, so let the replacement take the seat immediately.
      // Detach the old session before closing it; otherwise its delayed close
      // handler could clear the newly restored seat a moment later.
      if (
        previousSession !== session &&
        previousSession.room === record.room &&
        previousSession.playerId === record.playerId &&
        !previousSession.spectator
      ) {
        replacedSessionId = previousSession.id
        this.replacePlayerSession(previousSession)
      } else {
        logOnlineEvent('resume.rejected', {
          reason: 'seat_occupied',
          sessionId: session.id,
          room: record.room.code,
          playerId: record.playerId,
        })
        this.send(session, { t: 'welcome', resumed: false, resumeRejected: true })
        return
      }
    }
    session.room = record.room
    session.playerId = record.playerId
    session.resumeToken = resumeToken
    seat.socket = session
    seat.disconnectedAt = null
    record.expiresAt = Date.now() + RESUME_TTL_MS
    logOnlineEvent('resume.accepted', {
      sessionId: session.id,
      replacedSessionId,
      room: record.room.code,
      playerId: record.playerId,
    })
    this.send(session, { t: 'welcome', resumed: true, resumeToken })
    // A resumed client may have missed every incremental network/peer update
    // while it was disconnected. Restore the authoritative room snapshot
    // before continuing with heartbeat-only updates.
    record.room.touch()
    record.room.networkChanged(true)
    record.room.broadcastPeer(record.playerId, true)
    record.room.sendCurrentState(session)
  }

  replacePlayerSession(session) {
    logOnlineEvent('ws.replaced', {
      sessionId: session.id,
      room: session.room?.code,
      playerId: session.playerId,
    })
    this.sessions.delete(session.socket)
    session.replaced = true
    session.room = null
    session.playerId = null
    session.resumeToken = null
    session.spectator = false
    try {
      if (session.socket?.readyState === 0 || session.socket?.readyState === 1) session.socket.close(4001, 'resumed elsewhere')
    } catch {
      // Closing an already closing browser socket is harmless.
    }
  }

  async createRoom(session, message) {
    if (session.room) {
      this.sendError(session, 'already_in_room', '你已经在一个房间中')
      return
    }
    if (this.rooms.size >= this.maxRooms) {
      this.sendError(session, 'rooms_full', '在线房间已达到上限')
      return
    }

    const nickname = sanitizeText(message.nickname, MAX_NICKNAME_LENGTH)
    const name = sanitizeText(message.name, MAX_ROOM_NAME_LENGTH) || '歌牌房间'
    const packageId = safePackageId(message.packageId)
    if (!nickname) {
      this.sendError(session, 'bad_nickname', '请输入昵称')
      return
    }
    if (!packageId || !CURATED_PACKAGE_IDS.has(packageId)) {
      this.sendError(session, 'bad_room', '在线歌牌只能使用服务器上已发布的牌组')
      return
    }
    const catalog = await this.getPackageCatalog(packageId)
    if (!catalog) {
      this.sendError(session, 'package_not_found', '服务器找不到该牌组或牌组目录无效')
      return
    }
    const requestedKeys = Array.isArray(message.cardKeys)
      ? [...new Set(message.cardKeys.filter((key) => typeof key === 'string'))]
      : catalog.cards.map((card) => card.key)
    const requested = new Set(requestedKeys)
    const cards = normalizeCards(catalog.cards.filter((card) => requested.has(card.key)))
    const deckName = sanitizeText(message.deckName, 80) || catalog.deckName
    if (!cards.ok) {
      this.sendError(session, 'bad_room', cards.message || '房间数据无效')
      return
    }

    // Large catalogues are sampled at room creation time. The authoritative
    // room list is then split by the normal draft flow for both players.
    const candidateCards = cards.value.length > ONLINE_CANDIDATE_LIMIT
      ? shuffle(cards.value).slice(0, ONLINE_CANDIDATE_LIMIT)
      : cards.value
    const roomCards = candidateCards.length % 2 === 0 ? candidateCards : shuffle(candidateCards).slice(0, -1)
    const room = new OnlineRoom(this, {
      code: this.newCode(),
      name,
      packageId,
      deckName,
      cards: roomCards,
      catalogCards: catalog.cards,
    })
    this.rooms.set(room.code, room)
    this.joinSeat(room, session, nickname, 'A')
    logOnlineEvent('room.created', { room: room.code, packageId, deckName })
    this.broadcastRoomList()
  }

  joinRoom(session, message) {
    if (session.room) {
      this.sendError(session, 'already_in_room', '你已经在一个房间中')
      return
    }
    const nickname = sanitizeText(message.nickname, MAX_NICKNAME_LENGTH)
    const code = normalizeCode(message.code)
    const room = this.rooms.get(code)
    if (!nickname) {
      this.sendError(session, 'bad_nickname', '请输入昵称')
      return
    }
    if (!room) {
      this.sendError(session, 'room_not_found', '房间不存在或已结束')
      return
    }
    if (room.phase !== 'lobby' || room.playerCount >= 2) {
      this.sendError(session, 'room_full', '房间已经开始或已满')
      return
    }
    this.joinSeat(room, session, nickname, 'B')
    logOnlineEvent('room.joined', { room: room.code, playerId: 'B' })
    this.broadcastRoomList()
  }

  spectateRoom(session, message) {
    const code = normalizeCode(message.code)
    if (session.room) {
      if (session.spectator && session.room.code === code) {
        session.room.sendSpectatorState(session)
        return
      }
      this.sendError(session, 'already_in_room', '你已经在一个房间中')
      return
    }
    const room = this.rooms.get(code)
    if (!room || !['arrange', 'playing'].includes(room.phase)) {
      this.sendError(session, 'spectate_unavailable', '该对局尚未开始或已经结束')
      return
    }
    if (!room.canAddSpectator()) {
      this.sendError(session, 'spectators_full', '观战人数已达到上限，请稍后再试')
      return
    }
    session.room = room
    session.spectator = true
    logOnlineEvent('room.spectated', { room: room.code, sessionId: session.id })
    room.addSpectator(session)
    room.sendSpectatorState(session)
    room.sendNetwork()
  }

  joinSeat(room, session, nickname, requestedSeat) {
    const playerId = room.seats[requestedSeat] ? 'B' : requestedSeat
    if (room.seats[playerId]) {
      this.sendError(session, 'room_full', '房间已经满员')
      return
    }
    const resumeToken = crypto.randomBytes(18).toString('base64url')
    room.seats[playerId] = {
      nickname,
      socket: session,
      resumeToken,
      ready: false,
      arrangeReady: false,
      restReady: false,
      score: 0,
      correctClaims: 0,
      poolCardKeys: [],
      selectedCardKeys: [],
      exchangeCardKeys: [],
      bannedCardKeys: [],
      handCardKeys: [],
      layoutCardKeys: [],
      disconnectedAt: null,
    }
    session.room = room
    session.playerId = playerId
    session.resumeToken = resumeToken
    this.resumeIndex.set(resumeToken, { room, playerId, expiresAt: Date.now() + RESUME_TTL_MS })
    logOnlineEvent('seat.joined', { room: room.code, playerId, sessionId: session.id })
    this.send(session, { t: 'welcome', resumed: false, resumeToken })
    room.touch()
    room.sendRoom()
  }

  leave(session) {
    const room = session.room
    if (!room) return
    if (session.spectator) {
      room.removeSpectator(session)
      this.forgetSession(session)
      this.broadcastRoomList()
      return
    }
    if (!session.playerId) return
    const playerId = session.playerId
    room.leave(playerId)
    this.forgetSession(session)
    this.broadcastRoomList()
  }

  forgetSession(session) {
    if (session.resumeToken) this.resumeIndex.delete(session.resumeToken)
    session.room = null
    session.playerId = null
    session.resumeToken = null
    session.spectator = false
  }

  dropRoom(room) {
    if (this.rooms.get(room.code) !== room) return
    for (const session of room.spectators) {
      this.send(session, { t: 'error', code: 'room_closed', message: '对局已结束，观战已关闭' })
      this.forgetSession(session)
    }
    room.spectators.clear()
    room.dispose()
    for (const playerId of ['A', 'B']) {
      const seat = room.seats[playerId]
      if (seat?.resumeToken) this.resumeIndex.delete(seat.resumeToken)
      if (seat?.socket) this.forgetSession(seat.socket)
    }
    this.rooms.delete(room.code)
    this.broadcastRoomList()
  }

  broadcastRoomList() {
    const message = { t: 'roomList', rooms: this.roomList() }
    const serialized = JSON.stringify(message)
    for (const session of this.sessions.values()) {
      if (!session.room) this.sendSerialized(session, serialized)
    }
  }

  roomList() {
    return [...this.rooms.values()]
      .filter((room) => room.phase !== 'over')
      .map((room) => room.summary())
      .sort((a, b) => a.code.localeCompare(b.code))
  }

  cleanup() {
    const now = Date.now()
    for (const [token, record] of this.resumeIndex) {
      if (record.expiresAt < now) this.resumeIndex.delete(token)
    }
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivity > ROOM_TTL_MS) this.dropRoom(room)
      else room.expireDisconnected(now)
    }
  }

  newCode() {
    for (;;) {
      const bytes = crypto.randomBytes(ROOM_CODE_LENGTH)
      let code = ''
      for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]
      if (!this.rooms.has(code)) return code
    }
  }

  send(session, message) {
    this.sendSerialized(session, JSON.stringify(message))
  }

  sendSerialized(session, serialized) {
    try {
      if (session?.socket?.readyState === 1) session.socket.send(serialized)
    } catch {
      // A close can race with a broadcast. The close handler owns cleanup.
    }
  }

  sendError(session, code, message) {
    this.send(session, { t: 'error', code, message })
  }
}

class OnlineRoom {
  constructor(manager, options) {
    this.manager = manager
    this.code = options.code
    this.name = options.name
    this.packageId = options.packageId
    this.deckName = options.deckName
    this.cards = options.cards
    this.catalogCards = options.catalogCards || options.cards
    this.cardByKey = new Map(this.cards.map((card) => [card.key, card]))
    this.cardViews = this.cards.map(({ key, number, imageName, workName }) => ({
      key,
      number,
      imageName,
      workName,
      imageUrl: `/api/packages/${encodeURIComponent(this.packageId)}/card-image?cardKey=${encodeURIComponent(key)}`,
    }))
    this.seats = { A: null, B: null }
    this.spectators = new Set()
    this.phase = 'lobby'
    this.roundNo = 0
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.scores = EMPTY_SCORES()
    this.matchWinner = null
    this.current = null
    this.roundTimer = null
    this.nextRoundTimer = null
    this.arrangeTimer = null
    this.arrangeEndsAt = null
    this.emptySongs = []
    this.emptyRemainingSongs = []
    this.restSongs = []
    this.restRemainingSongs = []
    this.arrangeReadyStartAt = null
    this.restReadyStartAt = null
    this.pendingTransfer = null
    this.lastActivity = Date.now()
    this.viewVersion = 0
    this.viewCache = new Map()
    this.disposed = false
  }

  get playerCount() {
    return ['A', 'B'].filter((playerId) => this.seats[playerId]).length
  }

  addSpectator(session) {
    this.spectators.add(session)
    this.touch()
  }

  canAddSpectator() {
    return this.spectators.size < MAX_SPECTATORS
  }

  removeSpectator(session) {
    this.spectators.delete(session)
    if (session.room === this) session.room = null
    session.spectator = false
  }

  summary() {
    const status =
      this.phase === 'lobby'
        ? this.playerCount >= 2
          ? 'full'
          : 'waiting'
        : ['draft_select', 'draft_ban'].includes(this.phase)
          ? 'preparing'
          : 'playing'
    return {
      code: this.code,
      name: this.name,
      deckName: this.deckName,
      players: this.playerCount,
      status,
    }
  }

  setReady(session, ready) {
    const playerId = this.playerIdFor(session)
    if (!playerId) return
    if (this.phase === 'arrange') {
      this.setArrangeReady(playerId, ready)
      return
    }
    if (this.phase === 'playing') {
      this.setRestReady(playerId, ready)
      return
    }
    if (this.phase !== 'lobby') return
    const fairness = this.fairnessView()
    if (ready && !fairness.canStart) {
      this.manager.sendError(
        session,
        fairness.status === 'unfair' ? 'network_unfair' : 'network_measuring',
        fairness.message,
      )
      this.sendRoom()
      return
    }
    this.seats[playerId].ready = ready
    this.touch()
    if (this.seats.A?.ready && this.seats.B?.ready) {
      if (this.fairnessView().canStart && this.seats.A.socket && this.seats.B.socket) this.beginDraft()
      else {
        this.seats.A.ready = false
        this.seats.B.ready = false
        this.sendRoom()
      }
      return
    }
    this.sendRoom()
  }

  setArrangeReady(playerId, ready) {
    if (this.phase !== 'arrange' || !this.arrangeEndsAt || Date.now() >= this.arrangeEndsAt) return
    const seat = this.seats[playerId]
    if (!seat) return
    seat.arrangeReady = ready
    if (!ready && this.arrangeReadyStartAt) {
      this.arrangeReadyStartAt = null
      this.scheduleArrangeStart(Math.max(0, this.arrangeEndsAt - Date.now()))
    }
    if (this.seats.A?.arrangeReady && this.seats.B?.arrangeReady && !this.arrangeReadyStartAt) {
      this.arrangeReadyStartAt = Date.now() + 20_000
      this.scheduleArrangeStart(20_000)
    }
    this.touch()
    this.sendRoom()
  }

  setRestReady(playerId, ready) {
    const current = this.current
    if (!current?.resolved || !current.restEndsAtServerTime || Date.now() >= current.restEndsAtServerTime || this.pendingTransfer) return
    const seat = this.seats[playerId]
    if (!seat) return
    seat.restReady = ready
    if (!ready && this.restReadyStartAt) {
      this.restReadyStartAt = null
      this.scheduleNextRound(Math.max(0, current.restEndsAtServerTime - Date.now()))
    }
    if (this.seats.A?.restReady && this.seats.B?.restReady && !this.restReadyStartAt) {
      this.restReadyStartAt = Date.now() + 5_000
      this.scheduleNextRound(5_000)
    }
    this.touch()
    this.sendRoom()
  }

  beginDraft() {
    if (this.phase !== 'lobby' || !this.fairnessView().canStart) return
    const keys = shuffle(this.cards.map((card) => card.key))
    const midpoint = Math.floor(keys.length / 2)
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (!seat) continue
      seat.ready = false
      seat.arrangeReady = false
      seat.restReady = false
      seat.score = 0
      seat.correctClaims = 0
      seat.poolCardKeys = playerId === 'A' ? keys.slice(0, midpoint) : keys.slice(midpoint)
      seat.selectedCardKeys = []
      seat.exchangeCardKeys = []
      seat.bannedCardKeys = []
      seat.handCardKeys = []
      seat.layoutCardKeys = []
    }
    this.phase = 'draft_select'
    this.roundNo = 0
    this.remaining = new Set()
    this.scores = EMPTY_SCORES()
    this.matchWinner = null
    this.current = null
    this.pendingTransfer = null
    this.arrangeEndsAt = null
    this.emptySongs = []
    this.emptyRemainingSongs = []
    this.restSongs = []
    this.restRemainingSongs = []
    this.arrangeReadyStartAt = null
    this.restReadyStartAt = null
    this.touch()
    this.manager.broadcastRoomList()
    this.sendRoom()
  }

  selectCards(session, message) {
    const playerId = this.playerIdFor(session)
    if (!playerId || this.phase !== 'draft_select') return
    const seat = this.seats[playerId]
    const cardKeys = Array.isArray(message.cardKeys) ? [...new Set(message.cardKeys.filter((key) => typeof key === 'string'))] : []
    const pool = new Set(seat.poolCardKeys)
    if (cardKeys.length !== DRAFT_SELECTION_SIZE || cardKeys.some((key) => !pool.has(key))) {
      this.manager.sendError(session, 'bad_selection', `请选择自己牌池中的 ${DRAFT_SELECTION_SIZE} 张牌`)
      return
    }
    seat.selectedCardKeys = cardKeys
    this.touch()
    if (this.seats.A?.selectedCardKeys.length === DRAFT_SELECTION_SIZE && this.seats.B?.selectedCardKeys.length === DRAFT_SELECTION_SIZE) {
      this.beginBan()
    } else {
      this.sendRoom()
    }
  }

  beginBan() {
    this.phase = 'draft_ban'
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      const opponent = this.seats[otherPlayer(playerId)]
      if (!seat || !opponent) continue
      seat.exchangeCardKeys = shuffle(opponent.selectedCardKeys)
      seat.bannedCardKeys = []
    }
    this.touch()
    this.sendRoom()
  }

  banCards(session, message) {
    const playerId = this.playerIdFor(session)
    if (!playerId || this.phase !== 'draft_ban') return
    const seat = this.seats[playerId]
    const cardKeys = Array.isArray(message.cardKeys) ? [...new Set(message.cardKeys.filter((key) => typeof key === 'string'))] : []
    const exchange = new Set(seat.exchangeCardKeys)
    if (cardKeys.length !== BAN_SIZE || cardKeys.some((key) => !exchange.has(key))) {
      this.manager.sendError(session, 'bad_ban', `请选择收到的 ${BAN_SIZE} 张牌进行 BAN`)
      return
    }
    seat.bannedCardKeys = cardKeys
    this.touch()
    if (this.seats.A?.bannedCardKeys.length === BAN_SIZE && this.seats.B?.bannedCardKeys.length === BAN_SIZE) {
      this.finalizeHands()
    } else {
      this.sendRoom()
    }
  }

  finalizeHands() {
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (!seat) return
      const banned = new Set(seat.bannedCardKeys)
      seat.handCardKeys = shuffle(seat.exchangeCardKeys.filter((key) => !banned.has(key)))
      if (seat.handCardKeys.length !== HAND_SIZE) return
    }
    this.remaining = new Set([...this.seats.A.handCardKeys, ...this.seats.B.handCardKeys])
    this.emptySongs = buildEmptySongPool(this.catalogCards, this.remaining)
    this.emptyRemainingSongs = [...this.emptySongs]
    this.restSongs = buildRestSongPool(this.catalogCards, this.remaining, this.emptySongs)
    this.restRemainingSongs = shuffle(this.restSongs)
    this.phase = 'arrange'
    this.arrangeEndsAt = Date.now() + ARRANGE_WINDOW_MS
    this.arrangeReadyStartAt = null
    for (const playerId of ['A', 'B']) {
      if (this.seats[playerId]) this.seats[playerId].arrangeReady = false
    }
    this.touch()
    this.manager.broadcastRoomList()
    this.sendRoom()
    this.scheduleArrangeStart(ARRANGE_WINDOW_MS)
  }

  arrangeLayout(session, message) {
    const playerId = this.playerIdFor(session)
    if (!playerId || this.phase !== 'playing') return
    const seat = this.seats[playerId]
    const cardKeys = Array.isArray(message.cardKeys) ? message.cardKeys : []
    const hand = new Set(seat.handCardKeys)
    const placed = cardKeys.filter((key) => typeof key === 'string')
    if (
      cardKeys.length !== MAX_HAND_SLOTS ||
      placed.length !== hand.size ||
      new Set(placed).size !== placed.length ||
      placed.some((key) => !hand.has(key))
    ) {
      return
    }
    seat.layoutCardKeys = [...cardKeys]
    this.touch()
    this.sendRoom()
  }

  scheduleArrangeStart(delay) {
    if (this.arrangeTimer) clearTimeout(this.arrangeTimer)
    this.arrangeTimer = setTimeout(() => {
      this.arrangeTimer = null
      this.startPlaying()
    }, delay)
  }

  startPlaying() {
    if (this.disposed || this.phase !== 'arrange') return
    if (this.arrangeTimer) clearTimeout(this.arrangeTimer)
    this.arrangeTimer = null
    this.phase = 'playing'
    this.arrangeEndsAt = null
    this.arrangeReadyStartAt = null
    for (const playerId of ['A', 'B']) {
      if (this.seats[playerId]) this.seats[playerId].arrangeReady = false
    }
    this.touch()
    this.manager.broadcastRoomList()
    this.sendRoom()
    this.scheduleNextRound(600)
  }

  scheduleNextRound(delay) {
    if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer)
    this.nextRoundTimer = setTimeout(() => {
      this.nextRoundTimer = null
      this.nextRound()
    }, delay)
  }

  nextRound() {
    if (this.disposed || this.phase !== 'playing') return
    if (!this.remaining.size) {
      this.endMatch()
      return
    }
    const realChoices = [...this.remaining]
      .map((cardKey) => {
        const card = this.cardByKey.get(cardKey)
        if (!card?.songs.length) return null
        return {
          isEmpty: false,
          cardKey,
          song: card.songs[Math.floor(Math.random() * card.songs.length)],
        }
      })
      .filter(Boolean)
    const emptyChoices = this.emptyRemainingSongs.map((song, index) => ({
      isEmpty: true,
      cardKey: '',
      song,
      index,
    }))
    const choices = [...realChoices, ...emptyChoices]
    if (!choices.length) {
      this.endMatch()
      return
    }
    this.restReadyStartAt = null
    for (const playerId of ['A', 'B']) {
      if (this.seats[playerId]) this.seats[playerId].restReady = false
    }
    const choice = choices[Math.floor(Math.random() * choices.length)]
    if (choice.isEmpty) this.emptyRemainingSongs.splice(choice.index, 1)
    const token = crypto.randomBytes(20).toString('base64url')
    const startAt = Date.now() + ROUND_LEAD_MS
    this.roundNo += 1
    this.current = {
      roundNo: this.roundNo,
      cardKey: choice.cardKey,
      isEmpty: choice.isEmpty,
      song: choice.song,
      token,
      startAt,
      endsAt: startAt + ROUND_WINDOW_MS,
      claims: new Map(),
      lastClaim: null,
      resultMessage: null,
      resolved: false,
      transferTimer: null,
      restEndsAtServerTime: null,
      restReason: null,
      restToken: null,
      restSong: null,
      restAudioUrl: null,
      restExpiresAt: null,
      expiresAt: startAt + ROUND_WINDOW_MS + REST_WINDOW_MS + 10_000,
    }
    logOnlineEvent('round.started', {
      room: this.code,
      roundNo: this.roundNo,
      isEmpty: choice.isEmpty,
      cardKey: choice.cardKey || undefined,
      song: choice.song.displayName,
    })
    this.touch()
    this.broadcast({
      t: 'roundStart',
      roundNo: this.roundNo,
      startAtServerTime: startAt,
      windowMs: ROUND_WINDOW_MS,
      audioUrl: `/api/online/room/${this.code}/audio/${token}`,
    })
    this.sendRoom()
    this.roundTimer = setTimeout(
      () => this.resolveRound(null, 'timeout'),
      ROUND_LEAD_MS + ROUND_WINDOW_MS + CLAIM_COMPENSATION_CAP_MS,
    )
  }

  claim(session, message) {
    const playerId = this.playerIdFor(session)
    const current = this.current
    if (!playerId || this.phase !== 'playing' || !current || current.resolved) return
    if (message.roundNo !== current.roundNo || current.claims.has(playerId) || this.pendingTransfer) return
    const cardKey = typeof message.cardKey === 'string' ? message.cardKey : ''
    if (cardKey && (!this.cardByKey.has(cardKey) || !this.isCardOnBoard(cardKey))) return
    const receivedAt = Date.now()
    const rttMs = session.network?.rttMs
    const compensationMs = Number.isFinite(rttMs)
      ? Math.min(CLAIM_COMPENSATION_CAP_MS, Math.max(0, rttMs / 2))
      : 0
    const adjustedAt = receivedAt - compensationMs
    if (adjustedAt < current.startAt || adjustedAt > current.endsAt) return
    const correct = !current.isEmpty && cardKey === current.cardKey
    this.touch()
    logOnlineEvent('claim.received', {
      room: this.code,
      roundNo: current.roundNo,
      playerId,
      correct,
      isEmpty: current.isEmpty,
      cardKey: cardKey || undefined,
      rttMs: session.network?.rttMs,
      compensationMs,
    })
    if (correct) {
      current.claims.set(playerId, { cardKey, correct, receivedAt, adjustedAt, compensationMs })
      current.lastClaim = { t: 'claimFeedback', playerId, cardKey, correct }
      this.broadcast(current.lastClaim)
      this.scheduleClaimSettlement()
      return
    }
    if (this.roundTimer) clearTimeout(this.roundTimer)
    this.roundTimer = null
    if (current.settlementTimer) clearTimeout(current.settlementTimer)
    current.settlementTimer = null
    current.claims.clear()
    const to = otherPlayer(playerId)
    this.scores[to] += 1
    const opponentSeat = this.seats[to]
    if (opponentSeat) opponentSeat.score = this.scores[to]
    this.pendingTransfer = {
      from: playerId,
      to,
      reason: 'wrong_claim',
      cardKey: null,
      expiresAtServerTime: Date.now() + WRONG_TRANSFER_TIMEOUT_MS,
    }
    current.restEndsAtServerTime = Date.now() + REST_WINDOW_MS
    current.restReason = 'wrong_claim'
    this.prepareRestAudio(current)
    current.lastClaim = { t: 'claimFeedback', playerId, cardKey, correct, penalty: true, transferTo: to }
    this.broadcast(current.lastClaim)
    this.scheduleTransferFallback(current)
    this.sendRoom()
  }

  isCardOnBoard(cardKey) {
    return ['A', 'B'].some((playerId) => this.seats[playerId]?.handCardKeys.includes(cardKey))
  }

  ownerOfCard(cardKey) {
    return ['A', 'B'].find((playerId) => this.seats[playerId]?.handCardKeys.includes(cardKey)) || null
  }

  emptyHandWinner() {
    const emptyPlayers = ['A', 'B'].filter((playerId) => this.seats[playerId]?.handCardKeys.length === 0)
    return emptyPlayers.length === 1 ? emptyPlayers[0] : null
  }

  finishIfHandEmpty() {
    const winner = this.emptyHandWinner()
    if (!winner) return false
    this.endMatch(winner)
    return true
  }

  scheduleTransferFallback(current, delay = WRONG_TRANSFER_TIMEOUT_MS) {
    if (current.transferTimer) clearTimeout(current.transferTimer)
    current.transferTimer = setTimeout(() => {
      current.transferTimer = null
      if (this.current !== current || !this.pendingTransfer) return
      const pending = this.pendingTransfer
      const giver = this.seats[pending.to]
      const recipient = this.seats[pending.from]
      const cardKey = giver?.handCardKeys[Math.floor(Math.random() * (giver.handCardKeys.length || 1))]
      if (cardKey && recipient && recipient.handCardKeys.length < MAX_HAND_SLOTS) {
        this.transferCard(pending.to, cardKey, true)
        return
      }
      this.pendingTransfer = null
      this.touch()
      this.sendRoom()
      if (pending.reason === 'wrong_claim') this.resolveRound(null, 'wrong', false)
      else if (pending.reason === 'opponent_card') {
        if (this.finishIfHandEmpty()) return
        if (!this.remaining.size) this.endMatch()
        else this.scheduleNextRound(Math.max(0, current.restEndsAtServerTime - Date.now()))
      }
    }, Math.max(0, delay))
  }

  giveCard(session, message) {
    const playerId = this.playerIdFor(session)
    const pending = this.pendingTransfer
    if (!playerId || this.phase !== 'playing' || !pending || pending.to !== playerId) return
    const cardKey = typeof message.cardKey === 'string' ? message.cardKey : ''
    this.transferCard(playerId, cardKey, false)
  }

  transferCard(giverId, cardKey, automatic) {
    const pending = this.pendingTransfer
    const giver = this.seats[giverId]
    const recipient = pending ? this.seats[pending.from] : null
    if (!pending || !giver || !recipient || pending.to !== giverId) return false
    if (recipient.handCardKeys.length >= MAX_HAND_SLOTS) {
      if (!automatic && giver.socket) this.manager.sendError(giver.socket, 'hand_full', '对方牌区已满，暂时无法转牌')
      return false
    }
    const index = giver.handCardKeys.indexOf(cardKey)
    if (index < 0) {
      if (!automatic && giver.socket) this.manager.sendError(giver.socket, 'bad_transfer', '请选择自己牌区中的一张牌')
      return false
    }
    giver.handCardKeys.splice(index, 1)
    recipient.handCardKeys.push(cardKey)
    if (giver.layoutCardKeys.length === MAX_HAND_SLOTS) {
      giver.layoutCardKeys = giver.layoutCardKeys.map((key) => (key === cardKey ? null : key))
    }
    if (recipient.layoutCardKeys.length === MAX_HAND_SLOTS) {
      const nextLayout = [...recipient.layoutCardKeys]
      const emptySlot = nextLayout.indexOf(null)
      if (emptySlot >= 0) nextLayout[emptySlot] = cardKey
      recipient.layoutCardKeys = nextLayout
    }
    this.pendingTransfer = null
    if (this.current?.transferTimer) clearTimeout(this.current.transferTimer)
    if (this.current) this.current.transferTimer = null
    this.touch()
    this.broadcast({ t: 'cardTransfer', from: giverId, to: pending.from, cardKey, automatic })
    this.sendRoom()
    if (pending.reason === 'wrong_claim') this.resolveRound(null, 'wrong', false)
    else if (pending.reason === 'opponent_card') {
      if (this.finishIfHandEmpty()) return true
      if (!this.remaining.size) this.endMatch()
      else this.scheduleNextRound(Math.max(0, this.current?.restEndsAtServerTime - Date.now()))
    }
    return true
  }

  scheduleClaimSettlement() {
    const current = this.current
    if (!current || current.resolved || current.settlementTimer) return
    if (this.roundTimer) clearTimeout(this.roundTimer)
    this.roundTimer = null
    current.settlementTimer = setTimeout(() => {
      current.settlementTimer = null
      this.resolveRound(this.bestClaim(current), 'claimed')
    }, CLAIM_SETTLE_DELAY_MS)
  }

  bestClaim(current) {
    return (
      [...current.claims.entries()]
        .filter(([, claim]) => claim.correct)
        .sort(
          ([leftPlayer, left], [rightPlayer, right]) =>
            left.adjustedAt - right.adjustedAt ||
            left.receivedAt - right.receivedAt ||
            leftPlayer.localeCompare(rightPlayer),
        )[0]?.[0] || null
    )
  }

  resolveRound(winner, reason, removeCard = true) {
    const current = this.current
    if (!current || this.phase !== 'playing') return
    if (this.roundTimer) clearTimeout(this.roundTimer)
    if (current.settlementTimer) clearTimeout(current.settlementTimer)
    if (current.transferTimer) clearTimeout(current.transferTimer)
    this.roundTimer = null
    current.settlementTimer = null
    current.transferTimer = null
    this.pendingTransfer = null
    current.resolved = true
    this.restReadyStartAt = null
    for (const playerId of ['A', 'B']) {
      if (this.seats[playerId]) this.seats[playerId].restReady = false
    }
    this.current = current
    const targetOwner = !current.isEmpty && current.cardKey ? this.ownerOfCard(current.cardKey) : null
    if (removeCard && !current.isEmpty && current.cardKey) {
      this.remaining.delete(current.cardKey)
      for (const playerId of ['A', 'B']) {
        const seat = this.seats[playerId]
        const index = seat?.handCardKeys.indexOf(current.cardKey) ?? -1
        if (index >= 0) {
          seat.handCardKeys.splice(index, 1)
          if (seat.layoutCardKeys.length === MAX_HAND_SLOTS) {
            seat.layoutCardKeys = seat.layoutCardKeys.map((key) => (key === current.cardKey ? null : key))
          }
        }
      }
    }
    if (winner) {
      this.scores[winner] += 1
      const seat = this.seats[winner]
      if (seat) {
        seat.score = this.scores[winner]
        seat.correctClaims += 1
      }
    }
    current.restEndsAtServerTime = current.restEndsAtServerTime || Date.now() + REST_WINDOW_MS
    current.restReason = current.restReason || (current.isEmpty ? 'empty' : 'round')
    this.prepareRestAudio(current)
    if (winner && !current.isEmpty && removeCard && targetOwner && targetOwner !== winner) {
      this.pendingTransfer = {
        from: targetOwner,
        to: winner,
        reason: 'opponent_card',
        cardKey: current.cardKey,
        expiresAtServerTime: current.restEndsAtServerTime,
      }
      current.restReason = 'opponent_card'
    }
    const emptyHandWinner = this.pendingTransfer ? null : this.emptyHandWinner()
    const nextAt = emptyHandWinner || !this.remaining.size ? null : current.restEndsAtServerTime
    this.touch()
    const resultMessage = {
      t: 'roundResult',
      roundNo: current.roundNo,
      cardKey: current.cardKey,
      winner,
      reason,
      song: { displayName: current.song.displayName, fileName: current.song.fileName },
      scores: { ...this.scores },
      remainingCardKeys: [...this.remaining],
      nextRoundAtServerTime: nextAt,
    }
    current.resultMessage = resultMessage
    logOnlineEvent('round.resolved', {
      room: this.code,
      roundNo: current.roundNo,
      reason,
      winner,
      isEmpty: current.isEmpty,
      remainingCards: this.remaining.size,
      pendingTransfer: Boolean(this.pendingTransfer),
    })
    this.broadcast(resultMessage)
    this.sendRoom()
    if (emptyHandWinner) {
      this.endMatch(emptyHandWinner)
      return
    }
    const nextDelay = this.remaining.size ? Math.max(0, current.restEndsAtServerTime - Date.now()) : 0
    if (!this.pendingTransfer) this.scheduleNextRound(nextDelay)
  }

  endMatch(winner = null) {
    if (this.phase === 'over') return
    this.clearTimers()
    this.phase = 'over'
    this.current = null
    const emptyHandWinner = this.emptyHandWinner()
    const matchWinner = winner || emptyHandWinner
    this.matchWinner = matchWinner
    this.touch()
    this.manager.broadcastRoomList()
    this.broadcast({ t: 'matchOver', winner: matchWinner, scores: { ...this.scores }, rounds: this.roundNo })
    this.sendRoom()
  }

  leave(playerId) {
    const seat = this.seats[playerId]
    if (!seat) return
    const nickname = seat.nickname
    this.clearTimers()
    this.seats[playerId] = null
    this.resetMatch()
    this.touch()
    const other = playerId === 'A' ? 'B' : 'A'
    if (this.seats[other]?.socket) {
      this.manager.send(this.seats[other].socket, { t: 'peer', playerId, connected: false })
      this.sendRoom()
      this.manager.send(this.seats[other].socket, { t: 'error', code: 'peer_left', message: `${nickname} 已离开房间` })
    }
    if (!this.seats.A && !this.seats.B) this.manager.dropRoom(this)
  }

  disconnect(playerId) {
    const seat = this.seats[playerId]
    if (!seat || !seat.socket) return
    seat.socket = null
    seat.disconnectedAt = Date.now()
    logOnlineEvent('player.disconnected', {
      room: this.code,
      playerId,
      phase: this.phase,
      roundNo: this.current?.roundNo,
      resumeTtlMs: RESUME_TTL_MS,
    })
    if (this.phase === 'arrange') {
      seat.arrangeReady = false
      if (this.arrangeReadyStartAt) {
        this.arrangeReadyStartAt = null
        this.scheduleArrangeStart(Math.max(0, (this.arrangeEndsAt || Date.now()) - Date.now()))
      }
    }
    if (this.phase === 'playing') {
      seat.restReady = false
      if (this.restReadyStartAt && this.current?.restEndsAtServerTime) {
        this.restReadyStartAt = null
        this.scheduleNextRound(Math.max(0, this.current.restEndsAtServerTime - Date.now()))
      }
    }
    this.touch()
    this.broadcastPeer(playerId, false)
    this.networkChanged()
  }

  expireDisconnected(now) {
    let changed = false
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat?.disconnectedAt && now - seat.disconnectedAt > RESUME_TTL_MS) {
        logOnlineEvent('resume.expired', {
          room: this.code,
          playerId,
          phase: this.phase,
        })
        this.manager.resumeIndex.delete(seat.resumeToken)
        this.seats[playerId] = null
        this.resetMatch()
        changed = true
      }
    }
    if (!this.seats.A && !this.seats.B) this.manager.dropRoom(this)
    // Countdown timestamps are already part of the last snapshot; only an
    // actual resume expiry changes room state and needs a full fan-out.
    else if (changed) {
      this.touch()
      this.sendRoom()
      this.manager.broadcastRoomList()
    }
  }

  resetMatch() {
    this.clearTimers()
    this.phase = 'lobby'
    this.current = null
    this.roundNo = 0
    this.arrangeEndsAt = null
    this.emptySongs = []
    this.emptyRemainingSongs = []
    this.restSongs = []
    this.restRemainingSongs = []
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.restReadyStartAt = null
    this.arrangeReadyStartAt = null
    this.scores = EMPTY_SCORES()
    this.matchWinner = null
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat) {
        seat.ready = false
        seat.arrangeReady = false
        seat.restReady = false
        seat.score = 0
        seat.correctClaims = 0
        seat.poolCardKeys = []
        seat.selectedCardKeys = []
        seat.exchangeCardKeys = []
        seat.bannedCardKeys = []
        seat.handCardKeys = []
        seat.layoutCardKeys = []
      }
    }
  }

  prepareRestAudio(current) {
    if (current.restToken || !current.restEndsAtServerTime) return
    const restSong = this.takeRestSong()
    if (!restSong) return
    current.restSong = restSong
    current.restToken = crypto.randomBytes(20).toString('base64url')
    current.restAudioUrl = `/api/online/room/${this.code}/audio/${current.restToken}`
    current.restExpiresAt = current.restEndsAtServerTime + REST_AUDIO_GRACE_MS
  }

  takeRestSong() {
    if (!this.restRemainingSongs.length && this.restSongs.length) this.restRemainingSongs = shuffle(this.restSongs)
    return this.restRemainingSongs.shift() || null
  }

  assetForToken(token) {
    const current = this.current
    if (!current) return null
    const asset =
      current.token === token
        ? { song: current.song, expiresAt: current.expiresAt }
        : current.restToken === token
          ? { song: current.restSong, expiresAt: current.restExpiresAt }
          : null
    if (!asset?.song || !asset.expiresAt || asset.expiresAt < Date.now()) return null
    return {
      packageId: this.packageId,
      sourcePath: asset.song.sourcePath,
      fileName: asset.song.fileName,
      expiresAt: asset.expiresAt,
    }
  }

  sendRoom() {
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (!seat?.socket) continue
      this.manager.sendSerialized(seat.socket, this.serializedRoomView(playerId))
    }
    for (const spectator of this.spectators) this.sendSpectator(spectator)
  }

  sendSpectator(session) {
    if (!this.spectators.has(session)) return
    this.manager.sendSerialized(session, this.serializedRoomView(null, true))
  }

  sendSpectatorState(session) {
    if (!this.spectators.has(session)) return
    this.sendSpectator(session)
    this.sendCurrentState(session)
  }

  sendCurrentState(session) {
    const current = this.current
    if (!current) return

    // Replay only the small set of public events that defines the visible
    // state of the current round. This lets a late spectator reconstruct the
    // active claim markers or the just-finished settlement without exposing
    // the hidden song/card identity.
    for (const [playerId, claim] of current.claims) {
      this.manager.send(session, { t: 'claimFeedback', playerId, cardKey: claim.cardKey, correct: true })
    }
    if (!current.resolved && current.lastClaim && !current.lastClaim.correct) {
      this.manager.send(session, current.lastClaim)
    }
    if (current.resolved && current.resultMessage) {
      this.manager.send(session, current.resultMessage)
      return
    }
    if (current.resolved || this.pendingTransfer || Date.now() >= current.endsAt) return
    this.manager.send(session, {
      t: 'roundStart',
      roundNo: current.roundNo,
      startAtServerTime: current.startAt,
      windowMs: ROUND_WINDOW_MS,
      audioUrl: `/api/online/room/${this.code}/audio/${current.token}`,
    })
  }

  networkChanged(forceRoom = false) {
    const fairness = this.fairnessView()
    let changed = false
    if (this.phase === 'lobby' && !fairness.canStart) {
      for (const playerId of ['A', 'B']) {
        const seat = this.seats[playerId]
        if (seat?.ready) {
          seat.ready = false
          changed = true
        }
      }
    }
    if (changed || forceRoom) {
      if (changed) this.touch()
      this.sendRoom()
      return
    }
    this.sendNetwork(fairness)
  }

  sendNetwork(fairness = this.fairnessView()) {
    const message = {
      t: 'network',
      players: {
        A: this.networkView('A'),
        B: this.networkView('B'),
      },
      fairness,
    }
    const serialized = JSON.stringify(message)
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (!seat?.socket) continue
      this.manager.sendSerialized(seat.socket, serialized)
    }
    for (const spectator of this.spectators) this.manager.sendSerialized(spectator, serialized)
  }

  broadcastPeer(playerId, connected) {
    this.broadcast({ t: 'peer', playerId, connected })
  }

  broadcast(message) {
    const serialized = JSON.stringify(message)
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat?.socket) this.manager.sendSerialized(seat.socket, serialized)
    }
    for (const spectator of this.spectators) this.manager.sendSerialized(spectator, serialized)
  }

  serializedRoomView(playerId, spectator = false) {
    // A room update has one view per privacy role. Reuse the encoded payload
    // for all spectators and avoid rebuilding it for idle sends.
    const cacheKey = spectator ? 'spectator' : playerId
    const cached = this.viewCache.get(cacheKey)
    if (cached?.version === this.viewVersion) return cached.serialized
    const serialized = JSON.stringify({ t: 'room', room: this.view(playerId, spectator) })
    this.viewCache.set(cacheKey, { version: this.viewVersion, serialized })
    return serialized
  }

  view(you, spectator = false) {
    return {
      code: this.code,
      name: this.name,
      packageId: this.packageId,
      deckName: this.deckName,
      you,
      spectator,
      phase: this.phase,
      players: {
        A: this.playerView('A', spectator ? null : you, spectator),
        B: this.playerView('B', spectator ? null : you, spectator),
      },
      cards: this.cardViews,
      remainingCardKeys: [...this.remaining],
      restEndsAtServerTime: this.current?.restEndsAtServerTime || null,
      restAudioUrl: this.current?.restAudioUrl || null,
      arrangeReadyStartAtServerTime: this.arrangeReadyStartAt,
      restReadyStartAtServerTime: this.restReadyStartAt,
      roundNo: this.roundNo,
      matchWinner: this.matchWinner,
      fairness: this.fairnessView(),
      draft: this.draftView(you, spectator),
      pendingTransfer: this.pendingTransfer,
    }
  }

  playerView(playerId, viewerId, spectator = false) {
    const seat = this.seats[playerId]
    if (!seat) return null
    return {
      id: playerId,
      nickname: seat.nickname,
      connected: Boolean(seat.socket),
      ready: seat.ready,
      arrangeReady: seat.arrangeReady,
      restReady: seat.restReady,
      score: seat.score,
      correctClaims: seat.correctClaims,
      network: this.networkView(playerId),
      selectedCount: seat.selectedCardKeys.length,
      bannedCount: seat.bannedCardKeys.length,
      // A local layout is private to its owner. Do not expose the owner's
      // order in the opponent's room view.
      handCardKeys: spectator || playerId === viewerId ? [...seat.handCardKeys] : [...seat.handCardKeys].sort(),
      layoutCardKeys:
        spectator || (playerId !== viewerId && this.phase === 'playing')
          ? effectiveLayout(seat.layoutCardKeys, seat.handCardKeys)
          : null,
    }
  }

  draftView(playerId, spectator = false) {
    const ownPlayerId = playerId === 'A' || playerId === 'B' ? playerId : null
    const seat = ownPlayerId ? this.seats[ownPlayerId] : null
    const opponent = ownPlayerId ? this.seats[otherPlayer(ownPlayerId)] : this.seats.B
    const phase =
      this.phase === 'draft_select'
        ? 'select'
        : this.phase === 'draft_ban'
          ? 'ban'
          : this.phase === 'arrange'
            ? 'arrange'
            : 'waiting'
    return {
      phase,
      poolCardKeys: !spectator && this.phase === 'draft_select' ? [...(seat?.poolCardKeys || [])] : [],
      selectedCardKeys: !spectator ? [...(seat?.selectedCardKeys || [])] : [],
      exchangeCardKeys: !spectator && this.phase === 'draft_ban' ? [...(seat?.exchangeCardKeys || [])] : [],
      bannedCardKeys: !spectator ? [...(seat?.bannedCardKeys || [])] : [],
      selectionSize: DRAFT_SELECTION_SIZE,
      banSize: BAN_SIZE,
      selectedCount: spectator ? this.seats.A?.selectedCardKeys.length || 0 : seat?.selectedCardKeys.length || 0,
      bannedCount: spectator ? this.seats.A?.bannedCardKeys.length || 0 : seat?.bannedCardKeys.length || 0,
      opponentSelectedCount: spectator ? this.seats.B?.selectedCardKeys.length || 0 : opponent?.selectedCardKeys.length || 0,
      opponentBannedCount: spectator ? this.seats.B?.bannedCardKeys.length || 0 : opponent?.bannedCardKeys.length || 0,
      arrangeEndsAtServerTime: this.phase === 'arrange' ? this.arrangeEndsAt : null,
    }
  }

  networkView(playerId) {
    const samples = this.seats[playerId]?.socket?.network?.samples || []
    return networkMetrics(samples)
  }

  fairnessView() {
    const left = this.networkView('A')
    const right = this.networkView('B')
    const samplesReady = left.samples >= NETWORK_MIN_SAMPLES && right.samples >= NETWORK_MIN_SAMPLES
    const rttGapMs = left.rttMs === null || right.rttMs === null ? null : roundMetric(Math.abs(left.rttMs - right.rttMs))
    const jitterGapMs =
      left.jitterMs === null || right.jitterMs === null
        ? null
        : roundMetric(Math.abs(left.jitterMs - right.jitterMs))
    const maxJitterMs =
      left.jitterMs === null || right.jitterMs === null ? null : Math.max(left.jitterMs, right.jitterMs)

    if (!samplesReady) {
      return {
        status: 'measuring',
        canStart: false,
        rttGapMs,
        jitterGapMs,
        maxJitterMs,
        message: `正在测量双方网络（A ${left.samples}/${NETWORK_MIN_SAMPLES}、B ${right.samples}/${NETWORK_MIN_SAMPLES} 次 Ping/Pong）`,
      }
    }

    const unfairRtt = rttGapMs !== null && rttGapMs > NETWORK_MAX_RTT_GAP_MS
    const unfairJitter =
      (maxJitterMs !== null && maxJitterMs > NETWORK_MAX_JITTER_MS) ||
      (jitterGapMs !== null && jitterGapMs > NETWORK_MAX_JITTER_GAP_MS)
    if (unfairRtt || unfairJitter) {
      return {
        status: 'unfair',
        canStart: false,
        rttGapMs,
        jitterGapMs,
        maxJitterMs,
        message: `当前网络延迟差距过大，不适合公平对战（RTT 差 ${rttGapMs ?? '-'}ms；抖动差 ${jitterGapMs ?? '-'}ms；最大抖动 ${maxJitterMs ?? '-'}ms）`,
      }
    }

    return {
      status: 'ready',
      canStart: true,
      rttGapMs,
      jitterGapMs,
      maxJitterMs,
      message: '网络条件适合公平对战',
    }
  }

  playerIdFor(session) {
    if (session.room !== this || !session.playerId || !this.seats[session.playerId]) return null
    return session.playerId
  }

  clearTimers() {
    if (this.roundTimer) clearTimeout(this.roundTimer)
    if (this.nextRoundTimer) clearTimeout(this.nextRoundTimer)
    if (this.arrangeTimer) clearTimeout(this.arrangeTimer)
    if (this.current?.settlementTimer) clearTimeout(this.current.settlementTimer)
    if (this.current?.transferTimer) clearTimeout(this.current.transferTimer)
    this.roundTimer = null
    this.nextRoundTimer = null
    this.arrangeTimer = null
    if (this.current) this.current.settlementTimer = null
    if (this.current) this.current.transferTimer = null
    this.pendingTransfer = null
  }

  touch() {
    this.lastActivity = Date.now()
    this.viewVersion += 1
    this.viewCache.clear()
  }

  dispose() {
    this.disposed = true
    this.clearTimers()
    this.spectators.clear()
    this.viewCache.clear()
  }
}

function buildEmptySongPool(catalogCards, fieldCardKeys) {
  const seen = new Set()
  const candidates = []
  for (const card of catalogCards || []) {
    if (fieldCardKeys.has(card.key)) continue
    for (const song of card.songs || []) {
      const identity = songIdentity(song)
      if (seen.has(identity)) continue
      seen.add(identity)
      candidates.push({ ...song })
    }
  }
  return shuffle(candidates).slice(0, EMPTY_SONG_COUNT)
}

function buildRestSongPool(catalogCards, fieldCardKeys, emptySongs) {
  const excluded = new Set(emptySongs.map(songIdentity))
  const seen = new Set()
  const candidates = []
  for (const card of catalogCards || []) {
    if (fieldCardKeys.has(card.key)) continue
    for (const song of card.songs || []) {
      const identity = songIdentity(song)
      if (excluded.has(identity) || seen.has(identity)) continue
      seen.add(identity)
      candidates.push({ ...song })
    }
  }
  return candidates
}

function songIdentity(song) {
  return [song.sourcePath, song.fileName, song.displayName].join('\u0000')
}

function normalizeCards(input) {
  if (!Array.isArray(input) || input.length < MIN_CANDIDATE_CARDS || input.length > MAX_CARDS) {
    return { ok: false, message: `请准备 ${MIN_CANDIDATE_CARDS}-${MAX_CARDS} 张卡牌，才能随机分成两份` }
  }
  const keys = new Set()
  const cards = []
  for (const raw of input) {
    const key = sanitizeText(raw?.key, 240)
    const workName = sanitizeText(raw?.workName, 120)
    const imageName = sanitizeFileName(raw?.imageName, 255)
    const imagePath = safeRelativePath(raw?.imagePath)
    const number = Number(raw?.number)
    const songs = Array.isArray(raw?.songs)
      ? raw.songs
          .slice(0, 8)
          .map((song) => ({
            fileName: sanitizeFileName(song?.fileName, 255),
            displayName: sanitizeText(song?.displayName, 160),
            sourcePath: safeRelativePath(song?.sourcePath),
          }))
          .filter((song) => song.fileName && song.displayName)
      : []
    if (!key || keys.has(key) || !workName || !imageName || !Number.isInteger(number) || number < 1 || !songs.length) {
      return { ok: false, message: '卡牌必须有唯一标识、牌号、卡面、作品名和歌曲' }
    }
    if (songs.some((song) => !song.sourcePath && !song.fileName)) {
      return { ok: false, message: `卡牌「${workName}」的歌曲资源无效` }
    }
    if (songs.some((song) => !AUDIO_EXTENSIONS.has(path.extname(song.sourcePath || song.fileName).toLowerCase()))) {
      return { ok: false, message: 'audio_format_not_supported' }
    }
    keys.add(key)
    cards.push({ key, number, imageName, imagePath, workName, songs })
  }
  return { ok: true, value: cards }
}

function sanitizeText(value, maxLength) {
  return [...String(value || '')]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function sanitizeFileName(value, maxLength) {
  const name = sanitizeText(value, maxLength)
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return ''
  return name
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!normalized || normalized.startsWith('/') || normalized.includes('..') || normalized.includes('\u0000')) return ''
  return normalized.slice(0, 500)
}

function safePackageId(value) {
  const decoded = String(value || '')
  if (!decoded || decoded !== path.basename(decoded) || !decoded.toLowerCase().endsWith('.zip')) return ''
  return decoded
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, ROOM_CODE_LENGTH)
}
