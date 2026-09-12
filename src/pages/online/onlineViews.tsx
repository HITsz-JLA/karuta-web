import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent, type PointerEvent, type UIEvent } from 'react'
import { OnlineCardTile } from '../../components/OnlineCardTile'
import {
  type OnlineCardView,
  type OnlineNetworkView,
  type OnlinePlayerId,
  type OnlineRoundResult,
  type OnlineRoundStart,
  type OnlineRoomView,
  type OnlineServerMessage,
} from '../../lib/onlineProtocol'
import { OnlineSocket } from '../../lib/onlineSocket'
import type { ServerPackageCatalogCard } from '../../lib/serverPackages'
import { MAX_HAND_SLOTS } from './onlineConstants'
import type { BattleAnimation, BattleStyle, ClaimState } from './onlineTypes'
import {
  clampOnlineVolume,
  formatNetworkMetric,
  handCardsForSpectator,
  otherPlayer,
  packageCardMeta,
  playerName,
} from './onlineHelpers'

export function BattleAnimationOverlay({ event, room }: { event: BattleAnimation | null; room: OnlineRoomView }) {
  if (!event) return null
  const card = room.cards.find((item) => item.key === event.cardKey)
  if (!card) return null
  const exchangeCard = event.kind === 'layout' && event.exchangeCardKey
    ? room.cards.find((item) => item.key === event.exchangeCardKey) || null
    : null
  const playerId = event.kind === 'transfer' ? event.to : event.kind === 'discard' ? event.winner : event.playerId

  const title =
    event.kind === 'claim'
      ? `${playerName(room, event.playerId)} 取到了牌`
      : event.kind === 'wrong'
        ? `${playerName(room, event.playerId)} 选错了`
        : event.kind === 'transfer'
          ? `${playerName(room, event.from)} → ${playerName(room, event.to)} 交牌`
          : event.kind === 'discard'
            ? `${event.winner ? playerName(room, event.winner) : '无人'} ${event.winner ? '的牌' : '选中的牌'}进入弃牌堆`
            : `${playerName(room, event.playerId)} 调整牌位`
  const detail =
    event.kind === 'claim'
      ? '正确抢牌 · 正在结算'
      : event.kind === 'wrong'
        ? '错误标记 · 目标牌仍留在场上'
        : event.kind === 'transfer'
          ? event.automatic
            ? '超时自动交牌'
            : '休息阶段交牌'
          : event.kind === 'discard'
            ? event.winner
              ? `放入${playerName(room, event.winner)}的弃牌堆`
              : '无人收取 · 放入公共弃牌堆'
            : event.exchangeCardKey
              ? `第 ${event.sourceSlot + 1} 与第 ${(event.targetSlot || 0) + 1} 个槽位交换`
              : event.targetSlot === null
                ? '交换到新的位置'
                : `放入第 ${event.targetSlot + 1} 个槽位`
  const tileGroupStyle = exchangeCard ? { display: 'flex', alignItems: 'center', gap: '8px' } : undefined

  return (
    <div key={event.id} className={`online-battle-animation online-battle-animation-${event.kind}${playerId ? ` player-${playerId}` : ''}`} role="status" aria-live="polite">
      <div className="online-battle-animation-card">
        <strong>{title}</strong>
        <div style={tileGroupStyle}>
          <OnlineCardTile meta={card} available={false} readOnly result={event.kind === 'claim' || event.kind === 'discard'} wrong={event.kind === 'wrong'} showNumber={false} />
          {exchangeCard ? (
            <>
              <span aria-hidden="true">↔</span>
              <OnlineCardTile meta={exchangeCard} available={false} readOnly showNumber={false} />
            </>
          ) : null}
        </div>
        <span>{detail}</span>
      </div>
    </div>
  )
}

interface SpectatorMatchViewProps {
  room: OnlineRoomView
  round: OnlineRoundStart | null
  lastResult: OnlineRoundResult | null
  claims: Record<OnlinePlayerId, ClaimState | null>
  battleAnimation: BattleAnimation | null
  connected: boolean
  restRemaining: number
  roundRemaining: number
  arrangeRemaining: number
  battleStyle: BattleStyle
  onBattleStyle: (style: BattleStyle) => void
  onLeave: () => void
  onReconnect: () => void
  socket: OnlineSocket
  volume: number
  onVolumeChange: (volume: number) => void
  audioButtonLabel: string
  onUnlockAudio: () => void
  matchOver: Extract<OnlineServerMessage, { t: 'matchOver' }> | null
}

