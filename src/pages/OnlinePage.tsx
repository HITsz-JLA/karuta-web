import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type PointerEvent, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { OnlineCardTile } from '../components/OnlineCardTile'
import {
  type OnlineCardView,
  type OnlineRoomSummary,
  type OnlineRoundResult,
  type OnlineRoundStart,
  type OnlineRoomView,
  type OnlineServerMessage,
} from '../lib/onlineProtocol'
import { OnlineSocket } from '../lib/onlineSocket'
import {
  CURATED_MUCA_PACKAGES,
  getServerPackageCatalog,
  listServerPackages,
  serverCardImageUrl,
  type ServerPackage,
  type ServerPackageCatalog,
  type ServerPackageCatalogCard,
} from '../lib/serverPackages'

const MIN_CANDIDATE_CARDS = 60
const MAX_CANDIDATE_CARDS = 500
const DEFAULT_CANDIDATE_CARDS = 60
const DRAFT_SELECTION_SIZE = 30
const BAN_SIZE = 5
const MAX_HAND_SLOTS = 33
const REST_AUDIO_VOLUME = 0.28
const EMPTY_CARD_KEYS: string[] = []

type AudioStatus = 'idle' | 'ready' | 'loading' | 'playing' | 'blocked' | 'error'
type BattleStyle = 'text' | 'card'

const BATTLE_STYLE_STORAGE_KEY = 'karuta-online-battle-style'

function readBattleStyle(): BattleStyle {
  try {
    return localStorage.getItem(BATTLE_STYLE_STORAGE_KEY) === 'text' ? 'text' : 'card'
  } catch {
    return 'card'
  }
}

function createSilentAudioUrl() {
  const sampleRate = 8_000
  const sampleCount = 80
  const buffer = new ArrayBuffer(44 + sampleCount)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount, true)
  new Uint8Array(buffer, 44).fill(128)
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

interface ClaimState {
  cardKey: string
  correct: boolean | null
}

function readNickname() {
  try {
    return localStorage.getItem('karuta-online-nickname') || '玩家'
  } catch {
    return '玩家'
  }
}

function packageCardMeta(card: ServerPackageCatalogCard, packageId: string): OnlineCardView {
  return {
    key: card.key,
    number: card.number,
    imageName: card.imageName,
    workName: card.workName,
    imageUrl: serverCardImageUrl(packageId, card.key),
  }
}

function otherPlayer(player: 'A' | 'B') {
  return player === 'A' ? 'B' : 'A'
}

function mirrorBoardLayout(layout: Array<string | null> | null, fallback: string[]) {
  const hand = new Set(fallback)
  const used = new Set<string>()
  const source = Array.from({ length: MAX_HAND_SLOTS }, (_, index) => {
    const key = layout?.[index]
    if (typeof key !== 'string' || !hand.has(key) || used.has(key)) return null
    used.add(key)
    return key
  })
  const unplaced = fallback.filter((key) => !used.has(key))
  let nextUnplaced = 0
  for (let index = 0; index < source.length && nextUnplaced < unplaced.length; index += 1) {
    if (source[index] === null) source[index] = unplaced[nextUnplaced++]
  }
  const mirrored = Array<string | null>(MAX_HAND_SLOTS).fill(null)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 11; column += 1) {
      mirrored[(2 - row) * 11 + column] = source[row * 11 + column]
    }
  }
  return mirrored
}

function formatNetworkMetric(value: number | null) {
  return value === null ? '测量中' : `${value} ms`
}

