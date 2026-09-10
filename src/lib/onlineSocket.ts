import type { OnlineClientMessage, OnlineServerMessage } from './onlineProtocol'

export type OnlineNetworkSnapshot = Extract<OnlineServerMessage, { t: 'network' }>

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 5_000
const CLIENT_PING_INTERVAL_MS = 2_000
const CLIENT_PONG_TIMEOUT_MS = 8_000
const MANUAL_RECONNECT_CLOSE_CODE = 4003
const MANUAL_RECONNECT_TIMEOUT_MS = 2_000
const RESUME_KEY = 'karuta-online-resume'

interface StoredResume {
  roomCode: string
  token: string
}

function readResume(): StoredResume | null {
  try {
    const value = JSON.parse(localStorage.getItem(RESUME_KEY) || '') as Partial<StoredResume>
    if (typeof value.roomCode === 'string' && typeof value.token === 'string' && value.token) return value as StoredResume
  } catch {
    // A private browsing context may deny localStorage. Online play still works.
  }
  return null
}

function writeResume(value: StoredResume | null, serialized = value ? JSON.stringify(value) : null) {
  try {
    if (value) localStorage.setItem(RESUME_KEY, serialized || '')
    else localStorage.removeItem(RESUME_KEY)
    return true
  } catch {
    // Resume is a convenience, not a prerequisite for a match.
    return false
  }
}

type MessageListener = (message: OnlineServerMessage) => void
export type OnlineDisconnectReason = 'replaced' | 'closed' | 'network'

export class OnlineSocket {
  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private readonly listeners = new Set<MessageListener>()
  private readonly statusListeners = new Set<(connected: boolean, reason?: OnlineDisconnectReason) => void>()
  private readonly networkListeners = new Set<() => void>()
  private pingTimer = 0
  private livenessTimer = 0
  private reconnectTimer = 0
  private reconnectAttempt = 0
  private readonly offsets: number[] = []
  private networkSnapshot: OnlineNetworkSnapshot | null = null
  private resumeToken: string | null
  private roomCode: string | null
  private persistedResume: StoredResume | null = null
  private spectatorRoomCode: string | null = null
  private shouldReconnect = true
  private lastPongAt = 0

  clockOffsetMs = 0
  connected = false

  constructor() {
    const resume = readResume()
    this.resumeToken = resume?.token || null
    this.roomCode = resume?.roomCode || null
    this.persistedResume = resume
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = 0
    }
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
      this.socket = socket
      let settled = false