export const SpectatorMatchView = memo(function SpectatorMatchView({
  room,
  round,
  lastResult,
  claims,
  battleAnimation,
  connected,
  restRemaining,
  roundRemaining,
  arrangeRemaining,
  battleStyle,
  onBattleStyle,
  onLeave,
  onReconnect,
  socket,
  volume,
  onVolumeChange,
  audioButtonLabel,
  onUnlockAudio,
  matchOver,
}: SpectatorMatchViewProps) {
  const topCards = useMemo(() => handCardsForSpectator(room, 'A'), [room])
  const bottomCards = useMemo(() => handCardsForSpectator(room, 'B'), [room])
  const phase = room.phase
  const isPlaying = phase === 'playing'
  const showBoard = phase === 'arrange' || isPlaying || phase === 'over'
  const isResting = isPlaying && !round && restRemaining > 0 && !matchOver
  const seconds = phase === 'arrange' && !room.waitingMatchAudio ? Math.ceil(arrangeRemaining / 1000) : round ? Math.ceil(roundRemaining / 1000) : isResting ? Math.ceil(restRemaining / 1000) : 0
  const stage = phase === 'arrange' ? (room.waitingMatchAudio ? '等待场上音频' : '开局排牌') : round ? '听歌抢牌' : isResting ? '休息阶段' : phase === 'playing' ? '等待下一回合' : phase === 'over' || matchOver ? '对局结束' : '对局准备中'
  const resultMeta = lastResult?.cardKey ? room.cards.find((card) => card.key === lastResult.cardKey) || null : null
  const resultWinner = lastResult?.winner || null
  const resultTitle = lastResult
    ? lastResult.reason === 'wrong'
      ? '选错处理完成，目标牌仍在场上'
      : resultWinner
        ? `${playerName(room, resultWinner)} 取到了牌`
        : '本回合无人取牌'
    : null

  return (
    <div className={`online-page online-match-page online-spectator-page online-style-${battleStyle}`}>
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>观战 · {room.name}</h1>
            <p>{room.deckName} · 房间码 <span className="room-code">{room.code}</span></p>
          </div>
          <div className="online-spectator-actions">
            <span className={`connection-chip${connected ? ' online' : ''}`}>{connected ? '观战连接稳定' : '正在重连…'}</span>
            <button className="btn btn-secondary" type="button" onClick={onLeave}>退出观战</button>
          </div>
        </div>
      </section>

      <section className="panel stack online-game-panel online-spectator-panel">
        <div className="online-game-header">
          <div className="online-game-heading">
            <strong>歌牌对战 · 观战视角</strong>
            <span className="muted small">只读模式 · 双方操作、取错标记与交牌动画都会同步显示</span>
          </div>
          <div className="online-game-header-tools">
            <span className="chip">{room.players.A?.connected && room.players.B?.connected ? '双方在线' : '有玩家断线'}</span>
            {!connected ? <button className="btn btn-secondary online-reconnect-button" type="button" onClick={onReconnect}>立即重连</button> : null}
            <div className="online-style-switch" role="group" aria-label="观战视图">
              <span className="online-style-caption">视图</span>
              <button className={`online-style-button${battleStyle === 'text' ? ' active' : ''}`} type="button" aria-pressed={battleStyle === 'text'} onClick={() => onBattleStyle('text')}>文字注重</button>
              <button className={`online-style-button${battleStyle === 'card' ? ' active' : ''}`} type="button" aria-pressed={battleStyle === 'card'} onClick={() => onBattleStyle('card')}>卡面注重</button>
            </div>
          </div>
        </div>

        <div className="online-spectator-scoreboard" aria-label="双方剩余牌数">
          <div className="online-spectator-player player-a">
            <span>{playerName(room, 'A')}</span>
            <strong>{room.players.A?.handCardKeys.length || 0}</strong>
            <small>张牌 · 上方</small>
          </div>
          <div className={`online-spectator-stage${isResting ? ' resting' : ''}`} role="status" aria-live="polite">
            <span>{stage}</span>
            <strong>{seconds ? `${seconds}s` : '—'}</strong>
            <small>{room.remainingCardKeys.length} 张场上牌</small>
          </div>
          <div className="online-spectator-player player-b">
            <span>{playerName(room, 'B')}</span>
            <strong>{room.players.B?.handCardKeys.length || 0}</strong>
            <small>张牌 · 下方</small>
          </div>
        </div>

        {!showBoard ? (
          <div className="online-spectator-waiting" role="status">
            <strong>{stage}</strong>
            <span>观战画面会在对局开始后显示双方的完整牌区。</span>
            <div className="online-spectator-progress">
              <span>A：{room.draft.selectedCount}/30 已选 · {room.draft.bannedCount}/5 BAN</span>
              <span>B：{room.draft.opponentSelectedCount}/30 已选 · {room.draft.opponentBannedCount}/5 BAN</span>
            </div>
          </div>
        ) : (
          <div className="online-spectator-board">
            <HandArea
              title={`${playerName(room, 'A')} · 上方牌区 · ${room.players.A?.handCardKeys.length || 0}/33`}
              slotCards={topCards}
              spectator
              playerId="A"
              wrongKey={claims.A?.correct === false ? claims.A.cardKey : null}
              pickedKey={claims.A?.cardKey || null}
            />
            <div className="online-board-divider online-spectator-divider" aria-hidden="true">
              <span />
              <div className="online-divider-scores">
                <div><strong>{room.players.A?.score || 0}</strong><span>{playerName(room, 'A')}</span></div>
                <strong className="versus-mark">VS</strong>
                <div><span>{playerName(room, 'B')}</span><strong>{room.players.B?.score || 0}</strong></div>
              </div>
              <div className="online-match-status"><strong>{stage}</strong><span>{seconds ? `${seconds} 秒` : '等待服务器结算'}</span></div>
              <span />
            </div>
            <HandArea
              title={`${playerName(room, 'B')} · 下方牌区 · ${room.players.B?.handCardKeys.length || 0}/33`}
              slotCards={bottomCards}
              spectator
              playerId="B"
              wrongKey={claims.B?.correct === false ? claims.B.cardKey : null}
              pickedKey={claims.B?.cardKey || null}
            />
          </div>
        )}

        <aside className="online-spectator-sidebar" aria-label="观战信息">
          <section className="online-sidebar-card online-count-panel online-spectator-count-panel">
            <strong>剩余牌数</strong>
            <span className="player-a-count">{playerName(room, 'A')} <b>{room.players.A?.handCardKeys.length || 0}</b></span>
            <span className="player-b-count">{playerName(room, 'B')} <b>{room.players.B?.handCardKeys.length || 0}</b></span>
            <span>场上实体牌 <b>{room.remainingCardKeys.length}</b></span>
          </section>
          <NetworkFairness socket={socket} you={null} compact />
          <div className="online-audio-control">
            <OnlineVolumeControl volume={volume} onChange={onVolumeChange} />
            <button className="btn btn-secondary online-audio-button" type="button" onClick={onUnlockAudio}>{audioButtonLabel}</button>
          </div>
        </aside>
      </section>

      {battleAnimation ? <BattleAnimationOverlay event={battleAnimation} room={room} /> : null}
      {lastResult && !matchOver ? (
        <div className="online-result-overlay" aria-live="polite">
          <section key={`spectator-result-${lastResult.roundNo}`} className="panel cool online-result online-modal-card" role="status">
            <div className="row spread">
              <strong>{resultTitle}</strong>
              <span className="muted small">{lastResult.reason === 'timeout' ? '时间到' : lastResult.reason === 'wrong' ? '选错' : '本回合结算'}</span>
            </div>
            {resultMeta ? (
              <div className="online-result-body">
                <div className={`online-discard-flight${resultWinner ? ` winner-${resultWinner}` : ''}`}>
                  <OnlineCardTile meta={resultMeta} available result readOnly showNumber={false} />
                  <span className="online-discard-pile">{resultWinner ? `${playerName(room, resultWinner)} 的弃牌堆` : '场上'}</span>
                </div>
                <div className="stack">
                  <span className="muted small">对应歌曲</span>
                  <strong>{lastResult.song.displayName}</strong>
                  <span className="muted small">观战者不能操作牌面。</span>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
      {matchOver ? (
        <div className="online-spectator-over" role="status">
          <strong>{matchOver.winner ? `${playerName(room, matchOver.winner)} 获胜` : '双方平手'}</strong>
          <span>对局已结束 · {matchOver.rounds} 回合</span>
        </div>
      ) : null}
    </div>
  )
})

export function OnlineVolumeControl({ volume, onChange }: { volume: number; onChange: (volume: number) => void }) {
  const percentage = Math.round(clampOnlineVolume(volume) * 100)
  return (
    <label className="online-volume-control">
      <span>对局音量 <strong>{percentage}%</strong></span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={percentage}
        aria-label="对局音量"
        onChange={(event) => onChange(Number(event.currentTarget.value) / 100)}
      />
    </label>
  )
}

interface VirtualServerCardGridProps {
  cards: ServerPackageCatalogCard[]
  packageId: string
  selected: Set<string>
  onToggle: (cardKey: string) => void
}

const VirtualServerCard = memo(function VirtualServerCard({
  meta,
  selected,
  onToggle,
}: {
  meta: OnlineCardView
  selected: boolean
  onToggle: (cardKey: string) => void
}) {
  const handleClick = useCallback(() => onToggle(meta.key), [meta.key, onToggle])
  return <OnlineCardTile meta={meta} card={null} available picked={selected} thumbnail onClick={handleClick} />
})

/**
 * Keeps the complete server catalog scrollable while mounting only the rows
 * around the viewport. This avoids a 400+ card React/DOM task without hiding
 * cards behind a manual "load more" action.
 */
export function VirtualServerCardGrid({ cards, packageId, selected, onToggle }: VirtualServerCardGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 520 })
  const [scrollTop, setScrollTop] = useState(0)
  const cardViews = useMemo(() => cards.map((card) => packageCardMeta(card, packageId)), [cards, packageId])

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

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    scrollTopRef.current = 0
    if (viewportRef.current) viewportRef.current.scrollTop = 0
    setScrollTop(0)
  }, [cards, packageId])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  const columns = viewport.width >= 720 ? 5 : viewport.width >= 480 ? 4 : viewport.width >= 320 ? 3 : 2
  const cardWidth = Math.max(92, (viewport.width - (columns - 1) * 8 - 6) / columns)
  const rowHeight = Math.ceil(cardWidth * 1.45 + 58)
  const rowCount = Math.ceil(cards.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewport.height) / rowHeight) + 2)
  const startIndex = firstRow * columns
  const renderedCards = cardViews.slice(startIndex, lastRow * columns)

  return (
    <div
      className="online-select-viewport"
      ref={viewportRef}
      onScroll={handleScroll}
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
          {renderedCards.map((meta) => (
            <VirtualServerCard key={meta.key} meta={meta} selected={selected.has(meta.key)} onToggle={onToggle} />
          ))}
        </div>
      </div>
    </div>
  )
}