export function OnlinePage() {
  const [socket] = useState(() => new OnlineSocket())
  const [serverPackages, setServerPackages] = useState<ServerPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [catalog, setCatalog] = useState<ServerPackageCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const onlinePackages = useMemo(
    () =>
      CURATED_MUCA_PACKAGES.map((meta) => ({
        meta,
        serverPackage: serverPackages.find((item) => item.id === meta.id),
      })).filter(
        (item): item is {
          meta: (typeof CURATED_MUCA_PACKAGES)[number]
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
  const [round, setRound] = useState<OnlineRoundStart | null>(null)
  const [lastResult, setLastResult] = useState<OnlineRoundResult | null>(null)
  const [matchOver, setMatchOver] = useState<Extract<OnlineServerMessage, { t: 'matchOver' }> | null>(null)
  const [myClaim, setMyClaim] = useState<ClaimState | null>(null)
  const [opponentClaim, setOpponentClaim] = useState<ClaimState | null>(null)
  const [roundRemaining, setRoundRemaining] = useState(0)
  const [restRemaining, setRestRemaining] = useState(0)
  const [arrangeReadyRemaining, setArrangeReadyRemaining] = useState(0)
  const [restReadyRemaining, setRestReadyRemaining] = useState(0)
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('idle')
  const [connected, setConnected] = useState(socket.connected)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const roomRef = useRef<OnlineRoomView | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioUnlockedRef = useRef(false)
  const audioUnlockingRef = useRef(false)
  const audioGenerationRef = useRef(0)
  const audioRetryTimerRef = useRef<number | null>(null)
  const [boardSlots, setBoardSlots] = useState<Array<string | null>>(() => Array(MAX_HAND_SLOTS).fill(null))
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null)
  const [draftSelection, setDraftSelection] = useState<Set<string>>(new Set())
  const [draftBans, setDraftBans] = useState<Set<string>>(new Set())
  const [arrangeRemaining, setArrangeRemaining] = useState(0)
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set())
  const [pinMode, setPinMode] = useState(false)
  const [battleStyle, setBattleStyle] = useState<BattleStyle>(readBattleStyle)
  const draggingKeyRef = useRef<string | null>(null)
  const dragOverSlotRef = useRef<number | null>(null)
  const announcedArrangeReadyRef = useRef<number | null>(null)
  const announcedRestReadyRef = useRef<number | null>(null)
  const publishedLayoutRoundRef = useRef<number | null>(null)
  const phaseRef = useRef<OnlineRoomView['phase'] | null>(null)
  const roomCards = useMemo(() => room?.cards || [], [room?.cards])
  const roundRef = useRef<OnlineRoundStart | null>(round)
  const myClaimRef = useRef<ClaimState | null>(myClaim)
  const roundRemainingRef = useRef(roundRemaining)

  useEffect(() => {
    roundRef.current = round
    myClaimRef.current = myClaim
    roundRemainingRef.current = roundRemaining
  }, [myClaim, round, roundRemaining])

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
        if (!cancelled) setMessage(error instanceof Error ? error.message : '无法读取服务器 MUCA 牌组')
      })
      .finally(() => {
        if (!cancelled) setPackagesLoading(false)
      })
    return () => {
      cancelled = true
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
          phaseRef.current = incoming.room.phase
          roomRef.current = incoming.room
          setRoom(incoming.room)
          if (previousPhase === 'arrange' && incoming.room.phase !== 'arrange') {
            draggingKeyRef.current = null
            dragOverSlotRef.current = null
            setDraggingKey(null)
            setDragOverSlot(null)
          }
          setLastResult((previous) => (incoming.room.phase === 'playing' ? previous : null))
          if (incoming.room.phase === 'lobby') {
            setRound(null)
            setMatchOver(null)
            setDraftSelection(new Set())
            setDraftBans(new Set())
          } else if (incoming.room.phase === 'draft_select' && previousPhase !== 'draft_select') {
            setDraftSelection(new Set(incoming.room.draft.selectedCardKeys))
            setDraftBans(new Set())
          } else if (incoming.room.phase === 'draft_ban' && previousPhase !== 'draft_ban') {
            setDraftBans(new Set(incoming.room.draft.bannedCardKeys))
          }
          break
        case 'roundStart':
          setRound(incoming)
          setLastResult(null)
          setMatchOver(null)
          setMyClaim(null)
          setOpponentClaim(null)
          setRoundRemaining(incoming.windowMs)
          draggingKeyRef.current = null
          dragOverSlotRef.current = null
          setDraggingKey(null)
          setDragOverSlot(null)
          break
        case 'claimFeedback':
          if (roomRef.current && incoming.playerId === roomRef.current.you) {
            setMyClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          } else {
            setOpponentClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          }
          if (!incoming.correct) setRound(null)
          break
        case 'cardTransfer':
          setMyClaim(null)
          setOpponentClaim(null)
          setMessage(
            incoming.to === roomRef.current?.you
              ? incoming.automatic
                ? '对手未及时选牌，系统随机转来一张牌'
                : '对手已转来一张牌，可以继续抢牌'
              : incoming.automatic
                ? '已自动向对手转牌'
                : '已向对手转牌',
          )
          break
        case 'roundResult':
          setLastResult(incoming)
          setRound(null)
          setMyClaim(null)
          setOpponentClaim(null)
          break
        case 'matchOver':
          setMatchOver(incoming)
          setRound(null)
          break
        case 'error':
          setMessage(incoming.message)
          break
        default:
          break
      }
    })
    const offStatus = socket.onStatus(setConnected)
    void socket
      .connect()
      .then(() => socket.send({ t: 'listRooms' }))
      .catch((error) => setMessage(error instanceof Error ? error.message : '在线服务不可用'))
    return () => {
      offMessage()
      offStatus()
      socket.close()
    }
  }, [socket])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.setAttribute('playsinline', 'true')
    audio.addEventListener('error', () => setAudioStatus('error'))
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
      if (audioRetryTimerRef.current) window.clearTimeout(audioRetryTimerRef.current)
      audioRetryTimerRef.current = null
      void audioContextRef.current?.close().catch(() => undefined)
      audioContextRef.current = null
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    const source = round?.audioUrl || room?.restAudioUrl || null
    const generation = audioGenerationRef.current + 1
    audioGenerationRef.current = generation
    if (audioRetryTimerRef.current) window.clearTimeout(audioRetryTimerRef.current)
    audioRetryTimerRef.current = null
    if (!source || !audio) {
      if (audio) audio.pause()
      setAudioStatus(audioUnlockedRef.current ? 'ready' : 'idle')
      return
    }

    audio.preload = 'auto'
    audio.muted = false
    audio.volume = round ? 1 : REST_AUDIO_VOLUME
    audio.src = source
    audio.load()
    const localStart = round ? socket.toLocalTime(round.startAtServerTime) : Date.now()
    let attempt = 0
    const retryPlay = () => {
      if (generation !== audioGenerationRef.current) return
      setAudioStatus('loading')
      try {
        void audio.play()
          .then(() => {
            if (generation === audioGenerationRef.current) {
              audioUnlockedRef.current = true
              setAudioStatus('playing')
            }
          })
          .catch((error: unknown) => {
            if (generation !== audioGenerationRef.current) return
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
              setAudioStatus('blocked')
              return
            }
            if (attempt < 3) {
              attempt += 1
              audioRetryTimerRef.current = window.setTimeout(() => {
                audio.load()
                retryPlay()
              }, 350 * attempt)
              return
            }
            setAudioStatus('error')
          })
      } catch {
        if (attempt < 3) {
          attempt += 1
          audioRetryTimerRef.current = window.setTimeout(retryPlay, 350 * attempt)
        } else {
          setAudioStatus('error')
        }
      }
    }
    const playTimer = window.setTimeout(() => {
      retryPlay()
    }, Math.max(0, localStart - Date.now()))
    const updateRemaining = () => {
      if (!round) {
        setRoundRemaining(0)
        return
      }
      const left = localStart + round.windowMs - Date.now()
      setRoundRemaining(Math.max(0, left))
    }
    updateRemaining()
    const remainingTimer = window.setInterval(updateRemaining, 100)
    return () => {
      window.clearTimeout(playTimer)
      if (audioRetryTimerRef.current) window.clearTimeout(audioRetryTimerRef.current)
      audioRetryTimerRef.current = null
      window.clearInterval(remainingTimer)
      audio.pause()
    }
  }, [room?.restAudioUrl, round, socket])

  useEffect(() => {
    if (room?.phase !== 'arrange' || !room.draft.arrangeEndsAtServerTime) {
      setArrangeRemaining(0)
      return
    }
    const localEnd = socket.toLocalTime(room.draft.arrangeEndsAtServerTime)
    const update = () => setArrangeRemaining(Math.max(0, localEnd - Date.now()))
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [room?.draft.arrangeEndsAtServerTime, room?.phase, socket])

  useEffect(() => {
    if (room?.phase !== 'playing' || !room.restEndsAtServerTime) {
      setRestRemaining(0)
      return
    }
    const localEnd = socket.toLocalTime(room.restEndsAtServerTime)
    const update = () => setRestRemaining(Math.max(0, localEnd - Date.now()))
    update()
    const timer = window.setInterval(update, 250)
    return () => window.clearInterval(timer)
  }, [room?.phase, room?.restEndsAtServerTime, socket])

  useEffect(() => {
    const launchAt = room?.arrangeReadyStartAtServerTime || null
    if (!launchAt) {
      announcedArrangeReadyRef.current = null
      setArrangeReadyRemaining(0)
      return
    }

    const localLaunchAt = socket.toLocalTime(launchAt)
    const update = () => setArrangeReadyRemaining(Math.max(0, localLaunchAt - Date.now()))
    update()
    const timer = window.setInterval(update, 100)

    if (announcedArrangeReadyRef.current !== launchAt) {
      announcedArrangeReadyRef.current = launchAt
      playReadyCue()
    }

    return () => window.clearInterval(timer)
  }, [room?.arrangeReadyStartAtServerTime, socket])

  useEffect(() => {
    const launchAt = room?.restReadyStartAtServerTime || null
    if (!launchAt) {
      announcedRestReadyRef.current = null
      setRestReadyRemaining(0)
      return
    }

    const localLaunchAt = socket.toLocalTime(launchAt)
    const update = () => setRestReadyRemaining(Math.max(0, localLaunchAt - Date.now()))
    update()
    const timer = window.setInterval(update, 100)

    if (announcedRestReadyRef.current !== launchAt) {
      announcedRestReadyRef.current = launchAt
      playReadyCue()
    }

    return () => window.clearInterval(timer)
  }, [room?.restReadyStartAtServerTime, socket])

  useEffect(() => {
    const keys = room?.players[room.you]?.handCardKeys || []
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
    setPinnedKeys((previous) => new Set([...previous].filter((key) => keys.includes(key))))
    if (!keys.length) {
      draggingKeyRef.current = null
      dragOverSlotRef.current = null
      setDraggingKey(null)
      setDragOverSlot(null)
    }
  }, [room])

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
  const me = room ? room.players[room.you] : null
  const opponent = room ? room.players[otherPlayer(room.you)] : null
  const ownHandKeys = me?.handCardKeys || EMPTY_CARD_KEYS
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
  const isResting = Boolean(room?.phase === 'playing' && restRemaining > 0 && !round && !matchOver)
  const canArrange = Boolean(
    ((room?.phase === 'arrange' && arrangeRemaining > 0) || isResting) && !matchOver && !round,
  )

  useEffect(() => {
    if (room?.phase !== 'playing') {
      publishedLayoutRoundRef.current = null
      return
    }
    const layoutRevision = round?.roundNo ?? room?.roundNo ?? 0
    if (publishedLayoutRoundRef.current === layoutRevision) return
    if (boardSlots.length !== MAX_HAND_SLOTS || boardSlots.filter(Boolean).length !== ownHandKeys.length) return
    if (!socket.send({ t: 'arrangeLayout', cardKeys: boardSlots })) return
    publishedLayoutRoundRef.current = layoutRevision
  }, [boardSlots, ownHandKeys, room?.phase, room?.roundNo, round?.roundNo, socket])

  const createRoom = useCallback(async () => {
    if (!selectedPackage || !catalog) {
      setMessage('请先选择服务器 MUCA 牌组')
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

  const leaveRoom = useCallback(() => {
    socket.send({ t: 'leaveRoom' })
    socket.clearResume()
    phaseRef.current = null
    roomRef.current = null
    setRoom(null)
    setRound(null)
    setLastResult(null)
    setMatchOver(null)
    setMyClaim(null)
    setOpponentClaim(null)
    setDraftSelection(new Set())
    setDraftBans(new Set())
    setBoardSlots(Array(MAX_HAND_SLOTS).fill(null))
    setPinnedKeys(new Set())
    setPinMode(false)
    setMessage(null)
    void socket.connect().then(() => socket.send({ t: 'listRooms' }))
  }, [socket])

  const moveCardToSlot = useCallback(
    (sourceKey: string, targetSlot: number) => {
      if (!canArrange || !sourceKey) return
      const target = Math.max(0, Math.min(MAX_HAND_SLOTS - 1, Math.round(targetSlot)))
      setBoardSlots((previous) => {
        const next = [...previous]
        const sourceIndex = next.indexOf(sourceKey)
        if (sourceIndex < 0 || sourceIndex === target) return previous
        const displaced = next[target]
        next[target] = sourceKey
        next[sourceIndex] = displaced && displaced !== sourceKey ? displaced : null
        return next
      })
    },
    [canArrange],
  )

  const clearDrag = useCallback(() => {
    draggingKeyRef.current = null
    dragOverSlotRef.current = null
    setDraggingKey(null)
    setDragOverSlot(null)
  }, [])

  useEffect(() => {
    if (canArrange || !draggingKeyRef.current) return
    clearDrag()
  }, [canArrange, clearDrag])

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange) {
        event.preventDefault()
        return
      }
      draggingKeyRef.current = cardKey
      dragOverSlotRef.current = Math.max(0, boardSlots.indexOf(cardKey))
      setDraggingKey(cardKey)
      setDragOverSlot(dragOverSlotRef.current)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', cardKey)
    },
    [boardSlots, canArrange],
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>, slotIndex: number) => {
      if (!canArrange || !draggingKeyRef.current) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      dragOverSlotRef.current = slotIndex
      setDragOverSlot(slotIndex)
    },
    [canArrange],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>, targetSlot: number) => {
      if (!canArrange) return
      event.preventDefault()
      const sourceKey = event.dataTransfer.getData('text/plain') || draggingKeyRef.current || ''
      moveCardToSlot(sourceKey, targetSlot)
      clearDrag()
    },
    [canArrange, clearDrag, moveCardToSlot],
  )

  const handleDragEnd = clearDrag

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange) return
      event.preventDefault()
      draggingKeyRef.current = cardKey
      dragOverSlotRef.current = Math.max(0, boardSlots.indexOf(cardKey))
      setDraggingKey(cardKey)
      setDragOverSlot(dragOverSlotRef.current)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [boardSlots, canArrange],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!canArrange || !draggingKeyRef.current) return
      const hovered = document.elementFromPoint(event.clientX, event.clientY)
      const slotElement = hovered instanceof HTMLElement ? hovered.closest<HTMLElement>('[data-online-slot-index]') : null
      const slotIndex = Number.parseInt(slotElement?.dataset.onlineSlotIndex || '', 10)
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_HAND_SLOTS || slotIndex === dragOverSlotRef.current) return
      dragOverSlotRef.current = slotIndex
      setDragOverSlot(slotIndex)
    },
    [canArrange],
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (canArrange && draggingKeyRef.current && dragOverSlotRef.current !== null) {
        moveCardToSlot(draggingKeyRef.current, dragOverSlotRef.current)
      }
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [canArrange, clearDrag, moveCardToSlot],
  )

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [clearDrag],
  )

  function toggleSelected(card: ServerPackageCatalogCard) {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(card.key)) next.delete(card.key)
      else if (next.size < boardCount) next.add(card.key)
      else setMessage(`本局最多选择 ${boardCount} 张卡牌`)
      return next
    })
  }

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

  function toggleDraftCard(cardKey: string, limit: number, setter: Dispatch<SetStateAction<Set<string>>>) {
    setter((previous) => {
      const next = new Set(previous)
      if (next.has(cardKey)) next.delete(cardKey)
      else if (next.size < limit) next.add(cardKey)
      else setMessage(`本阶段最多选择 ${limit} 张卡牌`)
      return next
    })
  }

  function submitDraftSelection() {
    if (draftSelection.size !== DRAFT_SELECTION_SIZE) return
    if (!socket.send({ t: 'selectCards', cardKeys: [...draftSelection] })) setMessage('连接已断开，选牌没有送达')
  }

  function submitDraftBan() {
    if (draftBans.size !== BAN_SIZE) return
    if (!socket.send({ t: 'banCards', cardKeys: [...draftBans] })) setMessage('连接已断开，BAN 没有送达')
  }

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
    if (!socket.send({ t: 'claim', roundNo: currentRound.roundNo, cardKey, clientAt: Math.max(0, currentRound.windowMs - roundRemainingRef.current) })) {
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

  function toggleReady() {
    if (!room || (!isOpeningArrange && !isResting) || room.pendingTransfer) return
    const currentReady = isOpeningArrange ? me?.arrangeReady : me?.restReady
    if (!socket.send({ t: 'ready', ready: !currentReady })) setMessage('连接已断开，准备状态没有送达')
  }

  const unlockAudio = useCallback(() => {
    if (audioUnlockingRef.current) return
    audioUnlockingRef.current = true
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

    const source = audio.getAttribute('src')
    if (!source) {
      const previousMuted = audio.muted
      const silentUrl = createSilentAudioUrl()
      audio.muted = true
      audio.src = silentUrl
      audio.load()
      let playPromise: Promise<void>
      try {
        playPromise = audio.play()
      } catch {
        audio.muted = previousMuted
        URL.revokeObjectURL(silentUrl)
        audioUnlockingRef.current = false
        setAudioStatus('error')
        return
      }
      void playPromise
        .then(() => {
          audio.pause()
          audio.currentTime = 0
          audio.removeAttribute('src')
          audio.load()
          audioUnlockedRef.current = true
          setAudioStatus('ready')
        })
        .catch(() => setAudioStatus('blocked'))
        .finally(() => {
          audio.muted = previousMuted
          URL.revokeObjectURL(silentUrl)
          audioUnlockingRef.current = false
        })
      return
    }

    audio.muted = false
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
      .finally(() => {
        audioUnlockingRef.current = false
      })
  }, [])

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

  const audioButtonLabel = audioStatus === 'blocked' ? '点击恢复音频' : audioStatus === 'error' ? '重试音频' : audioStatus === 'playing' ? '音频播放中' : audioStatus === 'ready' ? '音频已启用' : '启用音频'

  if (!room) {
    return (
      <div className="online-page">
        <section className="hero">
          <div className="row spread">
            <div>
              <h1>在线 1v1 歌牌对战</h1>
              <p>双方看到同一组歌牌卡面，听到歌曲后抢先点击对应卡牌。</p>
            </div>
            <div className="row online-lobby-actions">
              <span className={`connection-chip${connected ? ' online' : ''}`}>
                {connected ? '在线服务已连接' : '正在连接…'}
              </span>
              <button className="btn btn-secondary online-lobby-audio" type="button" onClick={unlockAudio}>
                {audioButtonLabel}
              </button>
            </div>
          </div>
        </section>

        <div className="online-lobby-grid">
          <section className="panel warm stack">
            <div className="row spread">
              <strong>创建房间</strong>
              <span className="muted small">服务器牌组提供同一套歌牌卡面</span>
            </div>
            <div className="field">
              <label htmlFor="onlineNickname">你的昵称</label>
              <input id="onlineNickname" value={nickname} maxLength={20} onChange={(event) => setNickname(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="roomName">房间名称</label>
              <input id="roomName" value={roomName} maxLength={40} onChange={(event) => setRoomName(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="onlineDeck">使用服务器牌组</label>
              <select id="onlineDeck" value={activePackageId} onChange={(event) => setSelectedPackageId(event.target.value)} disabled={packagesLoading || catalogLoading}>
                <option value="">{onlinePackages.length ? '请选择服务器牌组' : '服务器暂无 MUCA 牌组'}</option>
                {onlinePackages.map(({ meta, serverPackage }) => (
                  <option key={serverPackage.id} value={serverPackage.id}>
                    {meta.name} · {serverPackage.name}
                  </option>
                ))}
              </select>
            </div>
            {!packagesLoading && !onlinePackages.length ? (
              <p className="notice warn">在线歌牌只使用服务器上的四套 MUCA 牌组，请联系管理员检查 data-packages。</p>
            ) : null}
            <div className="row">
              <div className="field" style={{ flex: '0 0 120px' }}>
                 <label htmlFor="boardCount">候选牌数量</label>
                 <input id="boardCount" type="number" min={MIN_CANDIDATE_CARDS} max={MAX_CANDIDATE_CARDS} step={1} value={boardCount} onChange={(event) => setBoardSize(Number(event.target.value))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="onlineSearch">筛选卡面</label>
                <input id="onlineSearch" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="作品名或牌号" />
              </div>
            </div>
            <div className="row spread draft-selection-summary">
              <p className="muted small">已选 {selectedIds.size} / {boardCount} 张；奇数会由服务器随机弃置 1 张后平分，再由双方各选 30 张。</p>
              <button className="btn btn-secondary" type="button" onClick={selectAllCandidates} disabled={!eligibleCards.length}>全选服务器牌组</button>
            </div>
            {catalogLoading ? <div className="empty-state">正在读取服务器牌组目录…</div> : null}
            {!catalogLoading && catalog?.packageId === activePackageId && eligibleCards.length ? (
              <VirtualServerCardGrid
                cards={visibleCards}
                packageId={activePackageId}
                selected={selectedIds}
                onToggle={toggleSelected}
              />
            ) : null}
            {!catalogLoading && !eligibleCards.length ? <div className="empty-state">服务器牌组没有可用于在线对战的卡牌</div> : null}
            <button className="btn btn-primary btn-lg" type="button" onClick={() => void createRoom()} disabled={busy || !connected || catalogLoading || !selectedPackage}>
              {busy ? '创建中…' : '创建歌牌房间'}
            </button>
          </section>

          <section className="panel cool stack">
            <strong>加入房间</strong>
            <p className="muted small">输入朋友分享的 6 位房间码；加入后直接读取服务器牌组，不需要本机预先导入 ZIP。</p>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="joinCode">房间码</label>
                <input id="joinCode" value={joinCode} maxLength={6} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="例如 A7K2PM" />
              </div>
              <button className="btn btn-primary" type="button" onClick={() => void joinRoom()} disabled={busy || !connected}>
                加入
              </button>
            </div>
            <div className="row spread">
              <strong>公开房间</strong>
              <button className="btn btn-secondary" type="button" onClick={() => socket.send({ t: 'listRooms' })} disabled={!connected}>
                刷新
              </button>
            </div>
            <div className="room-list">
              {!rooms.length ? <div className="empty-state">暂时没有公开房间</div> : null}
              {rooms.map((item) => (
                <button key={item.code} type="button" className="room-list-item" onClick={() => setJoinCode(item.code)}>
                  <span>
                    <strong>{item.name}</strong>
                    <span className="muted small">{item.deckName} · {item.players}/2 人</span>
                  </span>
                  <span className="room-code">{item.code}</span>
                </button>
              ))}
            </div>
            <div className="online-rules stack">
              <strong>玩法</strong>
              <span className="muted small">1. 候选牌随机分成两份，双方各选 30 张并互换</span>
              <span className="muted small">2. 双方各从收到的 30 张中 BAN 5 张，剩余各 25 张</span>
              <span className="muted small">3. 开局排牌 3 分钟；3×11 是 33 个固定可放置槽位，只能调整自己的牌区</span>
              <span className="muted small">4. 空牌歌曲来自场外 20 首，单次出现后移出空牌池；没有对应卡面，点击任一卡面都会判错</span>
               <span className="muted small">5. 普通歌曲选错或正确收取对手牌后，进入 40 秒休息交牌阶段</span>
               <span className="muted small">6. 开局排牌和休息阶段都可提前准备；开局双方准备后 20 秒进入游戏，休息阶段双方准备后 5 秒进入下一回合</span>
            </div>
            <Link className="btn btn-secondary" to="/admin">
              管理服务器牌组
            </Link>
          </section>
        </div>

        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  if (room.phase === 'lobby') {
    const ready = Boolean(me?.ready)
    return (
      <div className="online-page">
        <section className="hero">
          <div className="row spread">
            <div>
              <h1>{room.name}</h1>
              <p>房间码 <span className="room-code large">{room.code}</span> · {room.deckName}</p>
            </div>
            <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出房间</button>
          </div>
          <p className="muted small">把房间码分享给对手。双方直接使用服务器牌组看到同一套真实卡面，歌名不会在开局前下发。</p>
        </section>

        <section className="panel stack">
          <div className="versus-players">
            <PlayerBadge player={room.players.A} mine={room.you === 'A'} />
            <span className="versus-mark">VS</span>
            <PlayerBadge player={room.players.B} mine={room.you === 'B'} />
          </div>
          <NetworkFairness room={room} />
          <div className="online-board compact">
            {orderedRoomCards.map((meta) => (
              <OnlineCardTile key={meta.key} meta={meta} available={false} />
            ))}
          </div>
          <div className="row spread">
             <span className="muted small">候选牌 {room.cards.length} 张 · 准备后进入选牌、互换和 BAN</span>
            <button className="btn btn-primary btn-lg" type="button" disabled={!opponent || !room.fairness.canStart} onClick={() => socket.send({ t: 'ready', ready: !ready })}>
              {ready ? '取消准备' : '准备开始'}
            </button>
          </div>
        </section>
        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  if (room.phase === 'draft_select') {
    return (
      <div className="online-page">
        <section className="hero">
          <div className="row spread">
            <div>
              <h1>第一阶段 · 各自选牌</h1>
              <p>{room.name} · 房间码 <span className="room-code">{room.code}</span></p>
            </div>
            <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出本局</button>
          </div>
          <p>服务器已经把候选牌随机分成两份。请只从你看到的这一份牌池中选择 30 张。</p>
        </section>
        <DraftCardPicker
          title="从你的随机牌池选择 30 张"
          description="选定后会锁定，等对手也完成选择；对手不会看到你的选择进度以外的内容。"
          cards={draftPoolCards}
          selected={draftSelection}
          limit={DRAFT_SELECTION_SIZE}
          opponentCount={room.draft.opponentSelectedCount}
          opponentLabel="对手已选"
          submitLabel="确认 30 张并进入互换"
          onToggle={(key) => toggleDraftCard(key, DRAFT_SELECTION_SIZE, setDraftSelection)}
          onSubmit={submitDraftSelection}
        />
        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  if (room.phase === 'draft_ban') {
    return (
      <div className="online-page">
        <section className="hero">
          <div className="row spread">
            <div>
              <h1>第二阶段 · 互换后 BAN 牌</h1>
              <p>{room.name} · 你正在处理对手选出的 30 张牌</p>
            </div>
            <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出本局</button>
          </div>
          <p>这些是对手选出的牌。请从中 BAN 5 张，剩余 25 张会成为你的起始牌区。</p>
        </section>
        <DraftCardPicker
          title="从互换牌中 BAN 5 张"
          description="BAN 只作用于你收到的这 30 张牌；双方完成后会同时进入三分钟排牌准备。"
          cards={draftExchangeCards}
          selected={draftBans}
          limit={BAN_SIZE}
          opponentCount={room.draft.opponentBannedCount}
          opponentLabel="对手已 BAN"
          submitLabel="确认 BAN 5 张并进入排牌"
          onToggle={(key) => toggleDraftCard(key, BAN_SIZE, setDraftBans)}
          onSubmit={submitDraftBan}
        />
        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  if (room.phase === 'over' || matchOver) {
    const scores = matchOver?.scores || { A: room.players.A?.score || 0, B: room.players.B?.score || 0 }
    const winner = matchOver?.winner || (scores.A === scores.B ? null : scores.A > scores.B ? 'A' : 'B')
    return (
      <div className="online-page">
        <section className="hero">
          <h1>本局结束</h1>
          <p>{winner ? `${room.players[winner]?.nickname || winner} 获胜` : '双方平手'}</p>
        </section>
        <section className="panel stack result-panel">
          <div className="versus-players">
            <ScoreCard player={room.players.A} score={scores.A} winner={winner === 'A'} />
            <span className="versus-mark">—</span>
            <ScoreCard player={room.players.B} score={scores.B} winner={winner === 'B'} />
          </div>
          <p className="muted small">完成 {matchOver?.rounds || room.roundNo} 回合</p>
          <button className="btn btn-primary btn-lg" type="button" onClick={leaveRoom}>返回在线大厅</button>
        </section>
        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  const resultMeta = lastResult?.cardKey ? room.cards.find((card) => card.key === lastResult.cardKey) || null : null
  const scores = lastResult?.scores || { A: room.players.A?.score || 0, B: room.players.B?.score || 0 }
  const isOpeningArrange = room.phase === 'arrange'
  const canClaim = Boolean(round && !myClaim && !lastResult && !room.pendingTransfer)
  const restSeconds = Math.ceil(restRemaining / 1000)
  const arrangeReadySeconds = Math.ceil(arrangeReadyRemaining / 1000)
  const restReadySeconds = Math.ceil(restReadyRemaining / 1000)
  const readyRemaining = isOpeningArrange ? arrangeReadyRemaining : restReadyRemaining
  const readySeconds = isOpeningArrange ? arrangeReadySeconds : restReadySeconds
  const stageLabel = isOpeningArrange ? '开局排牌' : isResting ? '休息阶段' : round ? '听歌抢牌' : '对局进行中'
  const isGivingCard = Boolean(room.pendingTransfer?.to === room.you)
  const isReadyWindow = isOpeningArrange || isResting
  const restReady = Boolean(me?.restReady)
  const opponentRestReady = Boolean(opponent?.restReady)
  const windowReady = isOpeningArrange ? Boolean(me?.arrangeReady) : restReady
  const opponentWindowReady = isOpeningArrange ? Boolean(opponent?.arrangeReady) : opponentRestReady
  const statusText = isOpeningArrange
    ? arrangeReadyRemaining > 0
      ? `双方已准备 · ${arrangeReadySeconds} 秒后开始游戏`
      : `排牌准备中 · ${Math.ceil(arrangeRemaining / 1000)} 秒后自动开始`
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
            <h1>{isOpeningArrange ? '开局排牌准备' : '歌牌对战进行中'}</h1>
            <p>
              {isOpeningArrange
                ? `剩余 ${Math.ceil(arrangeRemaining / 1000)} 秒完成自己的牌区布局 · ${ownHandKeys.length} 张手牌`
                : `第 ${room.roundNo || round?.roundNo || 0} 回合 · 场上实牌 ${room.remainingCardKeys.length} 张`}
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出本局</button>
        </div>
      </section>

      <section className="panel stack online-game-panel">
        <div className="online-game-header">
          <div className="online-game-heading">
            <strong>歌牌棋盘</strong>
            <span className="muted small">服务器歌牌卡面 · 牌位调整只保留在自己的视角</span>
          </div>
          <div className="online-game-header-tools">
            <span className="chip">{round ? `第 ${round.roundNo} 回合` : isResting ? '休息阶段' : '等待下一回合'}</span>
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
              claimable={canClaim}
              resultKey={lastResult?.cardKey || null}
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
              mine
              canArrange={canArrange}
              pinMode={pinMode}
              pinnedKeys={pinnedKeys}
              draggingKey={draggingKey}
              dragOverSlot={dragOverSlot}
              claimable={canClaim}
              giving={isGivingCard}
              resultKey={lastResult?.cardKey || null}
              pickedKey={myClaim?.cardKey || null}
              onCardClick={isGivingCard ? giveCard : pinMode && canArrange ? togglePinned : claimCard}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
          </div>
          <aside className="online-match-sidebar" aria-label="对局信息">
            <section className="online-sidebar-card online-score-panel">
              <span className="muted small">比分</span>
              <div className="online-sidebar-scores">
                <div><span>对手</span><strong>{scores[otherPlayer(room.you)]}</strong></div>
                <span className="versus-mark">VS</span>
                <div><strong>{scores[room.you]}</strong><span>我方</span></div>
              </div>
            </section>
            <section className={`online-sidebar-card online-phase-panel${isResting ? ' resting' : ''}${readyRemaining > 0 ? ' ready-countdown' : ''}`} role="status" aria-live="polite">
              <span className="online-phase-label">{stageLabel}</span>
              <strong className="online-phase-count">
                {isOpeningArrange
                  ? `${arrangeReadyRemaining > 0 ? arrangeReadySeconds : Math.ceil(arrangeRemaining / 1000)} 秒`
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
            <NetworkFairness room={room} compact />
            <div className="online-audio-control">
              <button className="btn btn-secondary online-audio-button" type="button" onClick={unlockAudio}>{audioButtonLabel}</button>
              {audioStatus === 'blocked' ? <span className="online-audio-status error" role="alert">浏览器拦截了自动播放，请点击按钮恢复音频。</span> : null}
              {audioStatus === 'error' ? <span className="online-audio-status error" role="alert">音频资源加载失败，请点击重试。</span> : null}
              {audioStatus === 'loading' ? <span className="online-audio-status">音频加载中…</span> : null}
            </div>
          </aside>
        </div>
      </section>

      {lastResult ? (
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
                  <OnlineCardTile meta={resultMeta} available result showNumber={false} />
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
      {room.pendingTransfer ? (
        <div className="online-transfer-overlay" aria-live="polite">
          <TransferPanel room={room} />
        </div>
      ) : null}

      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}

interface VirtualServerCardGridProps {
  cards: ServerPackageCatalogCard[]
  packageId: string
  selected: Set<string>
  onToggle: (card: ServerPackageCatalogCard) => void
}

/**
 * Keeps the complete server catalog scrollable while mounting only the rows
 * around the viewport. This avoids a 400+ card React/DOM task without hiding
 * cards behind a manual "load more" action.
 */
function VirtualServerCardGrid({ cards, packageId, selected, onToggle }: VirtualServerCardGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 520 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight || 520 })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const columns = viewport.width >= 720 ? 5 : viewport.width >= 480 ? 4 : viewport.width >= 320 ? 3 : 2
  const cardWidth = Math.max(92, (viewport.width - (columns - 1) * 8 - 6) / columns)
  const rowHeight = Math.ceil(cardWidth * 1.45 + 58)
  const rowCount = Math.ceil(cards.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewport.height) / rowHeight) + 2)
  const startIndex = firstRow * columns
  const renderedCards = cards.slice(startIndex, lastRow * columns)

  return (
    <div
      className="online-select-viewport"
      ref={viewportRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label={`服务器牌组，共 ${cards.length} 张卡面`}
    >
      <div className="online-select-canvas" style={{ height: `${rowCount * rowHeight}px` }}>
        <div
          className="online-select-window"
          style={{
            top: `${firstRow * rowHeight}px`,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoRows: `${rowHeight}px`,
          }}
        >
          {renderedCards.map((card) => (
            <OnlineCardTile
              key={card.key}
              meta={packageCardMeta(card, packageId)}
              card={null}
              available
              picked={selected.has(card.key)}
              onClick={() => onToggle(card)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface DraftCardPickerProps {
  title: string
  description: string
  cards: OnlineCardView[]
  selected: Set<string>
  limit: number
  opponentCount: number
  opponentLabel: string
  submitLabel: string
  onToggle: (key: string) => void
  onSubmit: () => void
}

function DraftCardPicker({
  title,
  description,
  cards,
  selected,
  limit,
  opponentCount,
  opponentLabel,
  submitLabel,
  onToggle,
  onSubmit,
}: DraftCardPickerProps) {
  return (
    <section className="panel stack draft-panel">
      <div className="row spread">
        <div>
          <h2>{title}</h2>
          <p className="muted small">{description}</p>
        </div>
        <span className="chip">{selected.size} / {limit}</span>
      </div>
      <div className="draft-progress">
        <span>你的选择：{selected.size} / {limit}</span>
        <span>{opponentLabel}：{opponentCount} / {limit}</span>
      </div>
      <div className="draft-card-grid">
        {cards.map((meta) => (
          <OnlineCardTile
            key={meta.key}
            meta={meta}
            available
            picked={selected.has(meta.key)}
            onClick={() => onToggle(meta.key)}
          />
        ))}
      </div>
      {!cards.length ? <div className="empty-state">正在等待服务器下发本阶段牌池…</div> : null}
      <button className="btn btn-primary btn-lg" type="button" disabled={selected.size !== limit} onClick={onSubmit}>
        {submitLabel}
      </button>
    </section>
  )
}

interface HandAreaProps {
  title: string
  slotCards: Array<OnlineCardView | null>
  mine?: boolean
  canArrange?: boolean
  pinMode?: boolean
  pinnedKeys?: Set<string>
  draggingKey?: string | null
  dragOverSlot?: number | null
  claimable?: boolean
  giving?: boolean
  resultKey?: string | null
  pickedKey?: string | null
  onCardClick?: (key: string) => void
  onDragStart?: (event: DragEvent<HTMLButtonElement>, cardKey: string) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>, slotIndex: number) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>, slotIndex: number) => void
  onDragEnd?: () => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>, cardKey: string) => void
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void
}

const HandArea = memo(function HandArea({
  title,
  slotCards,
  mine = false,
  canArrange = false,
  pinMode = false,
  pinnedKeys = new Set<string>(),
  draggingKey = null,
  dragOverSlot = null,
  claimable = false,
  giving = false,
  resultKey = null,
  pickedKey = null,
  onCardClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: HandAreaProps) {
  const draggable = mine && canArrange
  const clickable = Boolean((claimable && !canArrange) || giving)
  const showSlots = Boolean(mine && draggingKey)
  return (
    <section className={`hand-area${mine ? ' mine' : ''}${giving ? ' giving' : ''}`}>
      <div className="row spread hand-area-heading">
        <strong>{title}</strong>
        <span className="muted small">{giving ? '点击自己的牌交给对手' : mine ? (canArrange ? (pinMode ? '点击固定牌位' : '可拖动调整') : '你的牌区') : '点击卡面抢牌'}</span>
      </div>
      <div className="hand-grid-scroll">
        <div className="online-hand-grid">
          {Array.from({ length: MAX_HAND_SLOTS }, (_, index) => {
            const meta = slotCards[index] || null
            if (!meta) {
              return showSlots ? (
                <button
                  key={`empty-${index}`}
                  className="online-empty-slot visible"
                  type="button"
                  data-online-slot-index={index}
                  onDragOver={onDragOver ? (event) => onDragOver(event, index) : undefined}
                  onDrop={onDrop ? (event) => onDrop(event, index) : undefined}
                  aria-label={`放置到第 ${index + 1} 个牌槽`}
                >
                  <span>放置到此槽位</span>
                </button>
              ) : (
                <span key={`empty-${index}`} className="online-slot-placeholder" data-online-slot-index={index} aria-hidden="true" />
              )
            }
            return (
              <OnlineCardTile
                key={meta.key}
                meta={meta}
                available={clickable}
                showNumber={false}
                slotIndex={index}
                picked={pickedKey === meta.key}
                result={resultKey === meta.key}
                pinned={pinnedKeys.has(meta.key)}
                stateLabel={giving ? '点击交牌' : canArrange ? '可调整位置' : undefined}
                draggable={draggable}
                dragging={draggingKey === meta.key}
                dropTarget={dragOverSlot === index && draggingKey !== meta.key}
                onDragStart={onDragStart ? (event) => onDragStart(event, meta.key) : undefined}
                onDragOver={onDragOver ? (event) => onDragOver(event, index) : undefined}
                onDrop={onDrop ? (event) => onDrop(event, index) : undefined}
                onDragEnd={onDragEnd}
                onPointerDown={onPointerDown ? (event) => onPointerDown(event, meta.key) : undefined}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onClick={onCardClick ? () => onCardClick(meta.key) : undefined}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
})

function TransferPanel({ room }: { room: OnlineRoomView }) {
  const pending = room.pendingTransfer
  if (!pending) return null
  const isGiver = pending.to === room.you
  const opponentName = room.players[pending.from]?.nickname || '玩家'
  const opponentCard = pending.reason === 'opponent_card'
  return (
    <section className={`panel transfer-panel${isGiver ? ' choosing' : ''}`} role="alert">
      <div className="row spread">
        <strong>{isGiver ? '点击我方牌交给对手' : '等待对手交牌'}</strong>
        <span className="chip">休息阶段</span>
      </div>
      <p className="muted small">
        {isGiver
          ? opponentCard
            ? `你抢到了对手（${opponentName}）牌区中的卡面；请从自己的牌区选择一张牌补给对手。`
            : `对手（${opponentName}）刚才选错了，请从你自己的牌区点击一张牌转给对手。`
          : opponentCard
            ? '目标卡面已从对手牌区移出；等待对手交回一张牌后继续。'
          : '本回合暂时停止抢牌；对手点击自己的牌后会恢复。超时未选择时系统会自动随机转牌。'}
      </p>
    </section>
  )
}

function PlayerBadge({ player, mine }: { player: OnlineRoomView['players']['A']; mine: boolean }) {
  return (
    <div className="player-badge">
      <span className={`presence-dot${player?.connected ? ' connected' : ''}`} />
      <strong>{player?.nickname || '等待对手加入…'}</strong>
      {mine ? <span className="muted small">（你）</span> : null}
      {player?.ready ? <span className="ready-label">已准备</span> : null}
    </div>
  )
}

function NetworkFairness({ room, compact = false }: { room: OnlineRoomView; compact?: boolean }) {
  const { fairness } = room
  if (compact) {
    const own = room.players[room.you]
    const opponent = room.players[otherPlayer(room.you)]
    return (
      <div className="network-fairness compact network-latency" role="status" aria-label="双方延迟">
        <strong>双方延迟</strong>
        <div className="network-metrics">
          <span>我方 {formatNetworkMetric(own?.network.rttMs ?? null)}</span>
          <span>对手 {formatNetworkMetric(opponent?.network.rttMs ?? null)}</span>
        </div>
      </div>
    )
  }
  const statusLabel = fairness.status === 'ready' ? '可开始' : fairness.status === 'unfair' ? '不适合公平对战' : '测量中'
  const metric = (player: OnlineRoomView['players']['A']) => {
    if (!player) return '等待玩家'
    return `RTT ${formatNetworkMetric(player.network.rttMs)} · 抖动 ${formatNetworkMetric(player.network.jitterMs)} · ${player.network.samples} 次`
  }

  return (
    <div className={`network-fairness ${fairness.status}`} role={fairness.status === 'unfair' ? 'alert' : 'status'}>
      <div className="row spread">
        <strong>网络公平性</strong>
        <span>{statusLabel}</span>
      </div>
      <p>{fairness.message}</p>
      <div className="network-metrics">
        <span>A · {metric(room.players.A)}</span>
        <span>B · {metric(room.players.B)}</span>
      </div>
    </div>
  )
}

function ScoreCard({
  player,
  score,
  winner,
  mine = false,
}: {
  player: OnlineRoomView['players']['A']
  score: number
  winner: boolean
  mine?: boolean
}) {
  return (
    <div className={`score-card${winner ? ' winner' : ''}`}>
      <span className="muted small">{mine ? '你' : '对手'}</span>
      <strong>{player?.nickname || '—'}</strong>
      <span className="score-value">{score}</span>
    </div>
  )
}
