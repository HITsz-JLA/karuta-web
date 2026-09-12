import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { OnlineCardTile } from '../components/OnlineCardTile'
import { OnlineHall } from './online/OnlineHall'
import { OnlineDraftBan, OnlineDraftSelect, OnlineRoomLobby } from './online/OnlineRoomPhases'
import {
  type OnlineCardView,
  type OnlinePlayerId,
  type OnlineRoomSummary,
  type OnlineRoundResult,
  type OnlineRoundPrepare,
  type OnlineRoundStart,
  type OnlineRoomView,
  type OnlineServerMessage,
} from '../lib/onlineProtocol'
import { OnlineSocket, type OnlineDisconnectReason } from '../lib/onlineSocket'
import { preloadOnlineAudio, preloadOnlineAudioMany } from '../lib/onlineAudio'
import './online/online.css'
import {
  CURATED_SERVER_PACKAGES,
  getServerPackageCatalog,
  listServerPackages,
  type ServerPackage,
  type ServerPackageCatalog,
} from '../lib/serverPackages'
import {
  BAN_SIZE,
  BATTLE_ANIMATION_DEDUPE_WINDOW_MS,
  BATTLE_ANIMATION_DURATION_MS,
  BATTLE_STYLE_STORAGE_KEY,
  DEFAULT_CANDIDATE_CARDS,
  DRAFT_SELECTION_SIZE,
  EMPTY_CARD_KEYS,
  MAX_BATTLE_ANIMATION_QUEUE,
  MATCH_AUDIO_CONCURRENCY,
  MAX_CANDIDATE_CARDS,
  MAX_HAND_SLOTS,
  MIN_CANDIDATE_CARDS,
  ONLINE_VOLUME_STORAGE_KEY,
  REST_AUDIO_VOLUME,
} from './online/onlineConstants'
import type { AudioStatus, BattleAnimation, BattleAnimationPayload, BattleStyle, ClaimState } from './online/onlineTypes'
import {
  acknowledgeRoundAudio,
  resetRoundPlaybackToStart,
  battleAnimationKey,
  clampOnlineVolume,
  createLayoutAnimation,
  createSilentAudioUrl,
  isMediaPlayable,
  mediaHasUrl,
  mirrorBoardLayout,
  otherPlayer,
  readBattleStyle,
  readNickname,
  readOnlineVolume,
  scheduleCountdown,
  syncRoundPlayback,
  waitForMediaReady,
} from './online/onlineHelpers'
import {
  BattleAnimationOverlay,
  HandArea,
  NetworkFairness,
  OnlineVolumeControl,
  ScoreCard,
  SpectatorMatchView,
  TransferPanel,
} from './online/onlineViews'
import { useOnlineBoardDrag } from './online/useOnlineBoardDrag'