      socket.onopen = () => {
        if (this.socket !== socket || !this.shouldReconnect) return
        this.connected = true
        this.reconnectAttempt = 0
        this.lastPongAt = Date.now()
        this.emitStatus(true)
        this.send({ t: 'hello', ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) })
        // A player resume always takes precedence over a stale spectator
        // target. This prevents a reconnect from sending both intents when a
        // tab changed mode just as its WebSocket was replaced.
        if (!this.resumeToken && this.spectatorRoomCode) this.send({ t: 'spectateRoom', code: this.spectatorRoomCode })
        else if (!this.resumeToken && !this.roomCode) this.send({ t: 'listRooms' })
        this.startPing()
        if (!settled) {
          settled = true
          resolve()
        }
      }
      socket.onmessage = (event) => {
        if (this.socket !== socket) return
        let message: OnlineServerMessage
        try {
          message = JSON.parse(String(event.data)) as OnlineServerMessage
        } catch {
          return
        }
        if (message.t === 'welcome') {
          if (message.resumeRejected) {
            this.clearResume()
            this.send({ t: 'listRooms' })
          } else if (message.resumeToken) {
            this.resumeToken = message.resumeToken
            this.persistResume()
          }
        }
        if (message.t === 'room') {
          this.roomCode = message.room.code
          this.spectatorRoomCode = message.room.spectator ? message.room.code : null
          this.persistResume()
          this.publishNetworkSnapshot({
            t: 'network',
            players: {
              A: message.room.players.A?.network || { rttMs: null, jitterMs: null, samples: 0 },
              B: message.room.players.B?.network || { rttMs: null, jitterMs: null, samples: 0 },
            },
            fairness: message.room.fairness,
          })
        }
        if (message.t === 'pong') this.notePong(message.clientAt, message.serverAt)
        if (message.t === 'network') this.publishNetworkSnapshot(message)
        for (const listener of this.listeners) listener(message)
      }
      socket.onerror = () => {
        if (!this.connected && !settled) {
          settled = true
          reject(new Error('无法连接在线歌牌服务，请确认服务器已启动'))
        }
        // Browsers normally emit close after error, but explicitly closing the
        // failed socket makes the reconnect path deterministic on mobile
        // networks that leave a WebSocket in CONNECTING for a long time.
        try {
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
        } catch {
          // The close event is best-effort; the reconnect timer is authoritative.
        }
      }
      socket.onclose = (event) => {
        if (this.socket !== socket) return
        const replaced = event.code === 4001
        this.socket = null
        this.connected = false
        this.stopPing()
        this.offsets.length = 0
        this.clockOffsetMs = 0
        this.publishNetworkSnapshot(null)
        if (replaced) {
          // Another page has already resumed this seat. Reconnecting from
          // this stale page would take the seat back and create a ping-pong
          // loop between the two pages.
          this.shouldReconnect = false
          this.resumeToken = null
          this.roomCode = null
          this.spectatorRoomCode = null
        }
        this.emitStatus(false, replaced ? 'replaced' : this.shouldReconnect ? 'network' : 'closed')
        this.connectPromise = null
        if (!settled) {
          settled = true
          reject(new Error('在线连接已断开，正在尝试重连'))
        }
        if (!replaced) this.scheduleReconnect()
      }
    }).finally(() => {
      this.connectPromise = null
    })

    return this.connectPromise
  }

  send(message: OnlineClientMessage): boolean {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      // readyState can change between the check and send during a network
      // handover. Report a failed action and let onclose schedule recovery.
      if (this.socket === socket) {
        try {
          socket.close()
        } catch {
          // The close event is best-effort; the next reconnect attempt is the
          // authoritative recovery path.
        }
      }
    }
    return false
  }

  async reconnect(): Promise<void> {
    this.shouldReconnect = true
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = 0
    }
    this.reconnectAttempt = 0

    const previous = this.socket
    if (!previous || previous.readyState === WebSocket.CLOSED) return this.connect()

    const closed = this.waitForSocketReplacement(previous)
    try {
      previous.close(MANUAL_RECONNECT_CLOSE_CODE, 'manual reconnect')
    } catch {
      // The close event or the timeout below will still advance recovery.
    }
    await closed
    return this.connect()
  }

  on(listener: MessageListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (connected: boolean, reason?: OnlineDisconnectReason) => void) {
    this.statusListeners.add(listener)
    listener(this.connected)
    return () => this.statusListeners.delete(listener)
  }

  getNetworkSnapshot = () => this.networkSnapshot

  subscribeNetwork = (listener: () => void) => {
    this.networkListeners.add(listener)
    return () => this.networkListeners.delete(listener)
  }

  clearNetworkSnapshot() {
    this.publishNetworkSnapshot(null)
  }

  clearResume() {
    this.resumeToken = null
    this.roomCode = null
    this.spectatorRoomCode = null
    writeResume(null)
    this.persistedResume = null
  }

  setSpectatorRoom(code: string) {
    this.spectatorRoomCode = code
  }

  clearSpectatorRoom() {
    this.spectatorRoomCode = null
  }

  close() {
    this.shouldReconnect = false
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = 0
    this.reconnectAttempt = 0
    this.stopPing()
    const socket = this.socket
    if (socket) socket.close()
    else if (this.connected) {
      this.connected = false
      this.emitStatus(false)
    }
  }

  toLocalTime(serverTime: number) {
    return serverTime - this.clockOffsetMs
  }

  private startPing() {
    this.stopPing()
    const tick = () => this.send({ t: 'ping', clientAt: Date.now() })
    tick()
    this.pingTimer = window.setInterval(tick, CLIENT_PING_INTERVAL_MS)
    this.livenessTimer = window.setInterval(() => {
      const socket = this.socket
      if (socket?.readyState !== WebSocket.OPEN || !this.lastPongAt) return
      if (Date.now() - this.lastPongAt <= CLIENT_PONG_TIMEOUT_MS) return
      try {
        socket.close(4002, 'pong timeout')
      } catch {
        // The close event is best-effort; the automatic reconnect remains active.
      }
    }, 1_000)
  }

  private stopPing() {
    if (this.pingTimer) window.clearInterval(this.pingTimer)
    this.pingTimer = 0
    if (this.livenessTimer) window.clearInterval(this.livenessTimer)
    this.livenessTimer = 0
    this.lastPongAt = 0
  }

  private persistResume() {
    if (!this.resumeToken) return
    const value = { roomCode: this.roomCode || '', token: this.resumeToken }
    if (this.persistedResume?.roomCode === value.roomCode && this.persistedResume?.token === value.token) return
    if (writeResume(value)) this.persistedResume = value
  }

  private notePong(clientAt: number, serverAt: number) {
    const now = Date.now()
    const rtt = now - clientAt
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return
    this.lastPongAt = now
    this.offsets.push(serverAt + rtt / 2 - now)
    if (this.offsets.length > 12) this.offsets.shift()
    const sorted = [...this.offsets].sort((a, b) => a - b)
    this.clockOffsetMs = sorted[Math.floor(sorted.length / 2)] || 0
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer || this.socket || this.connectPromise) return
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0
      void this.connect().catch(() => undefined)
    }, delay)
  }

  private waitForSocketReplacement(previous: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        if (this.socket !== previous || previous.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        if (Date.now() - startedAt >= MANUAL_RECONNECT_TIMEOUT_MS) {
          // A browser can keep a half-open socket in CLOSING indefinitely.
          // Detach it locally so the new connection can resume the same seat;
          // the server-side resume replacement handles the stale TCP session.
          if (this.socket === previous) {
            this.socket = null
            this.connected = false
            this.stopPing()
            this.publishNetworkSnapshot(null)
            this.emitStatus(false)
          }
          resolve()
          return
        }
        window.setTimeout(check, 50)
      }
      check()
    })
  }

  private publishNetworkSnapshot(next: OnlineNetworkSnapshot | null) {
    const previous = this.networkSnapshot
    if (
      previous &&
      next &&
      previous.players.A.rttMs === next.players.A.rttMs &&
      previous.players.A.jitterMs === next.players.A.jitterMs &&
      previous.players.A.samples === next.players.A.samples &&
      previous.players.B.rttMs === next.players.B.rttMs &&
      previous.players.B.jitterMs === next.players.B.jitterMs &&
      previous.players.B.samples === next.players.B.samples &&
      previous.fairness.status === next.fairness.status &&
      previous.fairness.canStart === next.fairness.canStart &&
      previous.fairness.rttGapMs === next.fairness.rttGapMs &&
      previous.fairness.jitterGapMs === next.fairness.jitterGapMs &&
      previous.fairness.maxJitterMs === next.fairness.maxJitterMs &&
      previous.fairness.message === next.fairness.message
    ) {
      return
    }
    this.networkSnapshot = next
    for (const listener of this.networkListeners) listener()
  }

  private emitStatus(connected: boolean, reason?: OnlineDisconnectReason) {
    for (const listener of this.statusListeners) listener(connected, reason)
  }
}
