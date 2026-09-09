import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBlob } from '../lib/storage'
import type { CardEntry, DeckRecord, SongEntry } from '../types/models'

const PREVIEW_SECONDS = 30
const CROSSFADE_SECONDS = 4
const CROSSFADE_MS = CROSSFADE_SECONDS * 1000

interface HomeNowPlayingProps {
  deck?: DeckRecord | null
  selectedCard: CardEntry | null
  volume: number
  onVolumeChange: (volume: number) => void
}

interface PreviewTrack {
  card: CardEntry
  song: SongEntry
}

interface AudioSlot {
  audio: HTMLAudioElement
  trackIndex: number | null
  url: string | null
}

function createAudioSlot(): AudioSlot {
  const audio = new Audio()
  audio.preload = 'auto'
  audio.setAttribute('playsinline', '')
  return { audio, trackIndex: null, url: null }
}

function releaseAudioSlot(slot: AudioSlot) {
  slot.audio.pause()
  slot.audio.onended = null
  slot.audio.removeAttribute('src')
  slot.audio.load()
  if (slot.url) URL.revokeObjectURL(slot.url)
  slot.trackIndex = null
  slot.url = null
}

function clampVolume(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.8))
}

function playbackError(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return '浏览器拦截了自动播放，请再次点击播放按钮'
  }
  return error instanceof Error ? error.message : '音频加载失败，请重试'
}

