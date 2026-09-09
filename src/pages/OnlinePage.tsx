import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type PointerEvent, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { OnlineCardTile } from '../components/OnlineCardTile'
import { useDeck, useDeckList } from '../hooks/useDecks'
import {
  onlineCardKey,
  type OnlineCardView,
  type OnlineRoomSummary,
  type OnlineRoundResult,
  type OnlineRoundStart,
  type OnlineRoomView,
  type OnlineServerMessage,
  toOnlineCardInput,
} from '../lib/onlineProtocol'
import { OnlineSocket } from '../lib/onlineSocket'
import { downloadServerPackage, listServerPackages } from '../lib/serverPackages'
import { getDeck, saveDeck } from '../lib/storage'
import { importDeckZip, type ImportProgress } from '../lib/zipPackage'
import type { CardEntry, DeckRecord } from '../types/models'

const MIN_CANDIDATE_CARDS = 60
const MAX_CANDIDATE_CARDS = 500
const DEFAULT_CANDIDATE_CARDS = 60
const DRAFT_SELECTION_SIZE = 30
const BAN_SIZE = 5
const MAX_HAND_SLOTS = 27
const EMPTY_CARD_KEYS: string[] = []

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

function cardMeta(card: CardEntry): OnlineCardView {
  return {
    key: onlineCardKey(card),
    number: card.number,
    imageName: card.imageName,
    workName: card.workName,
  }
}

function otherPlayer(player: 'A' | 'B') {
  return player === 'A' ? 'B' : 'A'
}

function formatPackageProgress(progress: ImportProgress | null) {
  if (!progress) return ''
  if (progress.stage === 'reading' && progress.total) {
    return `正在同步数据包 ${Math.min(Math.ceil(progress.current / 1024 / 1024), Math.ceil(progress.total / 1024 / 1024))}/${Math.ceil(progress.total / 1024 / 1024)} MB`
  }
  if (progress.stage === 'parsing') return '正在解析歌牌目录…'
  if (progress.stage === 'resources' && progress.total) {
    return `正在准备卡面与音频 ${Math.min(Math.ceil(progress.current), progress.total)}/${progress.total}`
  }
  return '正在同步本地卡面库…'
}

function formatNetworkMetric(value: number | null) {
  return value === null ? '测量中' : `${value} ms`
}

