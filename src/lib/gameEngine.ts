import type { CardEntry, FailureMode, RoundResult, RoundState, SongEntry } from '../types/models'
import { getBlob } from './storage'

const REST_VOLUME_FACTOR = Math.pow(10, -12 / 20)
const MAX_PLAYBACK_SECONDS = 30

export interface GameSnapshot {
  roundState: RoundState
  currentRound: number
  totalRounds: number
  currentCard: CardEntry | null
  currentSong: SongEntry | null
  activeCards: CardEntry[]
  inactiveCards: CardEntry[]
  results: RoundResult[]
  playbackDuration: number
  isRestPlaying: boolean
  error: string | null
}

type Listener = (snapshot: GameSnapshot) => void

export class AudioController {
  private audio = new Audio()
  private objectUrl: string | null = null
  private limitTimer: number | null = null
  private onEnded: (() => void) | null = null

  constructor() {
    this.audio.preload = 'auto'
    this.audio.addEventListener('ended', () => {
      this.onEnded?.()
    })
  }

  setVolume(volume: number) {
    this.audio.volume = Math.min(1, Math.max(0, volume))
  }

  getVolume() {
    return this.audio.volume
  }

  async playSong(song: SongEntry, volume: number, limitSeconds?: number): Promise<void> {
    this.stop()
    const blob = await getBlob(song.blobKey)
    if (!blob) throw new Error(`找不到音频：${song.fileName}`)

    this.objectUrl = URL.createObjectURL(blob)
    this.audio.src = this.objectUrl
    this.setVolume(volume)
    await this.audio.play()

    if (limitSeconds && limitSeconds > 0) {
      const effectiveLimit = Math.min(limitSeconds, MAX_PLAYBACK_SECONDS)
      this.limitTimer = window.setTimeout(() => {
        this.pause()
        this.onEnded?.()
      }, effectiveLimit * 1000)
    }
  }

  pause() {
    this.audio.pause()
  }

  resume() {
    void this.audio.play()
  }

  stop() {
    if (this.limitTimer != null) {
      window.clearTimeout(this.limitTimer)
      this.limitTimer = null
    }
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }

  setOnEnded(handler: (() => void) | null) {
    this.onEnded = handler
  }

  isPaused() {
    return this.audio.paused
  }

  dispose() {
    this.stop()
    this.onEnded = null
  }
}

export class GameEngine {
  private cards: CardEntry[] = []
  private activeCards: CardEntry[] = []
  private inactiveCards: CardEntry[] = []
  private restPool: SongEntry[] = []
  private listeners = new Set<Listener>()
  private audio = new AudioController()

  private roundState: RoundState = 'IDLE'
  private currentRound = 0
  private totalRounds = 0
  private currentCard: CardEntry | null = null
  private currentSong: SongEntry | null = null
  private results: RoundResult[] = []
  private playbackDuration = 0
  private isRestPlaying = false
  private error: string | null = null
  private failureMode: FailureMode = 'PASS'
  private enableRestMusic = true
  private minDuration = 10
  private maxDuration = 30
  private volume = 0.8
  private playSession = 0

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  start(options: {
    selectedCards: CardEntry[]
    emptySources?: CardEntry[]
    restPool?: SongEntry[]
    failureMode: FailureMode
    enableRestMusic: boolean
    minDuration: number
    maxDuration: number
    volume: number
  }) {
    const playable = options.selectedCards.map((card) => ({ ...card, emptyCard: false }))
    const empties = (options.emptySources || [])
      .slice(0, playable.length)
      .map((card) => ({
        ...card,
        id: `${card.id}#empty`,
        emptyCard: true,
      }))

    this.cards = [...playable, ...empties]
    this.activeCards = [...this.cards]
    this.inactiveCards = []
    this.restPool = options.restPool || []
    this.failureMode = options.failureMode
    this.enableRestMusic = options.enableRestMusic
    this.minDuration = options.minDuration
    this.maxDuration = options.maxDuration
    this.volume = options.volume
    this.totalRounds = playable.length
    this.currentRound = 0
    this.currentCard = null
    this.currentSong = null
    this.results = []
    this.roundState = 'IDLE'
    this.error = null
    this.audio.setVolume(this.volume)
    this.emit()
  }

  prepareNextRound() {
    if (this.roundState === 'GAME_OVER') return
    if (this.roundState === 'REST_MUSIC' || this.roundState === 'ROUND_COMPLETE') {
      this.audio.stop()
      this.isRestPlaying = false
      this.roundState = 'IDLE'
    }
    if (this.roundState !== 'IDLE') return
    this.startNewRound()
  }

  private startNewRound() {
    if (!this.hasActiveRealCards()) {
      this.endGame()
      return
    }

    this.currentRound += 1
    this.currentCard = null
    this.currentSong = null

    const card = this.pickRandom(this.activeCards)
    if (!card) {
      this.endGame()
      return
    }

    this.currentCard = card
    this.currentSong = card.songs.length
      ? this.pickRandom(card.songs)
      : null

    // 空牌仍播放题目曲目，但判定固定为成功（与桌面版一致）
    this.roundState = card.emptyCard ? 'EMPTY_CARD' : 'CARD_SELECTED'
    this.emit()
    void this.playCurrentSong()
  }