export function OnlinePage() {
  const [socket] = useState(() => new OnlineSocket())
  const [serverPackages, setServerPackages] = useState<ServerPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [catalog, setCatalog] = useState<ServerPackageCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const onlinePackages = useMemo(
    () =>
      CURATED_SERVER_PACKAGES.map((meta) => ({
        meta,
        serverPackage: serverPackages.find((item) => item.id === meta.id),
      })).filter(
        (item): item is {
          meta: (typeof CURATED_SERVER_PACKAGES)[number]
          serverPackage: ServerPackage
        } => Boolean(item.serverPackage),
      ),
    [serverPackages],
  )
  const activePackageId = onlinePackages.some(({ serverPackage }) => serverPackage.id === selectedPackageId)
    ? selectedPackageId
    : onlinePackages[0]?.serverPackage.id || ''
  const selectedPackage = onlinePackages.find(({ serverPackage }) => serverPackage.id === activePackageId) || null
  const [room, setRoom] = useState<OnlineRoomView | null>(null)
  const [rooms, setRooms] = useState<OnlineRoomSummary[]>([])
  const [nickname, setNickname] = useState(readNickname)
  const [roomName, setRoomName] = useState('校园歌牌房间')
  const [joinCode, setJoinCode] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [boardCount, setBoardCount] = useState(DEFAULT_CANDIDATE_CARDS)
  const [keyword, setKeyword] = useState('')
  const [roundPreparation, setRoundPreparation] = useState<OnlineRoundPrepare | null>(null)
  const [round, setRound] = useState<OnlineRoundStart | null>(null)
  const [lastResult, setLastResult] = useState<OnlineRoundResult | null>(null)
  const [matchOver, setMatchOver] = useState<Extract<OnlineServerMessage, { t: 'matchOver' }> | null>(null)
  const [battleAnimation, setBattleAnimation] = useState<BattleAnimation | null>(null)
  const [myClaim, setMyClaim] = useState<ClaimState | null>(null)
  const [opponentClaim, setOpponentClaim] = useState<ClaimState | null>(null)
  const [claimsByPlayer, setClaimsByPlayer] = useState<Record<OnlinePlayerId, ClaimState | null>>({ A: null, B: null })
  const [roundRemaining, setRoundRemaining] = useState(0)
  const [restRemaining, setRestRemaining] = useState(0)
  const [arrangeReadyRemaining, setArrangeReadyRemaining] = useState(0)
  const [restReadyRemaining, setRestReadyRemaining] = useState(0)
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('idle')
  const [audioRetryNonce, setAudioRetryNonce] = useState(0)
  const [localAudioReady, setLocalAudioReady] = useState(false)
  const [matchAudio, setMatchAudio] = useState<{ urls: string[]; total: number } | null>(null)
  const [matchAudioLoaded, setMatchAudioLoaded] = useState(0)
  const matchAudioReadySentRef = useRef<string | null>(null)
  const [onlineVolume, setOnlineVolumeState] = useState(readOnlineVolume)
  const [connected, setConnected] = useState(socket.connected)
  const [disconnectReason, setDisconnectReason] = useState<OnlineDisconnectReason | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const roomRef = useRef<OnlineRoomView | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const onlineVolumeRef = useRef(onlineVolume)
  const audioUnlockedRef = useRef(false)
  const audioUnlockingRef = useRef(false)
  const audioGenerationRef = useRef(0)
  const battleAnimationIdRef = useRef(0)
  const battleAnimationTimerRef = useRef<number | null>(null)
  const battleAnimationRef = useRef<BattleAnimation | null>(null)
  const battleAnimationQueueRef = useRef<BattleAnimation[]>([])
  const recentBattleAnimationKeysRef = useRef(new Map<string, number>())
  const pendingLocalLayoutKeysRef = useRef(new Map<string, number>())
  const clearDragRef = useRef<() => void>(() => {})
  const [boardSlots, setBoardSlots] = useState<Array<string | null>>(() => Array(MAX_HAND_SLOTS).fill(null))
  const [draftSelection, setDraftSelection] = useState<Set<string>>(new Set())
  const [draftBans, setDraftBans] = useState<Set<string>>(new Set())
  const [arrangeRemaining, setArrangeRemaining] = useState(0)
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set())
  const [pinMode, setPinMode] = useState(false)
  const [battleStyle, setBattleStyle] = useState<BattleStyle>(readBattleStyle)
  const announcedArrangeReadyRef = useRef<number | null>(null)
  const announcedRestReadyRef = useRef<number | null>(null)
  const publishedLayoutRoundRef = useRef<number | null>(null)
  const phaseRef = useRef<OnlineRoomView['phase'] | null>(null)
  const roomCards = useMemo(() => room?.cards || [], [room?.cards])
  const viewerId: OnlinePlayerId = room?.you || 'A'
  const ownHandKeys = room?.players[viewerId]?.handCardKeys || EMPTY_CARD_KEYS
  const ownHandSignature = ownHandKeys.join('\u0000')
  const roundRef = useRef<OnlineRoundStart | null>(round)
  const roundPreparationRef = useRef<OnlineRoundPrepare | null>(roundPreparation)
  const myClaimRef = useRef<ClaimState | null>(myClaim)
  const localAudioUrlRef = useRef<{ source: string; url: string } | null>(null)
  const audioReadySentRef = useRef<string | null>(null)

  const clearBattleAnimations = useCallback(() => {
    battleAnimationQueueRef.current.length = 0
    recentBattleAnimationKeysRef.current.clear()
    pendingLocalLayoutKeysRef.current.clear()
    battleAnimationRef.current = null
    if (battleAnimationTimerRef.current !== null) window.clearTimeout(battleAnimationTimerRef.current)
    battleAnimationTimerRef.current = null
    setBattleAnimation(null)
  }, [])

  const showBattleAnimation = useCallback((payload: BattleAnimationPayload) => {
    const key = battleAnimationKey(payload)
    const now = Date.now()
    for (const [recentKey, timestamp] of recentBattleAnimationKeysRef.current) {
      if (now - timestamp >= BATTLE_ANIMATION_DEDUPE_WINDOW_MS) recentBattleAnimationKeysRef.current.delete(recentKey)
    }
    const active = battleAnimationRef.current
    if (active && battleAnimationKey(active) === key) return
    if (battleAnimationQueueRef.current.some((queued) => battleAnimationKey(queued) === key)) return
    const previousTimestamp = recentBattleAnimationKeysRef.current.get(key)
    if (previousTimestamp !== undefined && now - previousTimestamp < BATTLE_ANIMATION_DEDUPE_WINDOW_MS) return
    recentBattleAnimationKeysRef.current.set(key, now)

    const id = battleAnimationIdRef.current + 1
    battleAnimationIdRef.current = id
    const next = { ...payload, id } as BattleAnimation
    if (active) {
      battleAnimationQueueRef.current.push(next)
      if (battleAnimationQueueRef.current.length > MAX_BATTLE_ANIMATION_QUEUE) battleAnimationQueueRef.current.shift()
      return
    }
    battleAnimationRef.current = next
    setBattleAnimation(next)
  }, [])

  useEffect(() => {
    if (!battleAnimation) return
    if (battleAnimationTimerRef.current !== null) window.clearTimeout(battleAnimationTimerRef.current)
    const animationId = battleAnimation.id
    const timer = window.setTimeout(() => {
      if (battleAnimationRef.current?.id !== animationId) return
      battleAnimationTimerRef.current = null
      const next = battleAnimationQueueRef.current.shift() || null
      battleAnimationRef.current = next
      setBattleAnimation(next)
    }, BATTLE_ANIMATION_DURATION_MS)
    battleAnimationTimerRef.current = timer
    return () => {
      if (battleAnimationTimerRef.current === timer) {
        window.clearTimeout(timer)
        battleAnimationTimerRef.current = null
      }
    }
  }, [battleAnimation])

  useEffect(() => {
    roundRef.current = round
    roundPreparationRef.current = roundPreparation
    myClaimRef.current = myClaim
  }, [myClaim, round, roundPreparation])

  function playReadyCue() {
    try {
      const context = audioContextRef.current || new AudioContext()
      audioContextRef.current = context
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const startAt = context.currentTime
      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, startAt)
      gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.24)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(startAt)
      oscillator.stop(startAt + 0.25)
      void context.resume().catch(() => undefined)
    } catch {
      // The visual countdown remains available when Web Audio is unsupported.
    }
  }

  useEffect(() => {
    let cancelled = false
    setPackagesLoading(true)
    void listServerPackages()
      .then((packages) => {
        if (!cancelled) setServerPackages(packages)
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '无法读取服务器牌组')
      })
      .finally(() => {
        if (!cancelled) setPackagesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setOnlineVolume = useCallback((value: number) => {
    const nextVolume = clampOnlineVolume(value)
    onlineVolumeRef.current = nextVolume
    setOnlineVolumeState(nextVolume)
    try {
      localStorage.setItem(ONLINE_VOLUME_STORAGE_KEY, String(nextVolume))
    } catch {
      // Persisting the preference is optional.
    }
  }, [])

  useEffect(() => {
    if (!activePackageId) {
      setCatalog(null)
      setCatalogLoading(false)
      return
    }
    let cancelled = false
    setCatalog(null)
    setCatalogLoading(true)
    void getServerPackageCatalog(activePackageId)
      .then((nextCatalog) => {
        if (!cancelled) setCatalog(nextCatalog)
      })
      .catch((error) => {
        if (!cancelled) {
          setCatalog(null)
          setMessage(error instanceof Error ? error.message : '无法读取服务器牌组目录')
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activePackageId])

  useEffect(() => {
    const cards = catalog?.cards || []
    const available = Math.min(MAX_CANDIDATE_CARDS, cards.length)
    const nextSize = available
    setBoardCount(nextSize || DEFAULT_CANDIDATE_CARDS)
    setSelectedIds(new Set(cards.slice(0, Math.min(nextSize || DEFAULT_CANDIDATE_CARDS, MAX_CANDIDATE_CARDS)).map((card) => card.key)))
  }, [catalog])

  useEffect(() => {
    try {
      localStorage.setItem('karuta-online-nickname', nickname.trim().slice(0, 20))
    } catch {
      // The nickname is a convenience only.
    }
  }, [nickname])

  useEffect(() => {
    try {
      localStorage.setItem(BATTLE_STYLE_STORAGE_KEY, battleStyle)
    } catch {
      // The view preference is optional.
    }
  }, [battleStyle])

  useEffect(() => {
    const offMessage = socket.on((incoming) => {
      switch (incoming.t) {
        case 'roomList':
          setRooms(incoming.rooms)
          break
        case 'room':
          const previousPhase = phaseRef.current
          const previousRoom = roomRef.current
          for (const playerId of ['A', 'B'] as const) {
            const before = previousRoom?.players[playerId]?.layoutCardKeys
            const after = incoming.room.players[playerId]?.layoutCardKeys
            const layoutAnimation = createLayoutAnimation(before, after, playerId)
            if (layoutAnimation) {
              const key = battleAnimationKey(layoutAnimation)
              const pendingUntil = pendingLocalLayoutKeysRef.current.get(key)
              if (pendingUntil !== undefined) {
                pendingLocalLayoutKeysRef.current.delete(key)
                if (pendingUntil >= Date.now()) continue
              }
              showBattleAnimation(layoutAnimation)
            }
          }
          phaseRef.current = incoming.room.phase
          roomRef.current = incoming.room
          setRoom(incoming.room)
          if (previousPhase === 'arrange' && incoming.room.phase !== 'arrange') {
            clearDragRef.current()
          }
          setLastResult((previous) => (incoming.room.phase === 'playing' ? previous : null))
          if (incoming.room.phase === 'lobby') {
            setRoundPreparation(null)
            setRound(null)
            setMatchOver(null)
            setClaimsByPlayer({ A: null, B: null })
            setDraftSelection(new Set())
            setDraftBans(new Set())
          } else if (incoming.room.phase === 'draft_select' && previousPhase !== 'draft_select') {
            setDraftSelection(new Set(incoming.room.draft.selectedCardKeys))
            setDraftBans(new Set())
          } else if (incoming.room.phase === 'draft_ban' && previousPhase !== 'draft_ban') {
            setDraftBans(new Set(incoming.room.draft.bannedCardKeys))
          }
          break
        case 'network':
          break
        case 'peer':
          setRoom((previous) => {
            const player = previous?.players[incoming.playerId]
            if (!previous || !player || player.connected === incoming.connected) return previous
            return {
              ...previous,
              players: {
                ...previous.players,
                [incoming.playerId]: { ...player, connected: incoming.connected },
              },
            }
          })
          break
        case 'matchAudio':
          matchAudioReadySentRef.current = null
          setMatchAudio({
            urls: incoming.tracks.map((track) => track.audioUrl),
            total: incoming.total || incoming.tracks.length,
          })
          setMatchAudioLoaded(0)
          break
        case 'roundPrepare':
          clearBattleAnimations()
          audioReadySentRef.current = null
          setRoundPreparation(incoming)
          setRound(null)
          setRoundRemaining(0)
          setLastResult(null)
          setMatchOver(null)
          setMyClaim(null)
          setOpponentClaim(null)
          setClaimsByPlayer({ A: null, B: null })
          break
        case 'roundStart':
          clearBattleAnimations()
          setRoundPreparation(null)
          setRound(incoming)
          setLastResult(null)
          setMatchOver(null)
          setMyClaim(null)
          setOpponentClaim(null)
          setClaimsByPlayer({ A: null, B: null })
          setRoundRemaining(0)
          clearDragRef.current()
          break
        case 'claimFeedback':
          const nextClaim = { cardKey: incoming.cardKey, correct: incoming.correct }
          setClaimsByPlayer((previous) => ({ ...previous, [incoming.playerId]: nextClaim }))
          if (roomRef.current?.you && incoming.playerId === roomRef.current.you) {
            setMyClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          } else {
            setOpponentClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          }
          showBattleAnimation({
            kind: incoming.correct ? 'claim' : 'wrong',
            playerId: incoming.playerId,
            cardKey: incoming.cardKey,
          })
          if (!incoming.correct) setRound(null)
          break
        case 'cardTransfer':
          setMyClaim(null)
          setOpponentClaim(null)
          setClaimsByPlayer({ A: null, B: null })
          setMessage(
            incoming.to === roomRef.current?.you
              ? incoming.automatic
                ? '对手未及时选牌，系统随机转来一张牌'
                : '对手已转来一张牌，可以继续抢牌'
              : incoming.automatic
                ? '已自动向对手转牌'
                : '已向对手转牌',
          )
          showBattleAnimation({
            kind: 'transfer',
            from: incoming.from,
            to: incoming.to,
            cardKey: incoming.cardKey,
            automatic: Boolean(incoming.automatic),
          })
          break
        case 'roundResult':
          if (incoming.cardKey && incoming.reason !== 'wrong') {
            showBattleAnimation({ kind: 'discard', winner: incoming.winner, cardKey: incoming.cardKey })
          }
          setLastResult(incoming)
          setRoundPreparation(null)
          setRound(null)
          setMyClaim(null)
          setOpponentClaim(null)
          setClaimsByPlayer({ A: null, B: null })
          break
        case 'matchOver':
          setMatchOver(incoming)
          setRoundPreparation(null)
          setRound(null)
          setClaimsByPlayer({ A: null, B: null })
          break
        case 'error':
          setMessage(incoming.message)
          if (incoming.code === 'room_closed' || incoming.code === 'spectate_unavailable' || incoming.code === 'spectators_full') {
            socket.clearResume()
            phaseRef.current = null
            roomRef.current = null
            setRoom(null)
            setRoundPreparation(null)
            setRound(null)
            setLastResult(null)
            setMatchOver(null)
            setClaimsByPlayer({ A: null, B: null })
            clearBattleAnimations()
            void socket.send({ t: 'listRooms' })
          }
          break
        default:
          break
      }
    })
    const offStatus = socket.onStatus((nextConnected, reason) => {
      setConnected(nextConnected)
      setDisconnectReason(nextConnected ? null : reason || 'network')
      if (!nextConnected) {
        audioReadySentRef.current = null
        matchAudioReadySentRef.current = null
        // Incremental events may be missed while the socket is down. The next
        // room snapshot/replay is authoritative. Keep the round visible while
        // reconnecting so the player is not left with an empty, non-actionable
        // board; replayed server state will replace it when the socket returns.
        setMyClaim(null)
        setOpponentClaim(null)
        setClaimsByPlayer({ A: null, B: null })
        clearBattleAnimations()
        setMessage((previous) =>
          reason === 'replaced' ? '此房间已在其他页面恢复连接，当前页面已停止重连' : previous || '连接已断开，正在尝试恢复对局…',
        )
      } else {
        setMessage((previous) =>
          previous === '连接已断开，正在尝试恢复对局…' || previous === '无法连接在线歌牌服务，请确认服务器已启动'
            ? null
            : previous,
        )
      }
    })
    void socket
      .connect()
      .then(() => socket.send({ t: 'listRooms' }))
      .catch((error) => setMessage(error instanceof Error ? error.message : '在线服务不可用'))
    return () => {
      offMessage()
      offStatus()
      socket.close()
    }
  }, [clearBattleAnimations, showBattleAnimation, socket])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.setAttribute('playsinline', 'true')
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
      const localAudio = localAudioUrlRef.current
      if (localAudio) URL.revokeObjectURL(localAudio.url)
      localAudioUrlRef.current = null
      void audioContextRef.current?.close().catch(() => undefined)
      audioContextRef.current = null
    }
  }, [])

  const listenUrl =
    room?.phase === 'playing' && !matchOver ? round?.audioUrl || roundPreparation?.audioUrl || null : null
  const restClockActive = Boolean(
    room?.phase === 'playing' &&
      !listenUrl &&
      room.restEndsAtServerTime &&
      restRemaining > 0 &&
      !matchOver,
  )
  const restActive = restClockActive
  const audioSource = listenUrl || (restClockActive ? room?.restAudioUrl || null : null)
  const audioRole = listenUrl ? 'listen' : audioSource ? 'rest' : null
  const playId = listenUrl ? (round?.playId ?? round?.roundNo ?? roundPreparation?.playId ?? roundPreparation?.roundNo ?? null) : null
  const audioSession = audioSource ? `${audioRole}:${playId || 'rest'}:${audioSource}` : null

  useEffect(() => {
    const audio = audioRef.current
    const source = audioSource
    const session = audioSession
    const role = audioRole
    const generation = audioGenerationRef.current + 1
    audioGenerationRef.current = generation
    if (!source || !session || !audio) {
      if (audio) audio.pause()
      setLocalAudioReady(false)
      setAudioStatus(audioUnlockedRef.current ? 'ready' : 'idle')
      return
    }

    const cached = localAudioUrlRef.current
    const attachedToSource = Boolean(cached && cached.source === source && mediaHasUrl(audio, cached.url))
    if (!attachedToSource) {
      setAudioStatus('loading')
      setLocalAudioReady(false)
      audio.pause()
    }
    let cancelled = false

    const prepare = async () => {
      try {
        const existing = localAudioUrlRef.current
        let localUrl = existing?.source === source ? existing.url : null
        if (!localUrl) {
          const blob = await preloadOnlineAudio(source)
          if (cancelled || generation !== audioGenerationRef.current) return
          localUrl = URL.createObjectURL(blob)
          const previous = localAudioUrlRef.current
          localAudioUrlRef.current = { source, url: localUrl }
          if (previous && previous.url !== localUrl) URL.revokeObjectURL(previous.url)
        }
        if (!localUrl || cancelled || generation !== audioGenerationRef.current) return

        if (!mediaHasUrl(audio, localUrl)) audio.src = localUrl
        // Reload even when the URL is unchanged. This is required after a
        // decode/network error; otherwise the retry button only re-runs the
        // promise and leaves the media element stuck in its error state.
        audio.preload = 'auto'
        audio.load()
        audio.muted = false
        audio.volume = onlineVolumeRef.current * (role === 'rest' ? REST_AUDIO_VOLUME : 1)
        if (role === 'rest' || !attachedToSource) resetRoundPlaybackToStart(audio)
        await waitForMediaReady(audio)
        if (cancelled || generation !== audioGenerationRef.current) return
        setLocalAudioReady(true)

        if (role === 'listen') {
          const preparing = Boolean(roundPreparationRef.current && !roundRef.current)
          if (preparing) {
            setAudioStatus('loaded')
            const prepared = roundPreparationRef.current
            if (prepared && roomRef.current?.you) {
              acknowledgeRoundAudio(socket, prepared.roundNo, prepared.audioUrl, audioReadySentRef)
            }
          }
          return
        }

        resetRoundPlaybackToStart(audio)
        try {
          await audio.play()
          if (generation === audioGenerationRef.current) {
            audioUnlockedRef.current = true
            setAudioStatus('playing')
          }
        } catch (error: unknown) {
          if (generation !== audioGenerationRef.current) return
          setAudioStatus(error instanceof DOMException && error.name === 'NotAllowedError' ? 'blocked' : 'error')
        }
      } catch (error: unknown) {
        if (cancelled || generation !== audioGenerationRef.current) return
        setLocalAudioReady(false)
        setAudioStatus('error')
        setMessage(error instanceof Error ? error.message : '音频预加载失败，请点击重试')
      }
    }

    void prepare()
    return () => {
      cancelled = true
      audio.pause()
    }
  }, [audioRetryNonce, audioRole, audioSession, audioSource, socket])

  useEffect(() => {
    const audio = audioRef.current
    if (audioRole !== 'listen' || !round || !audio) return
    let cancelled = false
    let playTimer: number | null = null

    const start = () => {
      if (!localAudioReady && !isMediaPlayable(audio)) return
      audio.muted = false
      audio.volume = onlineVolumeRef.current
      const localStart = socket.toLocalTime(round.startAtServerTime)
      playTimer = window.setTimeout(() => {
        if (cancelled) return
        const elapsedMs = Math.max(0, Date.now() - localStart)
        if (elapsedMs > round.windowMs) return
        if (!syncRoundPlayback(audio, elapsedMs)) return
        void audio
          .play()
          .then(() => {
            if (cancelled) return
            audioUnlockedRef.current = true
            setAudioStatus('playing')
          })
          .catch((error: unknown) => {
            if (cancelled) return
            setAudioStatus(error instanceof DOMException && error.name === 'NotAllowedError' ? 'blocked' : 'error')
          })
      }, Math.max(0, localStart - Date.now()))
    }

    start()
    return () => {
      cancelled = true
      if (playTimer !== null) window.clearTimeout(playTimer)
      audio.pause()
    }
  }, [audioRole, localAudioReady, playId, round, socket])

  useEffect(() => {
    if (!connected || round || room?.spectator || !localAudioReady) return
    const prepared = roundPreparation
    if (!prepared || !room?.you) return
    acknowledgeRoundAudio(socket, prepared.roundNo, prepared.audioUrl, audioReadySentRef)
  }, [connected, localAudioReady, round, roundPreparation, room?.spectator, room?.you, socket])

  useEffect(() => {
    if (!connected || !matchAudio?.urls.length || room?.spectator || !room?.you) return
    let cancelled = false
    const key = matchAudio.urls.join('\n')
    setMatchAudioLoaded(0)
    void preloadOnlineAudioMany(matchAudio.urls, {
      concurrency: MATCH_AUDIO_CONCURRENCY,
      onProgress: (done, total) => {
        if (!cancelled) setMatchAudioLoaded(Math.min(done, total))
      },
    })
      .then(() => {
        if (cancelled) return
        setMatchAudioLoaded(matchAudio.total)
        if (!connected || !socket.connected || roomRef.current?.spectator || !roomRef.current?.you) return
        if (matchAudioReadySentRef.current === key) return
        if (!socket.send({ t: 'matchAudioReady' })) return
        matchAudioReadySentRef.current = key
      })
      .catch((error: unknown) => {
        if (cancelled) return
        matchAudioReadySentRef.current = null
        setAudioStatus('error')
        setMessage(error instanceof Error ? error.message : '场上音频预加载失败，请点击重试音频')
      })
    return () => {
      cancelled = true
    }
  }, [connected, matchAudio, room?.spectator, room?.you, socket])

  useEffect(() => {
    if (!round) {
      setRoundRemaining(0)
      return
    }
    const localStart = socket.toLocalTime(round.startAtServerTime)
    let stopCountdown: (() => void) | null = null
    let startTimer: number | null = null
    const startCountdown = () => {
      setRoundRemaining(round.windowMs)
      stopCountdown = scheduleCountdown(() => localStart + round.windowMs - Date.now(), setRoundRemaining)
    }
    const delay = localStart - Date.now()
    if (delay > 0) {
      setRoundRemaining(0)
      startTimer = window.setTimeout(startCountdown, delay)
    } else {
      startCountdown()
    }
    return () => {
      if (startTimer !== null) window.clearTimeout(startTimer)
      stopCountdown?.()
    }
  }, [round, socket])

  useEffect(() => {
    onlineVolumeRef.current = onlineVolume
    const audio = audioRef.current
    if (audio) audio.volume = onlineVolume * (audioRole === 'rest' ? REST_AUDIO_VOLUME : 1)
  }, [audioRole, onlineVolume])

  useEffect(() => {
    if (room?.phase !== 'arrange' || !room.draft.arrangeEndsAtServerTime) {
      setArrangeRemaining(0)
      return
    }
    const localEnd = socket.toLocalTime(room.draft.arrangeEndsAtServerTime)
    return scheduleCountdown(() => localEnd - Date.now(), setArrangeRemaining)
  }, [room?.draft.arrangeEndsAtServerTime, room?.phase, socket])

  useEffect(() => {
    if (room?.phase !== 'playing' || !room.restEndsAtServerTime) {
      setRestRemaining(0)
      return
    }
    const localEnd = socket.toLocalTime(room.restEndsAtServerTime)
    return scheduleCountdown(() => localEnd - Date.now(), setRestRemaining)
  }, [room?.phase, room?.restEndsAtServerTime, socket])

  useEffect(() => {
    const launchAt = room?.arrangeReadyStartAtServerTime || null
    if (!launchAt) {
      announcedArrangeReadyRef.current = null
      setArrangeReadyRemaining(0)
      return
    }

    const localLaunchAt = socket.toLocalTime(launchAt)
    const stopCountdown = scheduleCountdown(() => localLaunchAt - Date.now(), setArrangeReadyRemaining)

    if (announcedArrangeReadyRef.current !== launchAt) {
      announcedArrangeReadyRef.current = launchAt
      playReadyCue()
    }

    return stopCountdown
  }, [room?.arrangeReadyStartAtServerTime, socket])

  useEffect(() => {
    const launchAt = room?.restReadyStartAtServerTime || null
    if (!launchAt) {
      announcedRestReadyRef.current = null
      setRestReadyRemaining(0)
      return
    }

    const localLaunchAt = socket.toLocalTime(launchAt)
    const stopCountdown = scheduleCountdown(() => localLaunchAt - Date.now(), setRestReadyRemaining)

    if (announcedRestReadyRef.current !== launchAt) {
      announcedRestReadyRef.current = launchAt
      playReadyCue()
    }

    return stopCountdown
  }, [room?.restReadyStartAtServerTime, socket])

  useEffect(() => {
    const keys = ownHandKeys
    setBoardSlots((previous) => {
      const available = new Set(keys)
      const next = Array<string | null>(MAX_HAND_SLOTS).fill(null)
      for (let index = 0; index < MAX_HAND_SLOTS; index += 1) {
        const key = previous[index]
        if (key && available.has(key)) {
          next[index] = key
          available.delete(key)
        }
      }
      for (const key of keys) {
        if (!available.has(key)) continue
        const slot = next.indexOf(null)
        if (slot < 0) break
        next[slot] = key
        available.delete(key)
      }
      if (next.length === previous.length && next.every((key, index) => key === previous[index])) return previous
      return next
    })
    setPinnedKeys((previous) => {
      const next = new Set([...previous].filter((key) => keys.includes(key)))
      if (next.size === previous.size && [...next].every((key) => previous.has(key))) return previous
      return next
    })
    if (!keys.length) clearDragRef.current()
  }, [ownHandKeys, ownHandSignature])

  const orderedRoomCards = useMemo(() => {
    return roomCards.slice(0, MAX_HAND_SLOTS)
  }, [roomCards])

  const eligibleCards = useMemo(
    () => (catalog?.packageId === activePackageId ? catalog.cards : []),
    [activePackageId, catalog],
  )
  const visibleCards = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    if (!query) return eligibleCards
    return eligibleCards.filter(
      (card) => card.workName.toLowerCase().includes(query) || String(card.number).includes(query),
    )
  }, [eligibleCards, keyword])
  const me = room ? room.players[viewerId] : null
  const opponent = room ? room.players[otherPlayer(viewerId)] : null
  const opponentHandKeys = opponent?.handCardKeys || EMPTY_CARD_KEYS
  const orderedHandCards = useMemo<Array<OnlineCardView | null>>(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    return boardSlots.map((key) => (key ? byKey.get(key) || null : null))
  }, [boardSlots, roomCards])
  const opponentHandCards = useMemo<Array<OnlineCardView | null>>(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    const slotKeys = mirrorBoardLayout(opponent?.layoutCardKeys || null, opponentHandKeys)
    return slotKeys.map((key) => (key ? byKey.get(key) || null : null))
  }, [opponent?.layoutCardKeys, opponentHandKeys, roomCards])
  const draftPoolCards = useMemo(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    return room?.draft.poolCardKeys.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card)) || []
  }, [room?.draft.poolCardKeys, roomCards])
  const draftExchangeCards = useMemo(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    return room?.draft.exchangeCardKeys.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card)) || []
  }, [room?.draft.exchangeCardKeys, roomCards])
  const isResting = Boolean(
    !listenUrl && (restActive || (room?.phase === 'playing' && restRemaining > 0 && !matchOver)),
  )
  const isGivingCard = Boolean(room?.pendingTransfer?.to === room?.you)
  const canArrange = Boolean(
    (room?.phase === 'arrange' || isResting) && !matchOver && !room?.pendingTransfer && !room?.spectator,
  )

  useEffect(() => {
    if (room?.phase !== 'playing' || room?.spectator) {
      publishedLayoutRoundRef.current = null
      return
    }
    const layoutRevision = round?.roundNo ?? room?.roundNo ?? 0
    if (publishedLayoutRoundRef.current === layoutRevision) return
    if (boardSlots.length !== MAX_HAND_SLOTS || boardSlots.filter(Boolean).length !== ownHandKeys.length) return
    if (!socket.send({ t: 'arrangeLayout', cardKeys: boardSlots })) return
    publishedLayoutRoundRef.current = layoutRevision
  }, [boardSlots, ownHandKeys, room?.phase, room?.roundNo, room?.spectator, round?.roundNo, socket])

  const createRoom = useCallback(async () => {
    if (!selectedPackage || !catalog) {
      setMessage('请先选择服务器牌组')
      return
    }
    const cards = catalog.cards.filter((card) => selectedIds.has(card.key))
    if (cards.length < MIN_CANDIDATE_CARDS) {
      setMessage(`在线歌牌需要选择至少 ${MIN_CANDIDATE_CARDS} 张卡牌；奇数会由服务器随机弃置 1 张后平分`)
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await socket.connect()
      const sent = socket.send({
        t: 'createRoom',
        nickname: nickname.trim() || '玩家',
        name: roomName.trim() || '歌牌房间',
        packageId: selectedPackage.serverPackage.id,
        deckName: selectedPackage.meta.name,
        cardKeys: cards.slice(0, MAX_CANDIDATE_CARDS).map((card) => card.key),
      })
      if (!sent) throw new Error('在线连接已断开，请重试')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建房间失败')
    } finally {
      setBusy(false)
    }
  }, [catalog, nickname, roomName, selectedIds, selectedPackage, socket])

  const joinRoom = useCallback(async () => {
    const code = joinCode.trim().toUpperCase()
    if (!code) {
      setMessage('请输入房间码')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await socket.connect()
      const sent = socket.send({ t: 'joinRoom', code, nickname: nickname.trim() || '玩家' })
      if (!sent) throw new Error('在线连接已断开，请重试')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加入房间失败')
    } finally {
      setBusy(false)
    }
  }, [joinCode, nickname, socket])

  const spectateRoom = useCallback(async (roomCode: string) => {
    const code = roomCode.trim().toUpperCase()
    if (!code) return
    setBusy(true)
    setMessage(null)
    const alreadyConnected = socket.connected
    socket.clearResume()
    socket.setSpectatorRoom(code)
    try {
      await socket.connect()
      if (alreadyConnected && !socket.send({ t: 'spectateRoom', code })) throw new Error('在线连接已断开，请重试')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '进入观战失败')
    } finally {
      setBusy(false)
    }
  }, [socket])

  const leaveRoom = useCallback(() => {
    socket.send({ t: 'leaveRoom' })
    socket.clearResume()
    socket.clearNetworkSnapshot()
    phaseRef.current = null
    roomRef.current = null
    setRoom(null)
    setRound(null)
    setMatchAudio(null)
    setMatchAudioLoaded(0)
    matchAudioReadySentRef.current = null
    setLastResult(null)
    setMatchOver(null)
    clearBattleAnimations()
    setMyClaim(null)
    setOpponentClaim(null)
    setClaimsByPlayer({ A: null, B: null })
    setDraftSelection(new Set())
    setDraftBans(new Set())
    setBoardSlots(Array(MAX_HAND_SLOTS).fill(null))
    setPinnedKeys(new Set())
    setPinMode(false)
    setMessage(null)
    clearDragRef.current()
    void socket.connect().then(() => socket.send({ t: 'listRooms' }))
  }, [clearBattleAnimations, socket])

  const {
    draggingKey,
    dragOverSlot,
    clearDrag,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    selectArrangeCard,
    handleArrangeSlotClick,
  } = useOnlineBoardDrag({
    canArrange,
    pinMode,
    boardSlots,
    setBoardSlots,
    viewerId,
    pendingLocalLayoutKeysRef,
    showBattleAnimation,
  })
  useEffect(() => {
    clearDragRef.current = clearDrag
    return () => {
      if (clearDragRef.current === clearDrag) clearDragRef.current = () => {}
    }
  }, [clearDrag])


  const toggleSelected = useCallback((cardKey: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(cardKey)) next.delete(cardKey)
      else if (next.size < boardCount) next.add(cardKey)
      else setMessage(`本局最多选择 ${boardCount} 张卡牌`)
      return next
    })
  }, [boardCount])

  function setBoardSize(value: number) {
    const input = Number.isFinite(value) ? Math.round(value) : DEFAULT_CANDIDATE_CARDS
    const nextSize = Math.max(MIN_CANDIDATE_CARDS, Math.min(MAX_CANDIDATE_CARDS, input || DEFAULT_CANDIDATE_CARDS))
    setBoardCount(nextSize)
    setSelectedIds((previous) => new Set([...previous].slice(0, nextSize)))
  }

  function selectAllCandidates() {
    const nextSize = Math.min(MAX_CANDIDATE_CARDS, eligibleCards.length)
    setBoardCount(nextSize)
    setSelectedIds(new Set(eligibleCards.slice(0, nextSize).map((card) => card.key)))
  }

  const toggleDraftCard = useCallback((cardKey: string, limit: number, setter: Dispatch<SetStateAction<Set<string>>>) => {
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(cardKey)) next.delete(cardKey)
      else if (next.size < limit) next.add(cardKey)
      else setMessage(`本阶段最多选择 ${limit} 张卡牌`)
      return next
    })
  }, [])

  const submitDraftSelection = useCallback(() => {
    if (draftSelection.size !== DRAFT_SELECTION_SIZE) return
    if (!socket.send({ t: 'selectCards', cardKeys: [...draftSelection] })) setMessage('连接已断开，选牌没有送达')
  }, [draftSelection, socket])

  const submitDraftBan = useCallback(() => {
    if (draftBans.size !== BAN_SIZE) return
    if (!socket.send({ t: 'banCards', cardKeys: [...draftBans] })) setMessage('连接已断开，BAN 没有送达')
  }, [draftBans, socket])

  const toggleDraftSelection = useCallback(
    (cardKey: string) => toggleDraftCard(cardKey, DRAFT_SELECTION_SIZE, setDraftSelection),
    [toggleDraftCard],
  )
  const toggleDraftBan = useCallback(
    (cardKey: string) => toggleDraftCard(cardKey, BAN_SIZE, setDraftBans),
    [toggleDraftCard],
  )

  const togglePinned = useCallback((cardKey: string) => {
    setPinnedKeys((previous) => {
      const next = new Set(previous)
      if (next.has(cardKey)) next.delete(cardKey)
      else next.add(cardKey)
      return next
    })
  }, [])

  function sortOwnHand(mode: 'random' | 'name') {
    setBoardSlots((previous) => {
      const current = previous.filter((key): key is string => Boolean(key && ownHandKeys.includes(key)))
      const movable = current.filter((key) => !pinnedKeys.has(key))
      if (mode === 'random') {
        for (let index = movable.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.floor(Math.random() * (index + 1))
          ;[movable[index], movable[swapIndex]] = [movable[swapIndex], movable[index]]
        }
      } else {
        movable.sort((left, right) => {
          const leftCard = roomCards.find((card) => card.key === left)
          const rightCard = roomCards.find((card) => card.key === right)
          return (leftCard?.workName || '').localeCompare(rightCard?.workName || '', 'zh-CN') || (leftCard?.number || 0) - (rightCard?.number || 0)
        })
      }
      const next = [...previous]
      let movableIndex = 0
      for (let index = 0; index < next.length; index += 1) {
        const key = next[index]
        if (key && !pinnedKeys.has(key)) next[index] = movable[movableIndex++] || null
      }
      return next
    })
  }

  const claimCard = useCallback((cardKey: string) => {
    const currentRoom = roomRef.current
    const currentRound = roundRef.current
    if (!currentRoom || !currentRound || myClaimRef.current || currentRoom.pendingTransfer || (cardKey && !currentRoom.remainingCardKeys.includes(cardKey))) return
    const clientAt = Math.min(
      currentRound.windowMs,
      Math.max(0, Date.now() - socket.toLocalTime(currentRound.startAtServerTime)),
    )
    if (!socket.send({ t: 'claim', roundNo: currentRound.roundNo, cardKey, clientAt })) {
      setMessage('连接已断开，本次抢牌没有送达')
      return
    }
    const nextClaim = { cardKey, correct: null }
    myClaimRef.current = nextClaim
    setMyClaim(nextClaim)
  }, [socket])

  const giveCard = useCallback((cardKey: string) => {
    if (!socket.send({ t: 'giveCard', cardKey })) setMessage('连接已断开，转牌没有送达')
  }, [socket])

  const handleOwnCardClick = useCallback((cardKey: string) => {
    if (isGivingCard) {
      giveCard(cardKey)
      return
    }
    if (canArrange) {
      if (pinMode) togglePinned(cardKey)
      else selectArrangeCard(cardKey)
      return
    }
    claimCard(cardKey)
  }, [canArrange, claimCard, giveCard, isGivingCard, pinMode, selectArrangeCard, togglePinned])

  function toggleReady() {
    if (!room || (!isOpeningArrange && !isResting) || room.pendingTransfer) return
    const currentReady = isOpeningArrange ? me?.arrangeReady : me?.restReady
    if (!socket.send({ t: 'ready', ready: !currentReady })) setMessage('连接已断开，准备状态没有送达')
  }

  const unlockAudio = useCallback(() => {
    if (audioUnlockingRef.current) return
    audioUnlockingRef.current = true
    if (audioStatus === 'error') {
      setAudioRetryNonce((previous) => previous + 1)
      matchAudioReadySentRef.current = null
      setMatchAudio((previous) => (previous ? { urls: previous.urls, total: previous.total } : previous))
    }
    const audio = audioRef.current
    let context = audioContextRef.current
    try {
      if (!context || context.state === 'closed') {
        context = new AudioContext()
        audioContextRef.current = context
      }
      void context.resume().catch(() => undefined)
    } catch {
      context = null
    }

    if (!audio) {
      audioUnlockingRef.current = false
      return
    }

    const isRestAudio = !round && !roundPreparation && Boolean(room?.restAudioUrl)
    if (!round && !isRestAudio) {
      const silentUrl = createSilentAudioUrl()
      const silentAudio = new Audio()
      silentAudio.preload = 'auto'
      silentAudio.muted = true
      silentAudio.src = silentUrl
      silentAudio.load()
      let playPromise: Promise<void>
      try {
        playPromise = silentAudio.play()
      } catch {
        URL.revokeObjectURL(silentUrl)
        audioUnlockingRef.current = false
        setAudioStatus('error')
        return
      }
      void playPromise
        .then(() => {
          audioUnlockedRef.current = true
          setAudioStatus(localAudioReady ? 'loaded' : 'ready')
        })
        .catch(() => setAudioStatus('blocked'))
        .then(() => {
          silentAudio.pause()
          silentAudio.removeAttribute('src')
          silentAudio.load()
          URL.revokeObjectURL(silentUrl)
          audioUnlockingRef.current = false
        })
      return
    }

    audio.muted = false
    if (round) {
      const localStart = socket.toLocalTime(round.startAtServerTime)
      const elapsedMs = Math.max(0, Date.now() - localStart)
      if (elapsedMs > round.windowMs) {
        audioUnlockingRef.current = false
        return
      }
      if (!syncRoundPlayback(audio, elapsedMs)) {
        audioUnlockingRef.current = false
        return
      }
    }
    let playPromise: Promise<void>
    try {
      playPromise = audio.play()
    } catch {
      audioUnlockingRef.current = false
      setAudioStatus('error')
      return
    }
    void playPromise
      .then(() => {
        audioUnlockedRef.current = true
        setAudioStatus('playing')
      })
      .catch((error: unknown) => {
        setAudioStatus(error instanceof DOMException && error.name === 'NotAllowedError' ? 'blocked' : 'error')
      })
      .then(() => {
        audioUnlockingRef.current = false
      })
  }, [audioStatus, localAudioReady, room?.restAudioUrl, round, roundPreparation, socket])

  useEffect(() => {
    const handleGesture = () => {
      if (!audioUnlockedRef.current) unlockAudio()
    }
    window.addEventListener('pointerdown', handleGesture, { passive: true })
    window.addEventListener('keydown', handleGesture)
    return () => {
      window.removeEventListener('pointerdown', handleGesture)
      window.removeEventListener('keydown', handleGesture)
    }
  }, [unlockAudio])

  const audioButtonLabel = audioStatus === 'blocked' ? '点击恢复音频' : audioStatus === 'error' ? '重试音频' : audioStatus === 'playing' ? '音频播放中' : audioStatus === 'loaded' ? '音频已预加载' : audioStatus === 'ready' ? '音频已启用' : '启用音频'
  const reconnectNow = useCallback(() => {
    setMessage('正在重新连接在线服务…')
    void socket
      .reconnect()
      .then(() => setMessage(null))
      .catch((error) => setMessage(error instanceof Error ? error.message : '重连失败，系统会继续自动重试'))
  }, [socket])
  const canReconnect = !connected && disconnectReason !== 'replaced'

  if (!room) {
    return (
      <OnlineHall
        connected={connected}
        audioButtonLabel={audioButtonLabel}
        onUnlockAudio={unlockAudio}
        nickname={nickname}
        onNicknameChange={setNickname}
        roomName={roomName}
        onRoomNameChange={setRoomName}
        packagesLoading={packagesLoading}
        catalogLoading={catalogLoading}
        catalog={catalog}
        activePackageId={activePackageId}
        onPackageChange={setSelectedPackageId}
        onlinePackages={onlinePackages}
        selectedPackage={selectedPackage}
        boardCount={boardCount}
        onBoardCountChange={setBoardSize}
        keyword={keyword}
        onKeywordChange={setKeyword}
        selectedIds={selectedIds}
        eligibleCards={eligibleCards}
        visibleCards={visibleCards}
        onToggleCard={toggleSelected}
        onSelectAll={selectAllCandidates}
        onCreateRoom={() => void createRoom()}
        onJoinRoom={() => void joinRoom()}
        onSpectateRoom={(code) => void spectateRoom(code)}
        joinCode={joinCode}
        onJoinCodeChange={setJoinCode}
        rooms={rooms}
        socket={socket}
        busy={busy}
        message={message}
      />
    )
  }

  if (room.spectator) {
    return (
      <SpectatorMatchView
        room={room}
        round={round}
        lastResult={lastResult}
        claims={claimsByPlayer}
        battleAnimation={battleAnimation}
        connected={connected}
        onReconnect={reconnectNow}
        restRemaining={restRemaining}
        roundRemaining={roundRemaining}
        arrangeRemaining={arrangeRemaining}
        battleStyle={battleStyle}
        onBattleStyle={setBattleStyle}
        onLeave={leaveRoom}
        socket={socket}
        volume={onlineVolume}
        onVolumeChange={setOnlineVolume}
        audioButtonLabel={audioButtonLabel}
        onUnlockAudio={unlockAudio}
        matchOver={matchOver}
      />
    )
  }

  if (room.phase === 'lobby') {
    return (
      <OnlineRoomLobby
        room={room}
        opponent={opponent}
        orderedRoomCards={orderedRoomCards}
        canReconnect={canReconnect}
        onReconnect={reconnectNow}
        onLeave={leaveRoom}
        socket={socket}
        message={message}
      />
    )
  }

  if (room.phase === 'draft_select') {
    return (
      <OnlineDraftSelect
        room={room}
        cards={draftPoolCards}
        selected={draftSelection}
        canReconnect={canReconnect}
        onReconnect={reconnectNow}
        onLeave={leaveRoom}
        onToggle={toggleDraftSelection}
        onSubmit={submitDraftSelection}
        message={message}
      />
    )
  }

  if (room.phase === 'draft_ban') {
    return (
      <OnlineDraftBan
        room={room}
        cards={draftExchangeCards}
        selected={draftBans}
        canReconnect={canReconnect}
        onReconnect={reconnectNow}
        onLeave={leaveRoom}
        onToggle={toggleDraftBan}
        onSubmit={submitDraftBan}
        message={message}
      />
    )
  }

  const resultMeta = lastResult?.cardKey ? room.cards.find((card) => card.key === lastResult.cardKey) || null : null
  const scores = matchOver?.scores || lastResult?.scores || { A: room.players.A?.score || 0, B: room.players.B?.score || 0 }
  const matchIsOver = room.phase === 'over' || Boolean(matchOver)
  const matchWinner = matchOver?.winner || room.matchWinner || null
  const matchRounds = matchOver?.rounds || room.roundNo
  const isOpeningArrange = room.phase === 'arrange'
  const isPreparingRound = Boolean(roundPreparation && !round)
  const canClaim = Boolean(round && !isResting && !myClaim && !lastResult && !room.pendingTransfer && !matchIsOver)
  const restSeconds = Math.ceil(restRemaining / 1000)
  const arrangeReadySeconds = Math.ceil(arrangeReadyRemaining / 1000)
  const restReadySeconds = Math.ceil(restReadyRemaining / 1000)
  const readyRemaining = isOpeningArrange ? arrangeReadyRemaining : restReadyRemaining
  const readySeconds = isOpeningArrange ? arrangeReadySeconds : restReadySeconds
  const waitingMatchAudio = Boolean(room.waitingMatchAudio)
  const matchAudioTotal = room.matchAudioTotal || matchAudio?.total || 0
  const matchAudioProgress = matchAudioTotal > 0 ? `${matchAudioLoaded}/${matchAudioTotal}` : ''
  const matchAudioPending = Boolean(matchAudioTotal && matchAudioLoaded < matchAudioTotal)
  const stageLabel = matchIsOver
    ? '本局结束'
    : isOpeningArrange
      ? waitingMatchAudio
        ? '等待场上音频'
        : '开局排牌'
      : isPreparingRound
        ? '音频准备中'
        : isResting
          ? '休息阶段'
          : round
            ? '听歌抢牌'
            : '对局进行中'
  const isReadyWindow = !matchIsOver && (isOpeningArrange || isResting)
  const restReady = Boolean(me?.restReady)
  const opponentRestReady = Boolean(opponent?.restReady)
  const windowReady = isOpeningArrange ? Boolean(me?.arrangeReady) : restReady
  const opponentWindowReady = isOpeningArrange ? Boolean(opponent?.arrangeReady) : opponentRestReady
  const statusText = matchIsOver
    ? matchWinner
      ? `${room.players[matchWinner]?.nickname || matchWinner} 获胜 · 对局已结束，最终牌区已保留`
      : '双方平手 · 对局已结束，最终牌区已保留'
    : isOpeningArrange
    ? arrangeReadyRemaining > 0
      ? matchAudioPending
        ? `双方已准备 · ${arrangeReadySeconds} 秒后开始 · 场上歌曲 ${matchAudioProgress}`
        : `双方已准备 · ${arrangeReadySeconds} 秒后开始游戏`
      : waitingMatchAudio
        ? `开局已推迟 · 等待双方场上歌曲就绪${matchAudioProgress ? ` · ${matchAudioProgress}` : ''}`
        : matchAudioPending
          ? `排牌准备中 · 场上歌曲 ${matchAudioProgress} · ${Math.ceil(arrangeRemaining / 1000)} 秒后尝试开始`
          : `排牌准备中 · ${Math.ceil(arrangeRemaining / 1000)} 秒后自动开始`
    : isPreparingRound
      ? room.spectator
        ? '观战端正在本地完整预加载本回合音频'
        : me?.audioReady && opponent?.audioReady
          ? '双方音频已完整加载 · 等待服务器播放编号'
          : localAudioReady
            ? '你的音频已完整加载 · 等待对手音频'
            : '正在把本回合音频完整下载到本地'
    : isResting
      ? restReadyRemaining > 0
        ? `双方已准备 · ${restReadySeconds} 秒后开始下一回合`
        : isGivingCard
          ? `休息阶段 · ${restSeconds} 秒内点击自己的牌交给对手`
          : room.pendingTransfer
            ? `休息阶段 · 等待对手交牌（${restSeconds} 秒）`
            : `休息阶段 · ${restSeconds} 秒后进入下一回合`
      : myClaim?.correct === false
        ? room.pendingTransfer?.from === room.you
          ? '你抢错了，等待对手选择一张牌转给你'
          : '你抢错了，等待转牌处理'
        : myClaim?.correct
          ? '抢牌成功，等待结算'
          : opponentClaim
            ? '对手已经出手，等待结算'
            : round
              ? `听歌抢牌 · ${Math.ceil(roundRemaining / 1000)} 秒`
              : '准备下一回合…'

  return (
    <div className={`online-page online-match-page online-style-${battleStyle}`}>
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>{matchIsOver ? '歌牌对战复盘' : isOpeningArrange ? '开局排牌准备' : '歌牌对战进行中'}</h1>
            <p>
              {matchIsOver
                ? `对局已结束 · 第 ${matchRounds} 回合 · 最终牌区已保留`
                : isOpeningArrange
                ? waitingMatchAudio
                  ? `排牌时间已到，等待双方场上音频加载完成后再开局 · ${ownHandKeys.length} 张手牌`
                  : `剩余 ${Math.ceil(arrangeRemaining / 1000)} 秒完成自己的牌区布局 · ${ownHandKeys.length} 张手牌`
                : `第 ${room.roundNo || round?.roundNo || 0} 回合 · 场上实牌 ${room.remainingCardKeys.length} 张`}
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出本局</button>
        </div>
        {matchIsOver ? (
          <div className="status-banner online-match-review-banner" role="status">
            <strong>本局已结束，当前保留最终棋盘供复盘</strong>
            <span>{matchWinner ? `${room.players[matchWinner]?.nickname || matchWinner} 获胜` : '双方平手'} · 共 {matchRounds} 回合</span>
          </div>
        ) : null}
      </section>

      <section className="panel stack online-game-panel">
        <div className="online-game-header">
          <div className="online-game-heading">
            <strong>歌牌棋盘</strong>
            <span className="muted small">服务器歌牌卡面 · 牌位调整只保留在自己的视角</span>
          </div>
          <div className="online-game-header-tools">
            <span className={`connection-chip${connected ? ' online' : ''}`}>
              {connected ? '连接稳定' : '正在重连…'}
            </span>
            {canReconnect ? <button className="btn btn-secondary online-reconnect-button" type="button" onClick={reconnectNow}>立即重连</button> : null}
            <span className="chip">{matchIsOver ? '本局结束' : round ? `第 ${round.roundNo} 回合` : isPreparingRound ? '音频准备中' : isResting ? '休息阶段' : '等待下一回合'}</span>
            <div className="online-style-switch" role="group" aria-label="对战视图">
              <span className="online-style-caption">视图</span>
              <button
                className={`online-style-button${battleStyle === 'text' ? ' active' : ''}`}
                type="button"
                aria-pressed={battleStyle === 'text'}
                onClick={() => setBattleStyle('text')}
              >
                文字注重
              </button>
              <button
                className={`online-style-button${battleStyle === 'card' ? ' active' : ''}`}
                type="button"
                aria-pressed={battleStyle === 'card'}
                onClick={() => setBattleStyle('card')}
              >
                卡面注重
              </button>
            </div>
          </div>
        </div>
        <div className="online-match-layout">
          <div className="online-match-board">
            <HandArea
              title={`对手牌区 · ${opponentHandKeys.length}/${MAX_HAND_SLOTS}`}
              slotCards={opponentHandCards}
              playerId={otherPlayer(viewerId)}
              claimable={canClaim}
              resultKey={lastResult?.cardKey || null}
              wrongKey={opponentClaim?.correct === false ? opponentClaim.cardKey : null}
              pickedKey={opponentClaim?.cardKey || null}
              onCardClick={claimCard}
            />
            <div className="online-board-divider" aria-hidden="true">
              <span />
              <strong>VS</strong>
              <span />
            </div>
            <HandArea
              title={`我方牌区 · ${ownHandKeys.length}/${MAX_HAND_SLOTS}`}
              slotCards={orderedHandCards}
              playerId={viewerId}
              mine
              canArrange={canArrange}
              pinMode={pinMode}
              pinnedKeys={pinnedKeys}
              draggingKey={draggingKey}
              dragOverSlot={dragOverSlot}
              claimable={canClaim}
              giving={isGivingCard}
              resultKey={lastResult?.cardKey || null}
              wrongKey={myClaim?.correct === false ? myClaim.cardKey : null}
              pickedKey={myClaim?.cardKey || null}
              onCardClick={handleOwnCardClick}
              onSlotClick={handleArrangeSlotClick}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onPointerDown={canArrange ? handlePointerDown : undefined}
              onPointerMove={canArrange ? handlePointerMove : undefined}
              onPointerUp={canArrange ? handlePointerUp : undefined}
              onPointerCancel={canArrange ? handlePointerCancel : undefined}
            />
          </div>
          <aside className="online-match-sidebar" aria-label="对局信息">
            <section className="online-sidebar-card online-score-panel">
              <span className="muted small">比分</span>
              <div className="online-sidebar-scores">
                <div><span>对手</span><strong>{scores[otherPlayer(viewerId)]}</strong></div>
                <span className="versus-mark">VS</span>
                <div><strong>{scores[viewerId]}</strong><span>我方</span></div>
              </div>
            </section>
            <section className={`online-sidebar-card online-phase-panel${isResting ? ' resting' : ''}${readyRemaining > 0 ? ' ready-countdown' : ''}`} role="status" aria-live="polite">
              <span className="online-phase-label">{stageLabel}</span>
              <strong className="online-phase-count">
                {matchIsOver
                  ? '—'
                  : isOpeningArrange
                  ? waitingMatchAudio
                    ? '等待音频'
                    : `${arrangeReadyRemaining > 0 ? arrangeReadySeconds : Math.ceil(arrangeRemaining / 1000)} 秒`
                  : isPreparingRound
                    ? '准备中'
                  : isResting
                    ? `${restReadyRemaining > 0 ? restReadySeconds : restSeconds} 秒`
                    : round
                      ? `${Math.ceil(roundRemaining / 1000)} 秒`
                      : '—'}
              </strong>
              <p>{statusText}</p>
            </section>
            <section className="online-sidebar-card online-count-panel">
              <span>场上实牌 <strong>{room.remainingCardKeys.length}</strong> 张</span>
              <span>我方手牌 <strong>{ownHandKeys.length}</strong> 张</span>
                <span>对手手牌 <strong>{opponentHandKeys.length}</strong> 张</span>
                <span>双方牌区均为 3×11 固定槽位</span>
            </section>
            {isReadyWindow ? (
              <div className="online-ready-row">
                <strong>{isOpeningArrange ? '准备开局' : '提前准备'}</strong>
                <div className="online-ready-status">
                  <span className={windowReady ? 'ready' : 'muted'}>{windowReady ? '你已准备' : '你尚未准备'}</span>
                  <span className={opponentWindowReady ? 'ready' : 'muted'}>{opponentWindowReady ? '对手已准备' : '等待对手准备'}</span>
                </div>
                {room.pendingTransfer && isResting ? (
                  <span className="muted small">完成交牌后才能提前准备</span>
                ) : (
                  <button className={`btn btn-secondary online-ready-button${windowReady ? ' active' : ''}`} type="button" onClick={toggleReady}>
                    {windowReady ? (readyRemaining > 0 ? `已准备 · ${readySeconds} 秒` : '取消准备') : isOpeningArrange ? '准备开始游戏' : '准备下一回合'}
                  </button>
                )}
              </div>
            ) : null}
            {readyRemaining > 0 ? (
              <div className="online-ready-launch" role="alert">
                <span>双方已准备</span>
                <strong>{readySeconds}</strong>
                <span>{isOpeningArrange ? '秒后开始游戏' : '秒后开始下一回合'}</span>
              </div>
            ) : null}
            {canArrange ? (
              <section className="online-sidebar-card online-arrange-tools">
                <div className="row spread"><strong>布局工具</strong><span className="muted small">仅自己可见</span></div>
                <p className="muted small">只能调整自己的牌区；拖动时显示全部 33 个槽位。</p>
                <div className="row">
                  <button className="btn btn-secondary" type="button" onClick={() => sortOwnHand('random')}>随机排</button>
                  <button className="btn btn-secondary" type="button" onClick={() => sortOwnHand('name')}>按名称排</button>
                  <button className={`btn btn-secondary${pinMode ? ' active' : ''}`} type="button" onClick={() => setPinMode((previous) => !previous)}>
                    {pinMode ? '完成固定牌位' : '固定牌位'}
                  </button>
                </div>
                {pinMode ? <span className="muted small">点击自己的牌固定/取消固定，再使用排序按钮。</span> : null}
              </section>
            ) : null}
            <NetworkFairness socket={socket} you={room.you} compact />
            <div className="online-audio-control">
              <OnlineVolumeControl volume={onlineVolume} onChange={setOnlineVolume} />
              <button className="btn btn-secondary online-audio-button" type="button" onClick={unlockAudio}>{audioButtonLabel}</button>
              {audioStatus === 'blocked' ? <span className="online-audio-status error" role="alert">浏览器拦截了自动播放，请点击按钮恢复音频。</span> : null}
              {audioStatus === 'error' ? <span className="online-audio-status error" role="alert">音频资源加载失败，请点击重试。</span> : null}
              {audioStatus === 'loading' ? <span className="online-audio-status">音频加载中…</span> : null}
              {audioStatus === 'loaded' ? <span className="online-audio-status">音频已完整加载到本地，等待双方就绪。</span> : null}
            </div>
          </aside>
        </div>
      </section>

      {lastResult && !matchIsOver ? (
        <div className="online-result-overlay" aria-live="polite">
            <section key={`result-${lastResult.roundNo}`} className="panel cool online-result online-modal-card" role="status">
              <div className="row spread">
                <strong>
                  {lastResult.reason === 'wrong'
                    ? '选错处理完成，目标卡牌仍在场上'
                    : lastResult.winner
                      ? lastResult.cardKey
                        ? `${room.players[lastResult.winner]?.nickname || '玩家'} 收取了这张卡`
                        : `${room.players[lastResult.winner]?.nickname || '玩家'} 完成本回合`
                      : '本回合无人收取'}
                </strong>
                <span className="muted small">{lastResult.reason === 'timeout' ? '时间到' : lastResult.reason === 'wrong' ? '选错' : '本回合结算'}</span>
              </div>
              {resultMeta ? (
                <div className="online-result-body">
                  <div className={`online-discard-flight${lastResult.winner ? ` winner-${lastResult.winner}` : ''}`}>
                    <OnlineCardTile meta={resultMeta} available result readOnly showNumber={false} />
                    <span className="online-discard-pile">{lastResult.winner ? `${room.players[lastResult.winner]?.nickname || '玩家'} 的弃牌堆` : '场上'}</span>
                  </div>
                  <div className="stack">
                    <span className="muted small">对应歌曲</span>
                    <strong>{lastResult.song.displayName}</strong>
                    <span className="muted small">下一回合将在休息阶段结束后开始。</span>
                  </div>
                </div>
              ) : (
                <div className="online-neutral-result">
                  <strong>本回合已结算</strong>
                  <span className="muted small">下一回合将在休息阶段结束后开始。</span>
                </div>
              )}
            </section>
        </div>
      ) : null}
      {matchIsOver ? (
        <div className="online-result-overlay online-match-over-overlay" aria-live="polite">
          <section
            key={`match-over-${matchRounds}-${matchWinner || 'draw'}`}
            className="panel cool online-result online-modal-card online-match-over-card"
            role="status"
          >
            <div className="row spread">
              <strong>{matchWinner ? `${room.players[matchWinner]?.nickname || matchWinner} 获胜` : '双方平手'}</strong>
              <span className="muted small">对局结束 · {matchRounds} 回合</span>
            </div>
            <div className="versus-players">
              <ScoreCard player={room.players.A} score={scores.A} winner={matchWinner === 'A'} mine={room.you === 'A'} />
              <span className="versus-mark">VS</span>
              <ScoreCard player={room.players.B} score={scores.B} winner={matchWinner === 'B'} mine={room.you === 'B'} />
            </div>
            <p className="muted small online-match-over-note">最终牌区已保留，可继续查看双方布局与剩余牌。点击上方“退出本局”返回在线大厅。</p>
          </section>
        </div>
      ) : null}
      <BattleAnimationOverlay event={battleAnimation} room={room} />
      {room.pendingTransfer ? (
        <div className="online-transfer-overlay" aria-live="polite">
          <TransferPanel room={room} />
        </div>
      ) : null}

      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}