export function OnlinePage() {
  const [socket] = useState(() => new OnlineSocket())
  const { decks, loading: decksLoading, refresh: refreshDecks } = useDeckList()
  const [selectedDeckId, setSelectedDeckId] = useState('')
  const activeDeckId = selectedDeckId || decks[0]?.id || ''
  const { deck: selectedDeck, loading: selectedDeckLoading } = useDeck(activeDeckId || undefined)
  const [room, setRoom] = useState<OnlineRoomView | null>(null)
  const [roomDeck, setRoomDeck] = useState<DeckRecord | null>(null)
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
  const [connected, setConnected] = useState(socket.connected)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [packageProgress, setPackageProgress] = useState<ImportProgress | null>(null)
  const syncingPackage = useRef<string | null>(null)
  const roomRef = useRef<OnlineRoomView | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [boardOrder, setBoardOrder] = useState<string[]>([])
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [draftSelection, setDraftSelection] = useState<Set<string>>(new Set())
  const [draftBans, setDraftBans] = useState<Set<string>>(new Set())
  const [arrangeRemaining, setArrangeRemaining] = useState(0)
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set())
  const [pinMode, setPinMode] = useState(false)
  const draggingKeyRef = useRef<string | null>(null)
  const dragOverKeyRef = useRef<string | null>(null)
  const phaseRef = useRef<OnlineRoomView['phase'] | null>(null)
  const roomCards = useMemo(() => room?.cards || [], [room?.cards])

  useEffect(() => {
    if (!selectedDeck) return
    const eligible = selectedDeck.cards.filter((card) => card.songs.length)
    const available = Math.min(MAX_CANDIDATE_CARDS, eligible.length)
    const nextSize = available >= MIN_CANDIDATE_CARDS ? available - (available % 2) : available
    setBoardCount(nextSize || DEFAULT_CANDIDATE_CARDS)
  }, [selectedDeck])

  useEffect(() => {
    if (!selectedDeck) return
    const eligible = selectedDeck.cards.filter((card) => card.songs.length)
    setSelectedIds(new Set(eligible.slice(0, Math.min(boardCount, MAX_CANDIDATE_CARDS)).map((card) => card.id)))
  }, [boardCount, selectedDeck])

  useEffect(() => {
    try {
      localStorage.setItem('karuta-online-nickname', nickname.trim().slice(0, 20))
    } catch {
      // The nickname is a convenience only.
    }
  }, [nickname])

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
          dragOverKeyRef.current = null
          setDraggingKey(null)
          setDragOverKey(null)
          break
        case 'claimFeedback':
          if (roomRef.current && incoming.playerId === roomRef.current.you) {
            setMyClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          } else {
            setOpponentClaim({ cardKey: incoming.cardKey, correct: incoming.correct })
          }
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
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!round || !audio) {
      if (audio) audio.pause()
      return
    }

    audio.src = round.audioUrl
    audio.load()
    const localStart = socket.toLocalTime(round.startAtServerTime)
    const playTimer = window.setTimeout(() => {
      void audio.play().catch(() => undefined)
    }, Math.max(0, localStart - Date.now()))
    const updateRemaining = () => {
      const left = localStart + round.windowMs - Date.now()
      setRoundRemaining(Math.max(0, left))
    }
    updateRemaining()
    const remainingTimer = window.setInterval(updateRemaining, 100)
    return () => {
      window.clearTimeout(playTimer)
      window.clearInterval(remainingTimer)
      audio.pause()
    }
  }, [round, socket])

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
    const keys = room?.players[room.you]?.handCardKeys || []
    setBoardOrder((previous) => {
      const next = [...previous.filter((key) => keys.includes(key)), ...keys.filter((key) => !previous.includes(key))]
      if (next.length === previous.length && next.every((key, index) => key === previous[index])) return previous
      return next
    })
    setPinnedKeys((previous) => new Set([...previous].filter((key) => keys.includes(key))))
    if (!keys.length) {
      draggingKeyRef.current = null
      dragOverKeyRef.current = null
      setDraggingKey(null)
      setDragOverKey(null)
    }
  }, [room])

  const displayDeck = useMemo(() => {
    if (roomDeck?.sourcePackageId === room?.packageId) return roomDeck
    if (selectedDeck?.sourcePackageId === room?.packageId) return selectedDeck
    return roomDeck
  }, [room, roomDeck, selectedDeck])

  const localCards = useMemo(() => {
    const map = new Map<string, CardEntry>()
    for (const card of displayDeck?.cards || []) map.set(onlineCardKey(card), card)
    return map
  }, [displayDeck])

  const orderedRoomCards = useMemo(() => {
    return roomCards.slice(0, MAX_HAND_SLOTS)
  }, [roomCards])

  useEffect(() => {
    if (!room?.packageId || displayDeck?.sourcePackageId === room.packageId || syncingPackage.current === room.packageId) {
      return
    }
    const packageId = room.packageId
    let cancelled = false
    syncingPackage.current = packageId
    setPackageProgress({ stage: 'reading', current: 0, total: 0, fileName: packageId })
    void (async () => {
      try {
        const known = decks.find((item) => item.sourcePackageId === packageId)
        if (known) {
          const found = await getDeck(known.id)
          if (!cancelled && found) setRoomDeck(found)
          return
        }

        const available = await listServerPackages()
        const serverPackage = available.find((item) => item.id === packageId)
        if (!serverPackage) throw new Error('房间使用的数据包当前不在服务器上')
        const blob = await downloadServerPackage(serverPackage.id, serverPackage.size, ({ loaded, total }) => {
          if (!cancelled) {
            setPackageProgress({ stage: 'reading', current: loaded, total, fileName: serverPackage.fileName })
          }
        })
        const imported = await importDeckZip(
          new File([blob], serverPackage.fileName, { type: 'application/zip' }),
          serverPackage.name,
          (progress) => {
            if (!cancelled) setPackageProgress(progress)
          },
          serverPackage.mode,
        )
        const synced = { ...imported, sourcePackageId: serverPackage.id }
        await saveDeck(synced)
        if (!cancelled) {
          setRoomDeck(synced)
          await refreshDecks()
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '无法同步房间卡面')
      } finally {
        syncingPackage.current = null
        if (!cancelled) setPackageProgress(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [decks, displayDeck, refreshDecks, room?.packageId])

  const eligibleCards = useMemo(
    () => selectedDeck?.cards.filter((card) => card.songs.length) || [],
    [selectedDeck],
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
  const hasLocalRoomDeck = Boolean(displayDeck?.sourcePackageId === room?.packageId && localCards.size)
  const ownHandKeys = me?.handCardKeys || EMPTY_CARD_KEYS
  const opponentHandKeys = opponent?.handCardKeys || EMPTY_CARD_KEYS
  const orderedHandCards = useMemo(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    const order = boardOrder.length ? boardOrder : ownHandKeys
    return order.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card))
  }, [boardOrder, ownHandKeys, roomCards])
  const draftPoolCards = useMemo(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    return room?.draft.poolCardKeys.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card)) || []
  }, [room?.draft.poolCardKeys, roomCards])
  const draftExchangeCards = useMemo(() => {
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    return room?.draft.exchangeCardKeys.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card)) || []
  }, [room?.draft.exchangeCardKeys, roomCards])
  const canArrange = Boolean((room?.phase === 'arrange' || room?.phase === 'playing') && !round && !matchOver)

  const createRoom = useCallback(async () => {
    if (!selectedDeck) return setMessage('请先选择本地数据集')
    if (!selectedDeck.sourcePackageId) {
      setMessage('在线房间需要服务器数据包，请先在首页加载服务器数据包')
      return
    }
    const cards = selectedDeck.cards.filter((card) => selectedIds.has(card.id) && card.songs.length)
    if (cards.length < MIN_CANDIDATE_CARDS || cards.length % 2 !== 0) {
      setMessage(`在线歌牌需要选择至少 ${MIN_CANDIDATE_CARDS} 张卡牌，且数量必须为偶数`)
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
        packageId: selectedDeck.sourcePackageId,
        deckName: selectedDeck.name,
        cards: cards.slice(0, MAX_CANDIDATE_CARDS).map(toOnlineCardInput),
      })
      if (!sent) throw new Error('在线连接已断开，请重试')
      setRoomDeck(selectedDeck)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建房间失败')
    } finally {
      setBusy(false)
    }
  }, [nickname, roomName, selectedDeck, selectedIds, socket])

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
    setRoomDeck(null)
    setRound(null)
    setLastResult(null)
    setMatchOver(null)
    setMyClaim(null)
    setOpponentClaim(null)
    setDraftSelection(new Set())
    setDraftBans(new Set())
    setBoardOrder([])
    setPinnedKeys(new Set())
    setPinMode(false)
    setMessage(null)
    void socket.connect().then(() => socket.send({ t: 'listRooms' }))
  }, [socket])

  const moveCard = useCallback(
    (sourceKey: string, targetKey: string) => {
      if (!canArrange || !sourceKey || sourceKey === targetKey) return
      setBoardOrder((previous) => {
        const next = [...(previous.length ? previous : ownHandKeys)]
        const sourceIndex = next.indexOf(sourceKey)
        const targetIndex = next.indexOf(targetKey)
        if (sourceIndex < 0 || targetIndex < 0) return previous
        const [moved] = next.splice(sourceIndex, 1)
        next.splice(targetIndex, 0, moved)
        return next
      })
    },
    [canArrange, ownHandKeys],
  )

  const clearDrag = useCallback(() => {
    draggingKeyRef.current = null
    dragOverKeyRef.current = null
    setDraggingKey(null)
    setDragOverKey(null)
  }, [])

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange) {
        event.preventDefault()
        return
      }
      draggingKeyRef.current = cardKey
      dragOverKeyRef.current = cardKey
      setDraggingKey(cardKey)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', cardKey)
    },
    [canArrange],
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange || !draggingKeyRef.current) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      dragOverKeyRef.current = cardKey
      setDragOverKey(cardKey)
    },
    [canArrange],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>, targetKey: string) => {
      if (!canArrange) return
      event.preventDefault()
      const sourceKey = event.dataTransfer.getData('text/plain') || draggingKeyRef.current || ''
      moveCard(sourceKey, targetKey)
      clearDrag()
    },
    [canArrange, clearDrag, moveCard],
  )

  const handleDragEnd = clearDrag

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, cardKey: string) => {
      if (!canArrange) return
      event.preventDefault()
      draggingKeyRef.current = cardKey
      dragOverKeyRef.current = cardKey
      setDraggingKey(cardKey)
      setDragOverKey(cardKey)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [canArrange],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!canArrange || !draggingKeyRef.current) return
      const hovered = document.elementFromPoint(event.clientX, event.clientY)
      const cardElement = hovered instanceof HTMLElement ? hovered.closest<HTMLElement>('[data-online-card-key]') : null
      const cardKey = cardElement?.dataset.onlineCardKey
      if (!cardKey || !ownHandKeys.includes(cardKey) || cardKey === dragOverKeyRef.current) return
      dragOverKeyRef.current = cardKey
      setDragOverKey(cardKey)
    },
    [canArrange, ownHandKeys],
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (canArrange && draggingKeyRef.current && dragOverKeyRef.current) {
        moveCard(draggingKeyRef.current, dragOverKeyRef.current)
      }
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [canArrange, clearDrag, moveCard],
  )

  const handlePointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      clearDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    [clearDrag],
  )

  function toggleSelected(card: CardEntry) {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(card.id)) next.delete(card.id)
      else if (next.size < boardCount) next.add(card.id)
      else setMessage(`本局最多选择 ${boardCount} 张卡牌`)
      return next
    })
  }

  function setBoardSize(value: number) {
    const input = Number.isFinite(value) ? Math.round(value) : DEFAULT_CANDIDATE_CARDS
    let nextSize = Math.max(MIN_CANDIDATE_CARDS, Math.min(MAX_CANDIDATE_CARDS, input || DEFAULT_CANDIDATE_CARDS))
    if (nextSize % 2 !== 0) nextSize -= 1
    setBoardCount(nextSize)
    setSelectedIds((previous) => new Set([...previous].slice(0, nextSize)))
  }

  function selectAllCandidates() {
    const nextSize = Math.min(MAX_CANDIDATE_CARDS, eligibleCards.length)
    const evenSize = nextSize - (nextSize % 2)
    setBoardCount(evenSize)
    setSelectedIds(new Set(eligibleCards.slice(0, evenSize).map((card) => card.id)))
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

  function togglePinned(cardKey: string) {
    setPinnedKeys((previous) => {
      const next = new Set(previous)
      if (next.has(cardKey)) next.delete(cardKey)
      else next.add(cardKey)
      return next
    })
  }

  function sortOwnHand(mode: 'random' | 'name') {
    setBoardOrder((previous) => {
      const current = (previous.length ? previous : ownHandKeys).filter((key) => ownHandKeys.includes(key))
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
      const next = [...current]
      let movableIndex = 0
      for (let index = 0; index < next.length; index += 1) {
        if (!pinnedKeys.has(next[index])) next[index] = movable[movableIndex++]
      }
      return next
    })
  }

  function claimCard(cardKey: string) {
    if (!room || !round || myClaim || room.pendingTransfer || (cardKey && !room.remainingCardKeys.includes(cardKey))) return
    if (!socket.send({ t: 'claim', roundNo: round.roundNo, cardKey, clientAt: Math.max(0, round.windowMs - roundRemaining) })) {
      setMessage('连接已断开，本次抢牌没有送达')
      return
    }
    setMyClaim({ cardKey, correct: null })
  }

  function giveCard(cardKey: string) {
    if (!socket.send({ t: 'giveCard', cardKey })) setMessage('连接已断开，转牌没有送达')
  }

  function unlockAudio() {
    const audio = audioRef.current
    if (!audio) return
    const previousMuted = audio.muted
    audio.muted = true
    void audio
      .play()
      .then(() => {
        audio.pause()
        audio.currentTime = 0
      })
      .catch(() => undefined)
      .finally(() => {
        audio.muted = previousMuted
      })
  }

  if (!room) {
    return (
      <div className="online-page">
        <section className="hero">
          <div className="row spread">
            <div>
              <h1>在线 1v1 歌牌对战</h1>
              <p>双方看到同一组 HITsz-JLA 卡面，听到歌曲后抢先点击对应卡牌。</p>
            </div>
            <span className={`connection-chip${connected ? ' online' : ''}`}>
              {connected ? '在线服务已连接' : '正在连接…'}
            </span>
          </div>
        </section>

        <div className="online-lobby-grid">
          <section className="panel warm stack">
            <div className="row spread">
              <strong>创建房间</strong>
              <span className="muted small">同一数据包才能显示 HITsz-JLA 卡面</span>
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
              <label htmlFor="onlineDeck">使用数据集</label>
              <select id="onlineDeck" value={activeDeckId} onChange={(event) => setSelectedDeckId(event.target.value)} disabled={decksLoading}>
                <option value="">请选择数据集</option>
                {decks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.cardCount} 张{item.sourcePackageId ? '' : '（需服务器包）'}
                  </option>
                ))}
              </select>
            </div>
            {selectedDeck && !selectedDeck.sourcePackageId ? (
              <p className="notice warn">当前是本地手工数据集。在线音频由服务器数据包按房间提供，请先回首页加载服务器数据包。</p>
            ) : null}
            <div className="row">
              <div className="field" style={{ flex: '0 0 120px' }}>
                 <label htmlFor="boardCount">候选牌数量</label>
                 <input id="boardCount" type="number" min={MIN_CANDIDATE_CARDS} max={MAX_CANDIDATE_CARDS} step={2} value={boardCount} onChange={(event) => setBoardSize(Number(event.target.value))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="onlineSearch">筛选卡面</label>
                <input id="onlineSearch" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="作品名或牌号" />
              </div>
            </div>
            <div className="row spread draft-selection-summary">
              <p className="muted small">已选 {selectedIds.size} / {boardCount} 张；开局会随机拆成两份，每方再选 30 张。</p>
              <button className="btn btn-secondary" type="button" onClick={selectAllCandidates} disabled={!eligibleCards.length}>全选可用牌</button>
            </div>
            <div className="online-select-grid">
              {selectedDeckLoading ? <div className="empty-state">正在加载本地卡面…</div> : null}
              {!selectedDeckLoading
                ? visibleCards.map((card) => (
                    <OnlineCardTile
                      key={card.id}
                      meta={cardMeta(card)}
                      card={card}
                      available
                      picked={selectedIds.has(card.id)}
                      onClick={() => toggleSelected(card)}
                    />
                  ))
                : null}
            </div>
            {!eligibleCards.length && !selectedDeckLoading ? <div className="empty-state">没有可用于在线对战的卡牌</div> : null}
            <button className="btn btn-primary btn-lg" type="button" onClick={() => void createRoom()} disabled={busy || !connected}>
              {busy ? '创建中…' : '创建歌牌房间'}
            </button>
          </section>

          <section className="panel cool stack">
            <strong>加入房间</strong>
            <p className="muted small">输入朋友分享的 6 位房间码；若本机没有同一数据包，页面会自动从服务器同步。</p>
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
               <span className="muted small">3. 开局排牌 3 分钟：只可调整自己的 3×9 牌区</span>
               <span className="muted small">4. 空牌或选错会暂停抢牌，由对手选择转来一张牌</span>
            </div>
            <Link className="btn btn-secondary" to="/">
              回首页加载或管理数据包
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
          <p className="muted small">把房间码分享给对手。双方看到的是真实卡面，歌名不会在开局前下发。</p>
        </section>

        <section className="panel stack">
          <div className="versus-players">
            <PlayerBadge player={room.players.A} mine={room.you === 'A'} />
            <span className="versus-mark">VS</span>
            <PlayerBadge player={room.players.B} mine={room.you === 'B'} />
          </div>
          <NetworkFairness room={room} />
          {!hasLocalRoomDeck ? (
            <div className="notice warn">{formatPackageProgress(packageProgress) || '正在准备本地卡面库…'}</div>
          ) : null}
          <div className="online-board compact">
            {orderedRoomCards.map((meta) => (
              <OnlineCardTile key={meta.key} meta={meta} card={localCards.get(meta.key) || null} available={false} />
            ))}
          </div>
          <div className="row spread">
             <span className="muted small">候选牌 {room.cards.length} 张 · 准备后进入选牌、互换和 BAN</span>
            <button className="btn btn-primary btn-lg" type="button" disabled={!opponent || !hasLocalRoomDeck || !room.fairness.canStart} onClick={() => socket.send({ t: 'ready', ready: !ready })}>
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
          localCards={localCards}
          selected={draftSelection}
          limit={DRAFT_SELECTION_SIZE}
          opponentCount={room.draft.opponentSelectedCount}
          opponentLabel="对手已选"
          submitLabel="确认 30 张并进入互换"
          onToggle={(key) => toggleDraftCard(key, DRAFT_SELECTION_SIZE, setDraftSelection)}
          onSubmit={submitDraftSelection}
        />
        {packageProgress ? <div className="notice">{formatPackageProgress(packageProgress)}</div> : null}
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
          localCards={localCards}
          selected={draftBans}
          limit={BAN_SIZE}
          opponentCount={room.draft.opponentBannedCount}
          opponentLabel="对手已 BAN"
          submitLabel="确认 BAN 5 张并进入排牌"
          onToggle={(key) => toggleDraftCard(key, BAN_SIZE, setDraftBans)}
          onSubmit={submitDraftBan}
        />
        {packageProgress ? <div className="notice">{formatPackageProgress(packageProgress)}</div> : null}
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
          <p className="muted small">完成 {matchOver?.rounds || room.roundNo} / {room.totalRounds} 回合</p>
          <button className="btn btn-primary btn-lg" type="button" onClick={leaveRoom}>返回在线大厅</button>
        </section>
        {message ? <div className="toast">{message}</div> : null}
      </div>
    )
  }

  const resultMeta = lastResult ? room.cards.find((card) => card.key === lastResult.cardKey) || null : null
  const resultCard = resultMeta ? localCards.get(resultMeta.key) || null : null
  const scores = lastResult?.scores || { A: room.players.A?.score || 0, B: room.players.B?.score || 0 }
  const isOpeningArrange = room.phase === 'arrange'
  const canClaim = Boolean(round && !myClaim && !lastResult && !room.pendingTransfer)

  return (
    <div className="online-page">
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>{isOpeningArrange ? '开局排牌准备' : '歌牌对战进行中'}</h1>
            <p>
              {isOpeningArrange
                ? `剩余 ${Math.ceil(arrangeRemaining / 1000)} 秒完成自己的牌区布局 · ${ownHandKeys.length} 张手牌`
                : `第 ${room.roundNo || round?.roundNo || 0} / ${room.totalRounds} 回合 · 剩余卡牌 ${room.remainingCardKeys.length}`}
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={leaveRoom}>退出本局</button>
        </div>
      </section>

      <div className="versus-scorebar">
        <ScoreCard player={room.players[room.you]} score={scores[room.you]} winner={false} mine />
        <span className="versus-mark">VS</span>
        <ScoreCard player={room.players[otherPlayer(room.you)]} score={scores[otherPlayer(room.you)]} winner={false} />
      </div>
      <NetworkFairness room={room} compact />

      {canArrange ? (
        <div className="arrange-hint" role="status">
          <strong>{isOpeningArrange ? '开局排牌' : '休息阶段'}</strong>
          <span>只能调整你自己的牌区；最多 3 排、每排 9 列，布局只保存在本机。</span>
        </div>
      ) : null}
      {canArrange ? (
        <div className="arrange-toolbar" role="toolbar" aria-label="牌区布局工具">
          <span className="muted small">布局工具</span>
          <button className="btn btn-secondary" type="button" onClick={() => sortOwnHand('random')}>随机排</button>
          <button className="btn btn-secondary" type="button" onClick={() => sortOwnHand('name')}>按名称排</button>
          <button className={`btn btn-secondary${pinMode ? ' active' : ''}`} type="button" onClick={() => setPinMode((previous) => !previous)}>
            {pinMode ? '完成固定牌位' : '固定牌位'}
          </button>
          {pinMode ? <span className="muted small">点击自己的牌固定/取消固定，再使用排序按钮。</span> : null}
        </div>
      ) : null}
      <div className="status-banner">
        {isOpeningArrange
          ? `排牌准备中 · ${Math.ceil(arrangeRemaining / 1000)} 秒后自动开始`
          : myClaim?.correct === false
            ? room.pendingTransfer?.from === room.you
              ? '你抢错了，等待对手选择一张牌转给你'
              : '你抢错了，等待转牌处理'
            : myClaim?.correct
              ? '抢牌成功，等待结算'
              : opponentClaim
                ? '对手已经出手，等待结算'
                : room.pendingTransfer?.to === room.you
                  ? '请从自己的牌区选择一张牌转给对手'
                  : round
                    ? `听歌抢牌 · ${Math.ceil(roundRemaining / 1000)} 秒`
                    : '准备下一回合…'}
      </div>

      {room.pendingTransfer ? (
        <TransferPanel
          room={room}
          cards={room.cards}
          localCards={localCards}
          onGiveCard={giveCard}
        />
      ) : null}

      <section className="panel stack online-game-panel">
        <div className="row spread">
          <strong>{isOpeningArrange ? '你的起始牌区' : '双方牌区'}</strong>
          <div className="row">
            <span className="chip">本回合 {round ? `#${round.roundNo}` : '揭晓'}</span>
            <button className="btn btn-secondary" type="button" onClick={unlockAudio}>启用音频</button>
          </div>
        </div>
        <p className="muted small">卡面图片来自当前 HITsz-JLA 数据包；抢牌时点击双方牌区中的对应卡面，空槽点击也会按选错处理。</p>
        <HandArea
          title={`你的牌区 · ${ownHandKeys.length}/${MAX_HAND_SLOTS}`}
          cards={orderedHandCards}
          localCards={localCards}
          mine
          canArrange={canArrange}
          pinMode={pinMode}
          pinnedKeys={pinnedKeys}
          draggingKey={draggingKey}
          dragOverKey={dragOverKey}
          claimable={canClaim}
          resultKey={lastResult?.cardKey || null}
          pickedKey={myClaim?.cardKey || null}
          onCardClick={pinMode && canArrange ? togglePinned : claimCard}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
        <HandArea
          title={`对手牌区 · ${opponentHandKeys.length}/${MAX_HAND_SLOTS}`}
          cards={opponentHandKeys.map((key) => room.cards.find((card) => card.key === key)).filter((card): card is OnlineCardView => Boolean(card))}
          localCards={localCards}
          claimable={canClaim}
          resultKey={lastResult?.cardKey || null}
          pickedKey={opponentClaim?.cardKey || null}
          onCardClick={claimCard}
        />
      </section>

      {lastResult && resultMeta ? (
        <section className="panel cool online-result stack">
          <div className="row spread">
            <strong>{lastResult.winner ? `${room.players[lastResult.winner]?.nickname || '玩家'} 收取了这张卡` : '本回合无人收取'}</strong>
            <span className="muted small">{lastResult.reason === 'timeout' ? '时间到' : '抢牌结算'}</span>
          </div>
          <div className="online-result-body">
            <OnlineCardTile meta={resultMeta} card={resultCard} available result />
            <div className="stack">
              <span className="muted small">对应歌曲</span>
              <strong>{lastResult.song.displayName}</strong>
              <span className="muted small">下一回合即将开始，请继续看着卡面。</span>
            </div>
          </div>
        </section>
      ) : null}

      {packageProgress ? <div className="notice">{formatPackageProgress(packageProgress)}</div> : null}
      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}

