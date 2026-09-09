import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react'
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

const MAX_BOARD_CARDS = 24
const DEFAULT_BOARD_CARDS = 8

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
  const [boardCount, setBoardCount] = useState(DEFAULT_BOARD_CARDS)
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
  const draggingKeyRef = useRef<string | null>(null)
  const dragOverKeyRef = useRef<string | null>(null)
  const roomCards = useMemo(() => room?.cards || [], [room?.cards])

  useEffect(() => {
    if (!selectedDeck) return
    const eligible = selectedDeck.cards.filter((card) => card.songs.length)
    setSelectedIds(new Set(eligible.slice(0, Math.min(boardCount, MAX_BOARD_CARDS)).map((card) => card.id)))
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
          roomRef.current = incoming.room
          setRoom(incoming.room)
          setLastResult((previous) => (incoming.room.phase === 'playing' ? previous : null))
          if (incoming.room.phase === 'lobby') {
            setRound(null)
            setMatchOver(null)
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
    const keys = roomCards.map((card) => card.key)
    setBoardOrder((previous) => {
      const next = [...previous.filter((key) => keys.includes(key)), ...keys.filter((key) => !previous.includes(key))]
      if (next.length === previous.length && next.every((key, index) => key === previous[index])) return previous
      return next
    })
    if (!keys.length) {
      draggingKeyRef.current = null
      dragOverKeyRef.current = null
      setDraggingKey(null)
      setDragOverKey(null)
    }
  }, [roomCards])

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
    const byKey = new Map(roomCards.map((card) => [card.key, card]))
    const order = boardOrder.length ? boardOrder : roomCards.map((card) => card.key)
    return order.map((key) => byKey.get(key)).filter((card): card is OnlineCardView => Boolean(card))
  }, [boardOrder, roomCards])

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
  const canArrange = Boolean(room?.phase === 'playing' && !round && !matchOver)

  const createRoom = useCallback(async () => {
    if (!selectedDeck) return setMessage('请先选择本地数据集')
    if (!selectedDeck.sourcePackageId) {
      setMessage('在线房间需要服务器数据包，请先在首页加载服务器数据包')
      return
    }
    const cards = selectedDeck.cards.filter((card) => selectedIds.has(card.id) && card.songs.length)
    if (cards.length < 2) {
      setMessage('在线歌牌至少需要选择 2 张有歌曲的卡牌')
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
        cards: cards.slice(0, MAX_BOARD_CARDS).map(toOnlineCardInput),
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
    roomRef.current = null
    setRoom(null)
    setRoomDeck(null)
    setRound(null)
    setLastResult(null)
    setMatchOver(null)
    setMyClaim(null)
    setOpponentClaim(null)
    setMessage(null)
    void socket.connect().then(() => socket.send({ t: 'listRooms' }))
  }, [socket])

  const moveCard = useCallback(
    (sourceKey: string, targetKey: string) => {
      if (!canArrange || !sourceKey || sourceKey === targetKey) return
      setBoardOrder((previous) => {
        const next = [...(previous.length ? previous : roomCards.map((card) => card.key))]
        const sourceIndex = next.indexOf(sourceKey)
        const targetIndex = next.indexOf(targetKey)
        if (sourceIndex < 0 || targetIndex < 0) return previous
        const [moved] = next.splice(sourceIndex, 1)
        next.splice(targetIndex, 0, moved)
        return next
      })
    },
    [canArrange, roomCards],
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
      if (!cardKey || !roomCards.some((card) => card.key === cardKey) || cardKey === dragOverKeyRef.current) return
      dragOverKeyRef.current = cardKey
      setDragOverKey(cardKey)
    },
    [canArrange, roomCards],
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
    const nextSize = Math.max(2, Math.min(MAX_BOARD_CARDS, value || DEFAULT_BOARD_CARDS))
    setBoardCount(nextSize)
    setSelectedIds((previous) => new Set([...previous].slice(0, nextSize)))
  }

  function claimCard(cardKey: string) {
    if (!room || !round || myClaim || !room.remainingCardKeys.includes(cardKey)) return
    if (!socket.send({ t: 'claim', roundNo: round.roundNo, cardKey, clientAt: Math.max(0, round.windowMs - roundRemaining) })) {
      setMessage('连接已断开，本次抢牌没有送达')
      return
    }
    setMyClaim({ cardKey, correct: null })
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
              <span className="muted small">同一数据包才能显示卡面</span>
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
                <label htmlFor="boardCount">卡牌数量</label>
                <input id="boardCount" type="number" min={2} max={MAX_BOARD_CARDS} value={boardCount} onChange={(event) => setBoardSize(Number(event.target.value))} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="onlineSearch">筛选卡面</label>
                <input id="onlineSearch" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="作品名或牌号" />
              </div>
            </div>
            <p className="muted small">已选 {selectedIds.size} / {boardCount} 张；每张卡牌至少需要一首歌曲。</p>
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
              <span className="muted small">1. 房主选卡并分享房间码</span>
              <span className="muted small">2. 双方准备后开始听歌</span>
              <span className="muted small">3. 点击对应卡面，先点中者得分</span>
              <span className="muted small">4. 歌名只在每回合结算时显示</span>
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
            <span className="muted small">卡牌 {room.totalRounds} 张 · 双方准备后自动开局</span>
            <button className="btn btn-primary btn-lg" type="button" disabled={!opponent || !hasLocalRoomDeck || !room.fairness.canStart} onClick={() => socket.send({ t: 'ready', ready: !ready })}>
              {ready ? '取消准备' : '准备开始'}
            </button>
          </div>
        </section>
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

  return (
    <div className="online-page">
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>歌牌对战进行中</h1>
            <p>第 {room.roundNo || round?.roundNo || 0} / {room.totalRounds} 回合 · 剩余卡牌 {room.remainingCardKeys.length}</p>
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
          <strong>休息阶段</strong>
          <span>拖动卡面调整你这一侧的位置；布局只保存在本机。</span>
        </div>
      ) : null}
      <div className="status-banner">
        {myClaim?.correct === false ? '你抢错了，本回合等待结算' : myClaim?.correct ? '抢牌成功，等待结算' : opponentClaim ? '对手已经出手，等待结算' : round ? `听歌抢牌 · ${Math.ceil(roundRemaining / 1000)} 秒` : '准备下一回合…'}
      </div>

      <section className="panel stack online-game-panel">
        <div className="row spread">
          <strong>卡面场</strong>
          <div className="row">
            <span className="chip">本回合 {round ? `#${round.roundNo}` : '揭晓'}</span>
            <button className="btn btn-secondary" type="button" onClick={unlockAudio}>启用音频</button>
          </div>
        </div>
        <p className="muted small">点击你认为对应的卡面；卡面图片来自当前 HITsz-JLA 数据包。</p>
        <div className="online-board">
          {orderedRoomCards.map((meta) => (
            <OnlineCardTile
              key={meta.key}
              meta={meta}
              card={localCards.get(meta.key) || null}
              available={room.remainingCardKeys.includes(meta.key) && !myClaim && !lastResult}
              picked={myClaim?.cardKey === meta.key || opponentClaim?.cardKey === meta.key}
              result={lastResult?.cardKey === meta.key}
              draggable={canArrange}
              dragging={draggingKey === meta.key}
              dropTarget={dragOverKey === meta.key && draggingKey !== meta.key}
              onDragStart={(event) => handleDragStart(event, meta.key)}
              onDragOver={(event) => handleDragOver(event, meta.key)}
              onDrop={(event) => handleDrop(event, meta.key)}
              onDragEnd={handleDragEnd}
              onPointerDown={(event) => handlePointerDown(event, meta.key)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onClick={() => claimCard(meta.key)}
            />
          ))}
        </div>
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
