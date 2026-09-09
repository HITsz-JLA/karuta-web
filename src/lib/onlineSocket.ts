import type { OnlineClientMessage, OnlineServerMessage } from './onlineProtocol'

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

function writeResume(value: StoredResume | null) {
  try {
    if (value) localStorage.setItem(RESUME_KEY, JSON.stringify(value))
    else localStorage.removeItem(RESUME_KEY)
  } catch {
    // Resume is a convenience, not a prerequisite for a match.
  }
}

type MessageListener = (message: OnlineServerMessage) => void

export class OnlineSocket {
  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private readonly listeners = new Set<MessageListener>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private pingTimer = 0
  private readonly offsets: number[] = []
  private resumeToken: string | null = readResume()?.token || null
  private roomCode: string | null = readResume()?.roomCode || null

  clockOffsetMs = 0
  connected = false

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
      this.socket = socket

      socket.onopen = () => {
        this.connected = true
        this.emitStatus(true)
        this.send({ t: 'hello', ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) })
        this.startPing()
        resolve()
      }
      socket.onmessage = (event) => {
        let message: OnlineServerMessage
        try {
          message = JSON.parse(String(event.data)) as OnlineServerMessage
        } catch {
          return
        }
        if (message.t === 'welcome' && message.resumeToken) {
          this.resumeToken = message.resumeToken
          writeResume({ roomCode: this.roomCode || '', token: message.resumeToken })
        }
        if (message.t === 'room') {
          this.roomCode = message.room.code
          if (this.resumeToken) writeResume({ roomCode: message.room.code, token: this.resumeToken })
        }
        if (message.t === 'pong') this.notePong(message.clientAt, message.serverAt)
        for (const listener of this.listeners) listener(message)
      }
      socket.onerror = () => {
        if (!this.connected) reject(new Error('无法连接在线歌牌服务，请确认服务器已启动'))
      }
      socket.onclose = () => {
        this.connected = false
        this.stopPing()
        this.emitStatus(false)
        this.connectPromise = null
      }
    }).finally(() => {
      this.connectPromise = null
    })

    return this.connectPromise
  }

  send(message: OnlineClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  on(listener: MessageListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener)
    listener(this.connected)
    return () => this.statusListeners.delete(listener)
  }

  clearResume() {
    this.resumeToken = null
    this.roomCode = null
    writeResume(null)
  }

  close() {
    this.stopPing()
    this.socket?.close()
    this.socket = null
    this.connected = false
  }

  toLocalTime(serverTime: number) {
    return serverTime - this.clockOffsetMs
  }

  private startPing() {
    this.stopPing()
    const tick = () => this.send({ t: 'ping', clientAt: Date.now() })
    tick()
    this.pingTimer = window.setInterval(tick, 2000)
  }

  private stopPing() {
    if (this.pingTimer) window.clearInterval(this.pingTimer)
    this.pingTimer = 0
  }

  private notePong(clientAt: number, serverAt: number) {
    const now = Date.now()
    const rtt = now - clientAt
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return
    this.offsets.push(serverAt + rtt / 2 - now)
    if (this.offsets.length > 12) this.offsets.shift()
    const sorted = [...this.offsets].sort((a, b) => a - b)
    this.clockOffsetMs = sorted[Math.floor(sorted.length / 2)] || 0
  }

  private emitStatus(connected: boolean) {
    for (const listener of this.statusListeners) listener(connected)
  }
}