const DraftCard = memo(function DraftCard({
  meta,
  selected,
  onToggle,
}: {
  meta: OnlineCardView
  selected: boolean
  onToggle: (cardKey: string) => void
}) {
  const handleClick = useCallback(() => onToggle(meta.key), [meta.key, onToggle])
  return <OnlineCardTile meta={meta} available picked={selected} thumbnail onClick={handleClick} />
})

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

export function DraftCardPicker({
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
          <DraftCard key={meta.key} meta={meta} selected={selected.has(meta.key)} onToggle={onToggle} />
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
  playerId?: OnlinePlayerId
  mine?: boolean
  spectator?: boolean
  canArrange?: boolean
  pinMode?: boolean
  pinnedKeys?: Set<string>
  draggingKey?: string | null
  dragOverSlot?: number | null
  claimable?: boolean
  giving?: boolean
  resultKey?: string | null
  wrongKey?: string | null
  pickedKey?: string | null
  onCardClick?: (key: string) => void
  onSlotClick?: (slotIndex: number) => void
  onDragStart?: (event: DragEvent<HTMLButtonElement>, cardKey: string) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>, slotIndex: number) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>, slotIndex: number) => void
  onDragEnd?: () => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>, cardKey: string) => void
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void
}

export const HandArea = memo(function HandArea({
  title,
  slotCards,
  playerId,
  mine = false,
  spectator = false,
  canArrange = false,
  pinMode = false,
  pinnedKeys = new Set<string>(),
  draggingKey = null,
  dragOverSlot = null,
  claimable = false,
  giving = false,
  resultKey = null,
  wrongKey = null,
  pickedKey = null,
  onCardClick,
  onSlotClick,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: HandAreaProps) {
  const draggable = mine && canArrange && !spectator
  const clickable = Boolean(!spectator && ((claimable && !canArrange) || giving || (mine && canArrange)))
  const showSlots = Boolean(mine && draggingKey)
  const suppressArrangeClickRef = useRef(false)
  const handleCardClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (suppressArrangeClickRef.current) {
        suppressArrangeClickRef.current = false
        return
      }
      const slotIndex = Number.parseInt(event.currentTarget.dataset.onlineSlotIndex || '', 10)
      if (mine && canArrange && draggingKey && onSlotClick && Number.isInteger(slotIndex)) {
        onSlotClick(slotIndex)
        return
      }
      const cardKey = event.currentTarget.dataset.onlineCardKey
      if (cardKey) onCardClick?.(cardKey)
    },
    [canArrange, draggingKey, mine, onCardClick, onSlotClick],
  )
  const handleSlotClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const slotIndex = Number.parseInt(event.currentTarget.dataset.onlineSlotIndex || '', 10)
      if (Number.isInteger(slotIndex)) onSlotClick?.(slotIndex)
    },
    [onSlotClick],
  )
  const handleCardDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const cardKey = event.currentTarget.dataset.onlineCardKey
      if (cardKey) onDragStart?.(event, cardKey)
    },
    [onDragStart],
  )
  const handleSlotDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const slotIndex = Number.parseInt(event.currentTarget.dataset.onlineSlotIndex || '', 10)
      if (Number.isInteger(slotIndex)) onDragOver?.(event, slotIndex)
    },
    [onDragOver],
  )
  const handleSlotDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      const slotIndex = Number.parseInt(event.currentTarget.dataset.onlineSlotIndex || '', 10)
      if (Number.isInteger(slotIndex)) onDrop?.(event, slotIndex)
    },
    [onDrop],
  )
  const handleCardPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressArrangeClickRef.current = false
      const cardKey = event.currentTarget.dataset.onlineCardKey
      if (cardKey) onPointerDown?.(event, cardKey)
    },
    [onPointerDown],
  )
  const handleCardPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (canArrange && event.pointerType !== 'touch') suppressArrangeClickRef.current = true
      onPointerUp?.(event)
    },
    [canArrange, onPointerUp],
  )
  const handleCardPointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (canArrange && event.pointerType !== 'touch') suppressArrangeClickRef.current = true
      onPointerCancel?.(event)
    },
    [canArrange, onPointerCancel],
  )
  return (
    <section className={`hand-area${mine ? ' mine' : ''}${playerId ? ` player-${playerId.toLowerCase()}` : ''}${giving ? ' giving' : ''}${spectator ? ' spectator' : ''}`}>
      <div className="row spread hand-area-heading">
        <strong>{title}</strong>
        <span className="muted small">{spectator ? '观战中 · 只读' : giving ? '点击自己的牌交给对手' : mine ? (canArrange ? (pinMode ? '点击固定牌位' : draggingKey ? '点击槽位放置选中的牌' : '点击牌再点击槽位，或拖动调整') : '你的牌区') : '点击卡面抢牌'}</span>
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
                  onDragOver={onDragOver ? handleSlotDragOver : undefined}
                  onDrop={onDrop ? handleSlotDrop : undefined}
                  onClick={onSlotClick ? handleSlotClick : undefined}
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
                wrong={wrongKey === meta.key}
                readOnly={spectator}
                pinned={pinnedKeys.has(meta.key)}
                stateLabel={giving ? '点击交牌' : canArrange ? (draggingKey === meta.key ? '已选中' : '点击换位') : undefined}
                draggable={draggable}
                dragging={draggingKey === meta.key}
                dropTarget={dragOverSlot === index && draggingKey !== meta.key}
                onDragStart={onDragStart ? handleCardDragStart : undefined}
                onDragOver={onDragOver ? handleSlotDragOver : undefined}
                onDrop={onDrop ? handleSlotDrop : undefined}
                onDragEnd={onDragEnd}
                onPointerDown={onPointerDown ? handleCardPointerDown : undefined}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp ? handleCardPointerUp : undefined}
                onPointerCancel={onPointerCancel ? handleCardPointerCancel : undefined}
                onClick={clickable && (onCardClick || onSlotClick) ? handleCardClick : undefined}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
})