interface DraftCardPickerProps {
  title: string
  description: string
  cards: OnlineCardView[]
  localCards: Map<string, CardEntry>
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
  localCards,
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
            card={localCards.get(meta.key) || null}
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
  cards: OnlineCardView[]
  localCards: Map<string, CardEntry>
  mine?: boolean
  canArrange?: boolean
  pinMode?: boolean
  pinnedKeys?: Set<string>
  draggingKey?: string | null
  dragOverKey?: string | null
  claimable?: boolean
  resultKey?: string | null
  pickedKey?: string | null
  onCardClick?: (key: string) => void
  onDragStart?: (event: DragEvent<HTMLButtonElement>, cardKey: string) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>, cardKey: string) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>, cardKey: string) => void
  onDragEnd?: () => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>, cardKey: string) => void
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void
}

function HandArea({
  title,
  cards,
  localCards,
  mine = false,
  canArrange = false,
  pinMode = false,
  pinnedKeys = new Set<string>(),
  draggingKey = null,
  dragOverKey = null,
  claimable = false,
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
  const emptySlots = Math.max(0, MAX_HAND_SLOTS - cards.length)
  return (
    <section className={`hand-area${mine ? ' mine' : ''}`}>
      <div className="row spread hand-area-heading">
        <strong>{title}</strong>
        <span className="muted small">{mine ? (canArrange ? (pinMode ? '点击固定牌位' : '可拖动调整') : '你的牌区') : '点击卡面抢牌'}</span>
      </div>
      <div className="hand-grid-scroll">
        <div className="online-hand-grid">
          {cards.map((meta) => (
            <OnlineCardTile
              key={meta.key}
              meta={meta}
              card={localCards.get(meta.key) || null}
              available={claimable && !canArrange}
              picked={pickedKey === meta.key}
              result={resultKey === meta.key}
              pinned={pinnedKeys.has(meta.key)}
              stateLabel={canArrange ? '可调整位置' : undefined}
              draggable={draggable}
              dragging={draggingKey === meta.key}
              dropTarget={dragOverKey === meta.key && draggingKey !== meta.key}
              onDragStart={onDragStart ? (event) => onDragStart(event, meta.key) : undefined}
              onDragOver={onDragOver ? (event) => onDragOver(event, meta.key) : undefined}
              onDrop={onDrop ? (event) => onDrop(event, meta.key) : undefined}
              onDragEnd={onDragEnd}
              onPointerDown={onPointerDown ? (event) => onPointerDown(event, meta.key) : undefined}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onClick={onCardClick ? () => onCardClick(meta.key) : undefined}
            />
          ))}
          {Array.from({ length: emptySlots }, (_, index) => (
            <button
              key={`empty-${index}`}
              className="online-empty-slot"
              type="button"
              disabled={!claimable || canArrange || !onCardClick}
              onClick={() => onCardClick?.('')}
              aria-label="空牌位"
            >
              <span>空牌位</span>
              <small>点击算选错</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function TransferPanel({
  room,
  cards,
  localCards,
  onGiveCard,
}: {
  room: OnlineRoomView
  cards: OnlineCardView[]
  localCards: Map<string, CardEntry>
  onGiveCard: (cardKey: string) => void
}) {
  const pending = room.pendingTransfer
  if (!pending) return null
  const isGiver = pending.to === room.you
  const giverKeys = room.players[room.you]?.handCardKeys || []
  const cardByKey = new Map(cards.map((card) => [card.key, card]))
  const giverCards = giverKeys.map((key) => cardByKey.get(key)).filter((card): card is OnlineCardView => Boolean(card))
  return (
    <section className={`panel transfer-panel${isGiver ? ' choosing' : ''}`} role="alert">
      <div className="row spread">
        <strong>{isGiver ? '请转给对手一张牌' : '等待对手转来一张牌'}</strong>
        <span className="chip">8 秒内处理</span>
      </div>
      <p className="muted small">
        {isGiver
          ? `对手（${room.players[pending.from]?.nickname || '玩家'}）刚才选错了，请从你自己的牌区点击一张牌转给对手。`
          : '本回合暂时停止抢牌；对手选择完成后会恢复。超时未选择时系统会自动随机转牌。'}
      </p>
      {isGiver ? (
        <div className="transfer-card-grid">
          {giverCards.map((meta) => (
            <OnlineCardTile
              key={meta.key}
              meta={meta}
              card={localCards.get(meta.key) || null}
              available
              stateLabel="点击转牌"
              onClick={() => onGiveCard(meta.key)}
            />
          ))}
        </div>
      ) : null}
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
  const statusLabel = fairness.status === 'ready' ? '可开始' : fairness.status === 'unfair' ? '不适合公平对战' : '测量中'
  const metric = (player: OnlineRoomView['players']['A']) => {
    if (!player) return '等待玩家'
    return `RTT ${formatNetworkMetric(player.network.rttMs)} · 抖动 ${formatNetworkMetric(player.network.jitterMs)} · ${player.network.samples} 次`
  }

  return (
    <div className={`network-fairness ${fairness.status}${compact ? ' compact' : ''}`} role={fairness.status === 'unfair' ? 'alert' : 'status'}>
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
