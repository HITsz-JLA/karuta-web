import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { CURATED_PACKAGE_IDS, findCatalogCard, loadPackageCatalog } from './packageCatalog.mjs'
import { readZipAsset } from './zipAsset.mjs'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 6
const MAX_NICKNAME_LENGTH = 20
const MAX_ROOM_NAME_LENGTH = 40
const MIN_CANDIDATE_CARDS = 60
const MAX_CARDS = 500
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
const ROUND_LEAD_MS = 750
const ROOM_TTL_MS = 30 * 60 * 1000
const RESUME_TTL_MS = 90 * 1000
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
    const session = { socket, ip, room: null, playerId: null, resumeToken: null, network: emptyNetwork() }
    this.sessions.set(socket, session)
    this.send(session, { t: 'welcome', resumed: false })
    return session
  }

  recordPong(session, rttMs) {
    if (!session || !this.sessions.has(session.socket)) return
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > NETWORK_MAX_RTT_MS) return
    session.network.samples.push(roundMetric(rttMs))
    if (session.network.samples.length > NETWORK_MAX_SAMPLES) session.network.samples.shift()
    const metrics = networkMetrics(session.network.samples)
    session.network.rttMs = metrics.rttMs
    session.network.jitterMs = metrics.jitterMs
    if (session.room) session.room.networkChanged()
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
    if (!room || !session.playerId) return
    room.disconnect(session.playerId)
  }

  async getAudio(roomCode, token) {
    const room = this.rooms.get(normalizeCode(roomCode))
    const asset = room?.assetForToken(token)
    if (!asset) return null
    try {
      await fs.access(path.join(this.dataDir, asset.packageId))
    } catch {
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
    if (typeof resumeToken !== 'string' || !resumeToken) return
    const record = this.resumeIndex.get(resumeToken)
    if (!record || record.expiresAt < Date.now()) {
      this.resumeIndex.delete(resumeToken)
      return
    }
    const seat = record.room.seats[record.playerId]
    if (!seat || seat.socket) return
    session.room = record.room
    session.playerId = record.playerId
    session.resumeToken = resumeToken
    seat.socket = session
    seat.disconnectedAt = null
    record.expiresAt = Date.now() + RESUME_TTL_MS
    this.send(session, { t: 'welcome', resumed: true, resumeToken })
    record.room.networkChanged()
    record.room.broadcastPeer(record.playerId, true)
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
      this.sendError(session, 'bad_room', '在线歌牌只能使用服务器上的四套 MUCA 牌组')
      return
    }
    const catalog = await this.getPackageCatalog(packageId)
    if (!catalog) {
      this.sendError(session, 'package_not_found', '服务器找不到该 MUCA 牌组或牌组目录无效')
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

    const roomCards = cards.value.length % 2 === 0 ? cards.value : shuffle(cards.value).slice(0, -1)
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
    this.broadcastRoomList()
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
    this.send(session, { t: 'welcome', resumed: false, resumeToken })
    room.sendRoom()
  }

  leave(session) {
    const room = session.room
    if (!room || !session.playerId) return
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
  }

  dropRoom(room) {
    if (this.rooms.get(room.code) !== room) return
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
    for (const session of this.sessions.values()) {
      if (!session.room) this.send(session, message)
    }
  }

  roomList() {
    return [...this.rooms.values()]
      .filter((room) => room.phase === 'lobby')
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
    try {
      if (session?.socket?.readyState === 1) session.socket.send(JSON.stringify(message))
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
    this.seats = { A: null, B: null }
    this.phase = 'lobby'
    this.roundNo = 0
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.scores = EMPTY_SCORES()
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
    this.disposed = false
  }

  get playerCount() {
    return ['A', 'B'].filter((playerId) => this.seats[playerId]).length
  }

  summary() {
    return {
      code: this.code,
      name: this.name,
      deckName: this.deckName,
      players: this.playerCount,
      status: this.phase === 'playing' ? 'playing' : this.playerCount >= 2 ? 'full' : 'waiting',
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
      transferTimer: null,
      restEndsAtServerTime: null,
      restReason: null,
      restToken: null,
      restSong: null,
      restAudioUrl: null,
      restExpiresAt: null,
      expiresAt: startAt + ROUND_WINDOW_MS + REST_WINDOW_MS + 10_000,
    }
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
    const correct = current.isEmpty ? Boolean(cardKey && this.isCardOnBoard(cardKey)) : cardKey === current.cardKey
    this.touch()
    if (correct) {
      current.claims.set(playerId, { cardKey, correct, receivedAt, adjustedAt, compensationMs })
      this.broadcast({ t: 'claimFeedback', playerId, cardKey, correct })
      this.scheduleClaimSettlement()
      return
    }
    if (this.roundTimer) clearTimeout(this.roundTimer)
    this.roundTimer = null
    if (current.settlementTimer) clearTimeout(current.settlementTimer)
    current.settlementTimer = null
    current.claims.clear()
    const to = otherPlayer(playerId)
    this.pendingTransfer = {
      from: playerId,
      to,
      reason: 'wrong_claim',
      expiresAtServerTime: Date.now() + WRONG_TRANSFER_TIMEOUT_MS,
    }
    current.restEndsAtServerTime = Date.now() + REST_WINDOW_MS
    current.restReason = 'wrong_claim'
    this.prepareRestAudio(current)
    this.broadcast({ t: 'claimFeedback', playerId, cardKey, correct, penalty: true, transferTo: to })
    this.scheduleTransferFallback(current)
    this.sendRoom()
  }

  isCardOnBoard(cardKey) {
    return ['A', 'B'].some((playerId) => this.seats[playerId]?.handCardKeys.includes(cardKey))
  }

  ownerOfCard(cardKey) {
    return ['A', 'B'].find((playerId) => this.seats[playerId]?.handCardKeys.includes(cardKey)) || null
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
        expiresAtServerTime: current.restEndsAtServerTime,
      }
      current.restReason = 'opponent_card'
    }
    const nextAt = this.remaining.size ? current.restEndsAtServerTime : null
    this.touch()
    this.broadcast({
      t: 'roundResult',
      roundNo: current.roundNo,
      cardKey: current.cardKey,
      winner,
      reason,
      song: { displayName: current.song.displayName, fileName: current.song.fileName },
      scores: { ...this.scores },
      remainingCardKeys: [...this.remaining],
      nextRoundAtServerTime: nextAt,
    })
    this.sendRoom()
    const nextDelay = this.remaining.size ? Math.max(0, current.restEndsAtServerTime - Date.now()) : 0
    if (!this.pendingTransfer) this.scheduleNextRound(nextDelay)
  }

  endMatch() {
    if (this.phase === 'over') return
    this.clearTimers()
    this.phase = 'over'
    this.current = null
    const winner = this.scores.A === this.scores.B ? null : this.scores.A > this.scores.B ? 'A' : 'B'
    this.touch()
    this.broadcast({ t: 'matchOver', winner, scores: { ...this.scores }, rounds: this.roundNo })
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
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat?.disconnectedAt && now - seat.disconnectedAt > RESUME_TTL_MS) {
        this.manager.resumeIndex.delete(seat.resumeToken)
        this.seats[playerId] = null
        this.resetMatch()
      }
    }
    if (!this.seats.A && !this.seats.B) this.manager.dropRoom(this)
    else this.sendRoom()
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
      this.manager.send(seat.socket, { t: 'room', room: this.view(playerId) })
    }
  }

  networkChanged() {
    if (this.phase === 'lobby' && !this.fairnessView().canStart) {
      let changed = false
      for (const playerId of ['A', 'B']) {
        const seat = this.seats[playerId]
        if (seat?.ready) {
          seat.ready = false
          changed = true
        }
      }
      if (changed) this.touch()
    }
    this.sendRoom()
  }

  broadcastPeer(playerId, connected) {
    this.broadcast({ t: 'peer', playerId, connected })
  }

  broadcast(message) {
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat?.socket) this.manager.send(seat.socket, message)
    }
  }

  view(you) {
    return {
      code: this.code,
      name: this.name,
      packageId: this.packageId,
      deckName: this.deckName,
      you,
      phase: this.phase,
      players: {
        A: this.playerView('A', you),
        B: this.playerView('B', you),
      },
      cards: this.cards.map(({ key, number, imageName, workName }) => ({
        key,
        number,
        imageName,
        workName,
        imageUrl: `/api/packages/${encodeURIComponent(this.packageId)}/card-image?cardKey=${encodeURIComponent(key)}`,
      })),
      remainingCardKeys: [...this.remaining],
      restEndsAtServerTime: this.current?.restEndsAtServerTime || null,
      restAudioUrl: this.current?.restAudioUrl || null,
      arrangeReadyStartAtServerTime: this.arrangeReadyStartAt,
      restReadyStartAtServerTime: this.restReadyStartAt,
      roundNo: this.roundNo,
      fairness: this.fairnessView(),
      draft: this.draftView(you),
      pendingTransfer: this.pendingTransfer,
    }
  }

  playerView(playerId, viewerId) {
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
      handCardKeys: playerId === viewerId ? [...seat.handCardKeys] : [...seat.handCardKeys].sort(),
      layoutCardKeys:
        playerId !== viewerId && this.phase === 'playing' && seat.layoutCardKeys.length === MAX_HAND_SLOTS
          ? [...seat.layoutCardKeys]
          : null,
    }
  }

  draftView(playerId) {
    const seat = this.seats[playerId]
    const opponent = this.seats[otherPlayer(playerId)]
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
      poolCardKeys: this.phase === 'draft_select' ? [...(seat?.poolCardKeys || [])] : [],
      selectedCardKeys: [...(seat?.selectedCardKeys || [])],
      exchangeCardKeys: this.phase === 'draft_ban' ? [...(seat?.exchangeCardKeys || [])] : [],
      bannedCardKeys: [...(seat?.bannedCardKeys || [])],
      selectionSize: DRAFT_SELECTION_SIZE,
      banSize: BAN_SIZE,
      opponentSelectedCount: opponent?.selectedCardKeys.length || 0,
      opponentBannedCount: opponent?.bannedCardKeys.length || 0,
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
  }

  dispose() {
    this.disposed = true
    this.clearTimers()
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