export const TransferPanel = memo(function TransferPanel({ room }: { room: OnlineRoomView }) {
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
})

export function PlayerBadge({ player, mine }: { player: OnlineRoomView['players']['A']; mine: boolean }) {
  return (
    <div className="player-badge">
      <span className={`presence-dot${player?.connected ? ' connected' : ''}`} />
      <strong>{player?.nickname || '等待对手加入…'}</strong>
      {mine ? <span className="muted small">（你）</span> : null}
      {player?.ready ? <span className="ready-label">已准备</span> : null}
    </div>
  )
}

function useOnlineNetworkSnapshot(socket: OnlineSocket) {
  return useSyncExternalStore(socket.subscribeNetwork, socket.getNetworkSnapshot, socket.getNetworkSnapshot)
}

export const OnlineLobbyReadyButton = memo(function OnlineLobbyReadyButton({
  socket,
  room,
  opponent,
  ready,
}: {
  socket: OnlineSocket
  room: OnlineRoomView
  opponent: OnlineRoomView['players']['A']
  ready: boolean
}) {
  const network = useOnlineNetworkSnapshot(socket)
  return (
    <button
      className="btn btn-primary btn-lg"
      type="button"
      disabled={!opponent || !(network?.fairness.canStart ?? room.fairness.canStart)}
      onClick={() => socket.send({ t: 'ready', ready: !ready })}
    >
      {ready ? '取消准备' : '准备开始'}
    </button>
  )
})