  private async playCurrentSong() {
    if (!this.currentSong) {
      this.roundState = 'WAITING_RESULT'
      this.emit()
      return
    }

    const session = ++this.playSession
    this.playbackDuration = Math.min(this.randomDuration(), MAX_PLAYBACK_SECONDS)
    this.roundState = 'MUSIC_PLAYING'
    this.emit()

    this.audio.setOnEnded(() => {
      if (session !== this.playSession) return
      this.roundState = 'WAITING_RESULT'
      this.emit()
    })

    try {
      await this.audio.playSong(this.currentSong, this.volume, this.playbackDuration)
    } catch (error) {
      this.error = error instanceof Error ? error.message : '播放失败'
      this.roundState = 'WAITING_RESULT'
      this.emit()
    }
  }

  submitResult(result: RoundResult) {
    if (
      this.roundState !== 'MUSIC_PLAYING' &&
      this.roundState !== 'WAITING_RESULT' &&
      this.roundState !== 'CARD_SELECTED' &&
      this.roundState !== 'EMPTY_CARD'
    ) {
      return
    }

    this.playSession += 1
    this.audio.stop()

    let finalResult = result
    if (this.currentCard?.emptyCard) {
      finalResult = 'SUCCESS'
    }

    this.results.push(finalResult)

    if (this.currentCard) {
      if (finalResult === 'SUCCESS') {
        this.moveToInactive(this.currentCard)
      } else if (this.failureMode === 'SKIP') {
        this.moveToInactive(this.currentCard)
      }
    }

    this.roundState = 'ROUND_COMPLETE'
    this.emit()

    if (!this.hasActiveRealCards()) {
      this.endGame()
      return
    }

    this.enterRest()
  }

  private async enterRest() {
    this.roundState = 'REST_MUSIC'
    this.isRestPlaying = false
    this.emit()

    if (!this.enableRestMusic || this.restPool.length === 0) return

    const song = this.pickRandom(this.restPool)
    if (!song) return

    try {
      this.isRestPlaying = true
      const restSession = this.playSession
      this.audio.setOnEnded(() => {
        if (restSession !== this.playSession) return
        this.isRestPlaying = false
        this.emit()
      })
      this.emit()
      await this.audio.playSong(song, this.volume * REST_VOLUME_FACTOR, MAX_PLAYBACK_SECONDS)
    } catch {
      this.isRestPlaying = false
      this.emit()
    }
  }

  toggleRestMusic() {
    if (this.roundState !== 'REST_MUSIC') return
    if (this.audio.isPaused()) {
      this.audio.resume()
      this.isRestPlaying = true
    } else {
      this.audio.pause()
      this.isRestPlaying = false
    }
    this.emit()
  }

  moveCard(cardId: string, toActive: boolean) {
    const from = toActive ? this.inactiveCards : this.activeCards
    const to = toActive ? this.activeCards : this.inactiveCards
    const index = from.findIndex((card) => card.id === cardId)
    if (index < 0) return
    const [card] = from.splice(index, 1)
    if (!to.some((item) => item.id === card.id)) {
      to.push(card)
    }
    this.emit()
  }

  resetInactiveToActive() {
    this.activeCards.push(...this.inactiveCards)
    this.inactiveCards = []
    this.emit()
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume))
    const effective =
      this.roundState === 'REST_MUSIC' ? this.volume * REST_VOLUME_FACTOR : this.volume
    this.audio.setVolume(effective)
    this.emit()
  }

  abort() {
    this.playSession += 1
    this.audio.stop()
    this.roundState = 'GAME_OVER'
    this.emit()
  }

  dispose() {
    this.playSession += 1
    this.audio.dispose()
    this.listeners.clear()
  }

  private endGame() {
    this.playSession += 1
    this.audio.stop()
    this.isRestPlaying = false
    this.roundState = 'GAME_OVER'
    this.emit()
  }

  private moveToInactive(card: CardEntry) {
    this.activeCards = this.activeCards.filter((item) => item.id !== card.id)
    if (!this.inactiveCards.some((item) => item.id === card.id)) {
      this.inactiveCards.push(card)
    }
  }

  private hasActiveRealCards() {
    return this.activeCards.some((card) => !card.emptyCard)
  }

  private randomDuration() {
    const min = Math.min(Math.max(1, this.minDuration), MAX_PLAYBACK_SECONDS)
    const max = Math.min(Math.max(min, this.maxDuration), MAX_PLAYBACK_SECONDS)
    if (min >= max) return min
    return (
      min +
      Math.floor(Math.random() * (max - min + 1))
    )
  }

  private pickRandom<T>(items: T[]): T | null {
    if (!items.length) return null
    return items[Math.floor(Math.random() * items.length)]
  }

  private snapshot(): GameSnapshot {
    return {
      roundState: this.roundState,
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      currentCard: this.currentCard,
      currentSong: this.currentSong,
      activeCards: [...this.activeCards],
      inactiveCards: [...this.inactiveCards],
      results: [...this.results],
      playbackDuration: this.playbackDuration,
      isRestPlaying: this.isRestPlaying,
      error: this.error,
    }
  }

  private emit() {
    const snap = this.snapshot()
    this.listeners.forEach((listener) => listener(snap))
  }
}
