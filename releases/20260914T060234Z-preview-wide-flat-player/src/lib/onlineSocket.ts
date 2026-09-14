import type { OnlineClientMessage, OnlineResumeReason, OnlineServerMessage } from './onlineProtocol'

export type OnlineNetworkSnapshot = Extract<OnlineServerMessage, { t: 'network' }>

const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 5_000
const CLIENT_PING_INTERVAL_MS = 2_000
const CLIENT_PONG_TIMEOUT_MS = 8_000
const MANUAL_RECONNECT_CLOSE_CODE = 4003
// A browser can keep a half-open socket in CLOSING forever and never deliver
// the close event. Recovery must not depend on that event, so every close
// attempt is followed by this bounded detach timer.
const CLOSE_FALLBACK_TIMEOUT_MS = 2_000
// A resumed connection must deliver a room snapshot shortly after hello. When
// the response is lost on a flaky link the client repeats hello and finally
// cycles the socket instead of showing "connected" with no room.
const RESUME_CONFIRM_TIMEOUT_MS = 4_000
const MAX_RESUME_CONFIRM_RETRIES = 2
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
  private closeFallbackTimer = 0
  private closeFallbackSocket: WebSocket | null = null
  private resumeConfirmTimer = 0
  private resumeConfirmRetries = 0
  private generation = 0
  private pendingConnectReject: ((error: Error) => void) | null = null
  private reconnectAttempt = 0
  private readonly offsets: number[] = []
  private networkSnapshot: OnlineNetworkSnapshot | null = null
  private readonly resumeRejectionListeners = new Set<(reason: OnlineResumeReason) => void>()
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

    const stale = this.socket
    if (stale && stale.readyState !== WebSocket.CLOSED) {
      // A socket left in CONNECTING/CLOSING by an aborted attempt must not be
      // able to report anything about the connection that replaces it.
      this.abortConnection(stale)
    }
    // Every physical connection gets its own generation. Late callbacks from a
    // detached socket must not touch the state of the socket that replaced it.
    const generation = this.generation + 1
    this.generation = generation
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
      this.socket = socket
      this.pendingConnectReject = reject
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve()
      }

      socket.onopen = () => {
        if (!this.isCurrentSocket(socket, generation) || !this.shouldReconnect) return
        this.connected = true
        this.reconnectAttempt = 0
        this.emitStatus(true)
        this.send({ t: 'hello', ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) })
        // A player resume always takes precedence over a stale spectator
        // target. This prevents a reconnect from sending both intents when a
        // tab changed mode just as its WebSocket was replaced.
        if (!this.resumeToken && this.spectatorRoomCode) this.send({ t: 'spectateRoom', code: this.spectatorRoomCode })
        else if (!this.resumeToken && !this.roomCode) this.send({ t: 'listRooms' })
        this.startPing()
        this.watchResumeConfirmation(socket, generation)
        settle()
      }
      socket.onmessage = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return
        let message: OnlineServerMessage
        try {
          message = JSON.parse(String(event.data)) as OnlineServerMessage
        } catch {
          return
        }
        if (message.t === 'welcome') {
          if (message.resumeRejected) {
            this.clearResumeConfirmation()
            this.clearResume()
            this.emitResumeRejected(message.resumeReason || 'invalid_or_expired')
            this.send({ t: 'listRooms' })
          } else if (message.resumeToken) {
            this.resumeToken = message.resumeToken
            this.persistResume()
          }
        }
        if (message.t === 'room') {
          if (this.resumeToken) this.clearResumeConfirmation()
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
        if (!this.isCurrentSocket(socket, generation)) return
        settle(new Error('无法连接在线歌牌服务，请确认服务器已启动'))
        // Browsers normally emit close after error, but explicitly closing the
        // failed socket makes the reconnect path deterministic on mobile
        // networks that leave a WebSocket in CONNECTING for a long time.
        this.abortConnection(socket)
      }
      socket.onclose = (event) => {
        this.clearCloseFallback(socket)
        if (!this.isCurrentSocket(socket, generation)) return
        this.clearResumeConfirmation()
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
        settle(new Error('在线连接已断开，正在尝试重连'))
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
        // The browser may never deliver the close event for a half-open
        // socket, so the detach timer owns the recovery path.
        this.abortConnection(socket)
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

    const detached = this.waitForSocketDetach(previous)
    try {
      previous.close(MANUAL_RECONNECT_CLOSE_CODE, 'manual reconnect')
    } catch {
      // The close event or the timeout below will still advance recovery.
    }
    await detached
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

  /**
   * The server refused to restore the persisted seat. The page must drop the
   * stale room and explain why instead of showing a match it cannot operate.
   */
  onResumeRejected(listener: (reason: OnlineResumeReason) => void) {
    this.resumeRejectionListeners.add(listener)
    return () => this.resumeRejectionListeners.delete(listener)
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
    // Invalidate in-flight callbacks so a late close from the socket we are
    // tearing down cannot schedule a reconnect or emit a stale status.
    this.generation += 1
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = 0
    this.clearCloseFallback()
    this.clearResumeConfirmation()
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
    // The first pong is part of the liveness contract. Arm the wait when the
    // first ping goes out so a connection that never answers still times out
    // instead of showing "connected" forever.
    this.lastPongAt = Date.now()
    this.pingTimer = window.setInterval(tick, CLIENT_PING_INTERVAL_MS)
    this.livenessTimer = window.setInterval(() => {
      const socket = this.socket
      if (socket?.readyState !== WebSocket.OPEN || !this.lastPongAt) return
      if (Date.now() - this.lastPongAt <= CLIENT_PONG_TIMEOUT_MS) return
      // Recovery must not depend on the browser delivering a close event: the
      // detach timer in abortConnection advances the reconnect either way.
      this.abortConnection(socket)
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

  private isCurrentSocket(socket: WebSocket, generation: number) {
    return this.socket === socket && this.generation === generation
  }

  /**
   * Confirm that a resume actually produced room state. A socket can be open
   * (and even answer pings) while the reply to hello never arrives; without
   * this watchdog the page would look connected but stay outside the match.
   */
  private watchResumeConfirmation(socket: WebSocket, generation: number) {
    this.clearResumeConfirmation()
    if (!this.resumeToken) return
    this.resumeConfirmTimer = window.setTimeout(() => {
      this.resumeConfirmTimer = 0
      if (!this.isCurrentSocket(socket, generation) || !this.resumeToken) return
      if (this.resumeConfirmRetries < MAX_RESUME_CONFIRM_RETRIES) {
        this.resumeConfirmRetries += 1
        this.send({ t: 'hello', resumeToken: this.resumeToken })
        this.watchResumeConfirmation(socket, generation)
        return
      }
      // Repeated hello attempts were never answered with a room snapshot:
      // cycle the connection rather than leaving a silent, roomless session.
      this.abortConnection(socket)
    }, RESUME_CONFIRM_TIMEOUT_MS)
  }

  private clearResumeConfirmation() {
    if (this.resumeConfirmTimer) window.clearTimeout(this.resumeConfirmTimer)
    this.resumeConfirmTimer = 0
    this.resumeConfirmRetries = 0
  }

  /** Best-effort close plus a bounded detach so recovery never stalls. */
  private abortConnection(socket: WebSocket) {
    try {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    } catch {
      // The close event is best-effort; the detach timer is authoritative.
    }
    this.armCloseFallback(socket)
  }

  private armCloseFallback(socket: WebSocket) {
    if (this.closeFallbackSocket === socket) return
    this.clearCloseFallback()
    this.closeFallbackSocket = socket
    this.closeFallbackTimer = window.setTimeout(() => {
      this.closeFallbackTimer = 0
      this.closeFallbackSocket = null
      this.detachSocket(socket)
    }, CLOSE_FALLBACK_TIMEOUT_MS)
  }

  private clearCloseFallback(socket?: WebSocket) {
    if (socket && this.closeFallbackSocket !== socket) return
    if (this.closeFallbackTimer) window.clearTimeout(this.closeFallbackTimer)
    this.closeFallbackTimer = 0
    this.closeFallbackSocket = null
  }

  /**
   * Drop a socket that is closing without a usable close event. The server
   * still holds the seat for the resume window, so the next connection can
   * take it over with the persisted credential.
   */
  private detachSocket(socket: WebSocket) {
    if (this.socket !== socket) return
    this.clearResumeConfirmation()
    this.socket = null
    this.connected = false
    this.stopPing()
    this.offsets.length = 0
    this.clockOffsetMs = 0
    this.publishNetworkSnapshot(null)
    const reject = this.pendingConnectReject
    this.pendingConnectReject = null
    this.connectPromise = null
    this.emitStatus(false, 'network')
    reject?.(new Error('在线连接已断开，正在尝试重连'))
    this.scheduleReconnect()
  }

  private waitForSocketDetach(previous: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const check = () => {
        if (this.socket !== previous || previous.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        if (Date.now() - startedAt >= CLOSE_FALLBACK_TIMEOUT_MS) {
          // A browser can keep a half-open socket in CLOSING indefinitely.
          // Detach it locally so the new connection can resume the same seat;
          // the server-side resume replacement handles the stale TCP session.
          this.detachSocket(previous)
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

  private emitResumeRejected(reason: OnlineResumeReason) {
    for (const listener of this.resumeRejectionListeners) listener(reason)
  }
}
