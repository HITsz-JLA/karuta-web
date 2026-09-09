import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 6
const MAX_NICKNAME_LENGTH = 20
const MAX_ROOM_NAME_LENGTH = 40
const MAX_CARDS = 24
const ROUND_WINDOW_MS = 10_000
const ROUND_LEAD_MS = 750
const REVEAL_MS = 2_400
const ROOM_TTL_MS = 30 * 60 * 1000
const RESUME_TTL_MS = 90 * 1000
const MAX_MESSAGE_BYTES = 128 * 1024
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
    const deckName = sanitizeText(message.deckName, 80) || packageId.replace(/\.zip$/i, '')
    const cards = normalizeCards(message.cards)
    if (!nickname) {
      this.sendError(session, 'bad_nickname', '请输入昵称')
      return
    }
    if (!packageId || !cards.ok) {
      this.sendError(session, 'bad_room', cards.message || '房间数据无效')
      return
    }
    try {
      await fs.access(path.join(this.dataDir, packageId))
    } catch {
      this.sendError(session, 'package_not_found', '服务器找不到该数据包，请重新加载数据包后重试')
      return
    }

    const room = new OnlineRoom(this, {
      code: this.newCode(),
      name,
      packageId,
      deckName,
      cards: cards.value,
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
      score: 0,
      correctClaims: 0,
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
    this.cardByKey = new Map(this.cards.map((card) => [card.key, card]))
    this.seats = { A: null, B: null }
    this.phase = 'lobby'
    this.roundNo = 0
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.scores = EMPTY_SCORES()
    this.current = null
    this.roundTimer = null
    this.nextRoundTimer = null
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
    if (!playerId || this.phase !== 'lobby') return
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
      if (this.fairnessView().canStart) this.startMatch()
      else {
        this.seats.A.ready = false
        this.seats.B.ready = false
        this.sendRoom()
      }
      return
    }
    this.sendRoom()
  }

  startMatch() {
    if (this.phase !== 'lobby' || !this.fairnessView().canStart) return
    this.phase = 'playing'
    this.roundNo = 0
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.scores = EMPTY_SCORES()
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat) {
        seat.ready = false
        seat.score = 0
        seat.correctClaims = 0
      }
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
    const keys = [...this.remaining]
    const cardKey = keys[Math.floor(Math.random() * keys.length)]
    const card = this.cardByKey.get(cardKey)
    if (!card || !card.songs.length) {
      this.remaining.delete(cardKey)
      this.scheduleNextRound(0)
      return
    }
    const song = card.songs[Math.floor(Math.random() * card.songs.length)]
    const token = crypto.randomBytes(20).toString('base64url')
    const startAt = Date.now() + ROUND_LEAD_MS
    this.roundNo += 1
    this.current = {
      roundNo: this.roundNo,
      cardKey,
      song,
      token,
      startAt,
      endsAt: startAt + ROUND_WINDOW_MS,
      claims: new Map(),
      expiresAt: startAt + ROUND_WINDOW_MS + REVEAL_MS + 10_000,
    }
    this.touch()
    this.broadcast({
      t: 'roundStart',
      roundNo: this.roundNo,
      startAtServerTime: startAt,
      windowMs: ROUND_WINDOW_MS,
      audioUrl: `/api/online/room/${this.code}/audio/${token}`,
    })
    this.roundTimer = setTimeout(
      () => this.resolveRound(null, 'timeout'),
      ROUND_LEAD_MS + ROUND_WINDOW_MS + CLAIM_COMPENSATION_CAP_MS,
    )
  }

  claim(session, message) {
    const playerId = this.playerIdFor(session)
    const current = this.current
    if (!playerId || this.phase !== 'playing' || !current || current.resolved) return
    if (message.roundNo !== current.roundNo || current.claims.has(playerId)) return
    const cardKey = typeof message.cardKey === 'string' ? message.cardKey : ''
    if (!this.cardByKey.has(cardKey)) return
    const receivedAt = Date.now()
    const rttMs = session.network?.rttMs
    const compensationMs = Number.isFinite(rttMs)
      ? Math.min(CLAIM_COMPENSATION_CAP_MS, Math.max(0, rttMs / 2))
      : 0
    const adjustedAt = receivedAt - compensationMs
    const correct = adjustedAt >= current.startAt && adjustedAt <= current.endsAt && cardKey === current.cardKey
    current.claims.set(playerId, { cardKey, correct, receivedAt, adjustedAt, compensationMs })
    this.touch()
    this.broadcast({ t: 'claimFeedback', playerId, cardKey, correct })
    if (correct) this.scheduleClaimSettlement()
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

  resolveRound(winner, reason) {
    const current = this.current
    if (!current || this.phase !== 'playing') return
    if (this.roundTimer) clearTimeout(this.roundTimer)
    if (current.settlementTimer) clearTimeout(current.settlementTimer)
    this.roundTimer = null
    current.settlementTimer = null
    current.resolved = true
    this.current = current
    this.remaining.delete(current.cardKey)
    if (winner) {
      this.scores[winner] += 1
      const seat = this.seats[winner]
      if (seat) {
        seat.score = this.scores[winner]
        seat.correctClaims += 1
      }
    }
    const nextAt = this.remaining.size ? Date.now() + REVEAL_MS : null
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
    this.scheduleNextRound(REVEAL_MS)
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
    this.remaining = new Set(this.cards.map((card) => card.key))
    this.scores = EMPTY_SCORES()
    for (const playerId of ['A', 'B']) {
      const seat = this.seats[playerId]
      if (seat) {
        seat.ready = false
        seat.score = 0
        seat.correctClaims = 0
      }
    }
  }

  assetForToken(token) {
    const current = this.current
    if (!current || current.token !== token || current.expiresAt < Date.now()) return null
    return {
      packageId: this.packageId,
      sourcePath: current.song.sourcePath,
      fileName: current.song.fileName,
      expiresAt: current.expiresAt,
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
        A: this.playerView('A'),
        B: this.playerView('B'),
      },
      cards: this.cards.map(({ key, number, imageName, workName }) => ({ key, number, imageName, workName })),
      remainingCardKeys: [...this.remaining],
      roundNo: this.roundNo,
      totalRounds: this.cards.length,
      fairness: this.fairnessView(),
    }
  }

  playerView(playerId) {
    const seat = this.seats[playerId]
    if (!seat) return null
    return {
      id: playerId,
      nickname: seat.nickname,
      connected: Boolean(seat.socket),
      ready: seat.ready,
      score: seat.score,
      correctClaims: seat.correctClaims,
      network: this.networkView(playerId),
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
    if (this.current?.settlementTimer) clearTimeout(this.current.settlementTimer)
    this.roundTimer = null
    this.nextRoundTimer = null
    if (this.current) this.current.settlementTimer = null
  }

  touch() {
    this.lastActivity = Date.now()
  }

  dispose() {
    this.disposed = true
    this.clearTimers()
  }
}

function normalizeCards(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_CARDS) {
    return { ok: false, message: `请准备 ${2}-${MAX_CARDS} 张卡牌` }
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