export const NetworkFairness = memo(function NetworkFairness({ socket, you, compact = false }: { socket: OnlineSocket; you: OnlineRoomView['you']; compact?: boolean }) {
  const network = useOnlineNetworkSnapshot(socket)
  if (!network) return null
  const { fairness, players } = network
  if (compact) {
    if (!you) {
      return (
        <div className="network-fairness compact network-latency" role="status" aria-label="双方延迟">
          <strong>双方延迟</strong>
          <div className="network-metrics">
            <span>A {formatNetworkMetric(players.A.rttMs)}</span>
            <span>B {formatNetworkMetric(players.B.rttMs)}</span>
          </div>
        </div>
      )
    }
    const own = players[you]
    const opponent = players[otherPlayer(you)]
    return (
      <div className="network-fairness compact network-latency" role="status" aria-label="双方延迟">
        <strong>双方延迟</strong>
        <div className="network-metrics">
          <span>我方 {formatNetworkMetric(own.rttMs)}</span>
          <span>对手 {formatNetworkMetric(opponent.rttMs)}</span>
        </div>
      </div>
    )
  }
  const statusLabel = fairness.status === 'ready' ? '可开始' : fairness.status === 'unfair' ? '不适合公平对战' : '测量中'
  const metric = (player: OnlineNetworkView) => {
    return `RTT ${formatNetworkMetric(player.rttMs)} · 抖动 ${formatNetworkMetric(player.jitterMs)} · ${player.samples} 次`
  }

  return (
    <div className={`network-fairness ${fairness.status}`} role={fairness.status === 'unfair' ? 'alert' : 'status'}>
      <div className="row spread">
        <strong>网络公平性</strong>
        <span>{statusLabel}</span>
      </div>
      <p>{fairness.message}</p>
      <div className="network-metrics">
        <span>A · {metric(players.A)}</span>
        <span>B · {metric(players.B)}</span>
      </div>
    </div>
  )
})

export function ScoreCard({
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