export function HomeNowPlaying({ deck, selectedCard, volume, onVolumeChange }: HomeNowPlayingProps) {
  const tracks = useMemo<PreviewTrack[]>(
    () =>
      deck?.cards.flatMap((card) =>
        card.songs.map((song) => ({ card, song })),
      ) || [],
    [deck],
  )
  const selectedCardId = selectedCard?.id || null
  const [trackIndex, setTrackIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const currentSlotRef = useRef<AudioSlot | null>(null)
  const nextSlotRef = useRef<AudioSlot | null>(null)
  const generationRef = useRef(0)
  const trackIndexRef = useRef(0)
  const volumeRef = useRef(clampVolume(volume))
  const isPlayingRef = useRef(false)
  const transitionStartedRef = useRef(false)
  const transitionFrameRef = useRef<number | null>(null)
  const transitionHandlerRef = useRef<() => void>(() => undefined)

  const cancelTransition = useCallback(() => {
    if (transitionFrameRef.current !== null) {
      window.cancelAnimationFrame(transitionFrameRef.current)
      transitionFrameRef.current = null
    }
    transitionStartedRef.current = false
    const current = currentSlotRef.current
    const next = nextSlotRef.current
    if (current) current.audio.volume = volumeRef.current
    if (next) {
      next.audio.pause()
      next.audio.volume = 0
    }
  }, [])

  const loadSlot = useCallback(
    async (slot: AudioSlot, nextIndex: number, generation: number) => {
      const track = tracks[nextIndex]
      if (!track || generation !== generationRef.current) return
      if (slot.trackIndex === nextIndex && slot.url) {
        slot.audio.volume = volumeRef.current
        return
      }

      if (slot.url) releaseAudioSlot(slot)
      // The home player is a 30-second preview. Full-length audio is reserved
      // for the rest-music path in GameEngine and should never be read here.
      const blob = await getBlob(track.song.blobKey)
      if (generation !== generationRef.current) return
      if (!blob) throw new Error(`找不到音频：${track.song.fileName}`)

      const url = URL.createObjectURL(blob)
      slot.url = url
      slot.trackIndex = nextIndex
      slot.audio.src = url
      slot.audio.volume = volumeRef.current
      slot.audio.onended = () => {
        if (currentSlotRef.current === slot && isPlayingRef.current) transitionHandlerRef.current()
      }
      slot.audio.load()
    },
    [tracks],
  )

  useEffect(() => {
    const current = createAudioSlot()
    const next = createAudioSlot()
    currentSlotRef.current = current
    nextSlotRef.current = next
    return () => {
      generationRef.current += 1
      cancelTransition()
      releaseAudioSlot(current)
      releaseAudioSlot(next)
      currentSlotRef.current = null
      nextSlotRef.current = null
    }
  }, [cancelTransition])

  useEffect(() => {
    volumeRef.current = clampVolume(volume)
  }, [volume])

  useEffect(() => {
    ++generationRef.current
    cancelTransition()
    isPlayingRef.current = false
    setIsPlaying(false)
    setProgress(0)
    setError(null)

    const current = currentSlotRef.current
    const next = nextSlotRef.current
    if (current) releaseAudioSlot(current)
    if (next) releaseAudioSlot(next)

    const preferredIndex = selectedCardId
      ? tracks.findIndex((track) => track.card.id === selectedCardId)
      : -1
    const nextIndex = preferredIndex >= 0 ? preferredIndex : 0
    trackIndexRef.current = nextIndex
    setTrackIndex(nextIndex)

    if (!current || !tracks.length) {
      setIsLoading(false)
      return
    }

    // Do not touch IndexedDB until the user explicitly starts playback. This
    // keeps entering HomePage and changing the preview card cheap, especially
    // for complete packages that also contain full-length audio.
    setIsLoading(false)
  }, [cancelTransition, selectedCardId, tracks])

  const beginTransition = useCallback(async () => {
    const current = currentSlotRef.current
    const next = nextSlotRef.current
    if (!current || !next || !tracks.length || transitionStartedRef.current || !isPlayingRef.current) return

    const fromIndex = trackIndexRef.current
    const nextIndex = (fromIndex + 1) % tracks.length
    const generation = generationRef.current
    transitionStartedRef.current = true

    try {
      await loadSlot(next, nextIndex, generation)
      if (generation !== generationRef.current || !isPlayingRef.current) {
        transitionStartedRef.current = false
        return
      }

      const fromAudio = current.audio
      const nextAudio = next.audio
      nextAudio.currentTime = 0
      nextAudio.volume = 0
      await nextAudio.play()
      if (generation !== generationRef.current || !isPlayingRef.current) {
        transitionStartedRef.current = false
        nextAudio.pause()
        return
      }

      const startedAt = performance.now()
      const animate = (now: number) => {
        if (generation !== generationRef.current || !transitionStartedRef.current || !isPlayingRef.current) return
        const ratio = Math.min(1, (now - startedAt) / CROSSFADE_MS)
        fromAudio.volume = volumeRef.current * (1 - ratio)
        nextAudio.volume = volumeRef.current * ratio
        if (ratio < 1) {
          transitionFrameRef.current = window.requestAnimationFrame(animate)
          return
        }

        transitionFrameRef.current = null
        fromAudio.pause()
        fromAudio.currentTime = 0
        fromAudio.volume = volumeRef.current
        currentSlotRef.current = next
        nextSlotRef.current = current
        trackIndexRef.current = nextIndex
        setTrackIndex(nextIndex)
        setProgress(Math.min(PREVIEW_SECONDS, nextAudio.currentTime))
        transitionStartedRef.current = false
        const preloadIndex = (nextIndex + 1) % tracks.length
        void loadSlot(current, preloadIndex, generation).catch(() => undefined)
      }
      transitionFrameRef.current = window.requestAnimationFrame(animate)
    } catch (transitionError: unknown) {
      transitionStartedRef.current = false
      setError(playbackError(transitionError))
    }
  }, [loadSlot, tracks.length])

  useEffect(() => {
    transitionHandlerRef.current = () => {
      void beginTransition()
    }
  }, [beginTransition])

  useEffect(() => {
    if (!isPlaying) return
    const timer = window.setInterval(() => {
      const current = currentSlotRef.current
      if (!current) return
      const currentTime = current.audio.currentTime
      setProgress(Math.min(PREVIEW_SECONDS, currentTime))
      if (currentTime >= PREVIEW_SECONDS - CROSSFADE_SECONDS) void beginTransition()
    }, 100)
    return () => window.clearInterval(timer)
  }, [beginTransition, isPlaying])

  useEffect(() => {
    const current = currentSlotRef.current
    const next = nextSlotRef.current
    if (current && !transitionStartedRef.current) current.audio.volume = volumeRef.current
    if (next && !transitionStartedRef.current) next.audio.volume = 0
  }, [volume])

  const togglePlayback = useCallback(async () => {
    const current = currentSlotRef.current
    const currentIndex = trackIndexRef.current
    if (!current || !tracks.length) {
      setError('请先导入包含歌曲的本地牌组')
      return
    }
    if (isPlayingRef.current) {
      cancelTransition()
      current.audio.pause()
      isPlayingRef.current = false
      setIsPlaying(false)
      return
    }

    const generation = generationRef.current
    setIsLoading(true)
    try {
      await loadSlot(current, currentIndex, generation)
      if (generation !== generationRef.current) return
      current.audio.volume = volumeRef.current
      await current.audio.play()
      if (generation !== generationRef.current) return
      isPlayingRef.current = true
      setIsPlaying(true)
      setIsLoading(false)
      setError(null)
      const next = nextSlotRef.current
      if (next) void loadSlot(next, (currentIndex + 1) % tracks.length, generation).catch(() => undefined)
    } catch (playError: unknown) {
      isPlayingRef.current = false
      setIsPlaying(false)
      setIsLoading(false)
      setError(playbackError(playError))
    }
  }, [cancelTransition, loadSlot, tracks.length])

  const playNext = useCallback(async () => {
    if (!tracks.length) return
    const wasPlaying = isPlayingRef.current
    const generation = ++generationRef.current
    cancelTransition()
    isPlayingRef.current = false
    setIsPlaying(false)
    setIsLoading(true)
    const current = currentSlotRef.current
    const next = nextSlotRef.current
    if (!current || !next) {
      setIsLoading(false)
      return
    }
    releaseAudioSlot(current)
    releaseAudioSlot(next)
    const nextIndex = (trackIndexRef.current + 1) % tracks.length
    trackIndexRef.current = nextIndex
    setTrackIndex(nextIndex)
    setProgress(0)
    try {
      await loadSlot(current, nextIndex, generation)
      if (generation !== generationRef.current) return
      if (wasPlaying) {
        current.audio.volume = volumeRef.current
        await current.audio.play()
        isPlayingRef.current = true
        setIsPlaying(true)
      }
      setIsLoading(false)
      const preloadIndex = (nextIndex + 1) % tracks.length
      void loadSlot(next, preloadIndex, generation).catch(() => undefined)
    } catch (skipError: unknown) {
      setIsLoading(false)
      setError(playbackError(skipError))
    }
  }, [cancelTransition, loadSlot, tracks.length])

  const currentTrack = tracks[trackIndex] || null
  const hasTracks = tracks.length > 0
  const status = error || (isLoading ? '正在准备音频…' : isPlaying ? '播放中 · 30 秒后交叉淡化' : hasTracks ? '点击播放试听' : '请先导入本地牌组')

  return (
    <section className={`home-live-card${isPlaying ? ' playing' : ''}`} aria-label="首页歌曲试听">
      <span className="home-live-card-label">NOW PLAYING</span>
      <strong>{currentTrack?.card.workName || 'SELECT A SONG'}</strong>
      <span className="home-player-song">
        {currentTrack?.song.displayName || deck?.name || '本地歌牌曲库'}
      </span>
      <div className="home-player-progress" aria-label="试听进度">
        <progress value={progress} max={PREVIEW_SECONDS} />
        <span>{Math.floor(progress)} / {PREVIEW_SECONDS}s</span>
      </div>
      <div className="home-player-actions">
        <button className="home-player-button primary" type="button" onClick={() => void togglePlayback()} disabled={!hasTracks || isLoading}>
          {isPlaying ? '暂停' : '播放试听'}
        </button>
        <button className="home-player-button" type="button" onClick={() => void playNext()} disabled={!hasTracks || isLoading}>
          下一首
        </button>
      </div>
      <label className="home-player-volume">
        <span>音量</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(clampVolume(volume) * 100)}
          onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
          aria-label="试听音量"
        />
      </label>
      <span className={`home-player-status${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
        {status}
      </span>
    </section>
  )
}
