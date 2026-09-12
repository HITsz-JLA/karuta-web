import type { ReactNode } from 'react'
import { OnlineCardTile } from '../../components/OnlineCardTile'
import type { OnlineCardView, OnlineRoomView } from '../../lib/onlineProtocol'
import type { OnlineSocket } from '../../lib/onlineSocket'
import { BAN_SIZE, DRAFT_SELECTION_SIZE } from './onlineConstants'
import {
  DraftCardPicker,
  NetworkFairness,
  OnlineLobbyReadyButton,
  PlayerBadge,
} from './onlineViews'

function OnlineRoomPhaseHeader({
  title,
  subtitle,
  hint,
  leaveLabel,
  canReconnect,
  onReconnect,
  onLeave,
}: {
  title: string
  subtitle: ReactNode
  hint?: ReactNode
  leaveLabel: string
  canReconnect: boolean
  onReconnect: () => void
  onLeave: () => void
}) {
  return (
    <section className="hero">
      <div className="row spread">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="row online-room-actions">
          {canReconnect ? <button className="btn btn-secondary online-reconnect-button" type="button" onClick={onReconnect}>立即重连</button> : null}
          <button className="btn btn-secondary" type="button" onClick={onLeave}>{leaveLabel}</button>
        </div>
      </div>
      {hint}
    </section>
  )
}

export function OnlineRoomLobby({
  room,
  opponent,
  orderedRoomCards,
  canReconnect,
  onReconnect,
  onLeave,
  socket,
  message,
}: {
  room: OnlineRoomView
  opponent: OnlineRoomView['players']['A']
  orderedRoomCards: OnlineCardView[]
  canReconnect: boolean
  onReconnect: () => void
  onLeave: () => void
  socket: OnlineSocket
  message: string | null
}) {
  const ready = Boolean(room.you && room.players[room.you]?.ready)
  return (
    <div className="online-page">
      <OnlineRoomPhaseHeader
        title={room.name}
        subtitle={<>房间码 <span className="room-code large">{room.code}</span> · {room.deckName}</>}
        hint={<p className="muted small">把房间码分享给对手。双方直接使用服务器牌组看到同一套真实卡面，歌名不会在开局前下发。</p>}
        leaveLabel="退出房间"
        canReconnect={canReconnect}
        onReconnect={onReconnect}
        onLeave={onLeave}
      />
      <section className="panel stack">
        <div className="versus-players">
          <PlayerBadge player={room.players.A} mine={room.you === 'A'} />
          <span className="versus-mark">VS</span>
          <PlayerBadge player={room.players.B} mine={room.you === 'B'} />
        </div>
        <NetworkFairness socket={socket} you={room.you} />
        <div className="online-board compact">
          {orderedRoomCards.map((meta) => (
            <OnlineCardTile key={meta.key} meta={meta} available={false} thumbnail />
          ))}
        </div>
        <div className="row spread">
          <span className="muted small">候选牌 {room.cards.length} 张 · 准备后进入选牌、互换和 BAN</span>
          <OnlineLobbyReadyButton socket={socket} room={room} opponent={opponent} ready={ready} />
        </div>
      </section>
      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}

export function OnlineDraftSelect({
  room,
  cards,
  selected,
  canReconnect,
  onReconnect,
  onLeave,
  onToggle,
  onSubmit,
  message,
}: {
  room: OnlineRoomView
  cards: OnlineCardView[]
  selected: Set<string>
  canReconnect: boolean
  onReconnect: () => void
  onLeave: () => void
  onToggle: (cardKey: string) => void
  onSubmit: () => void
  message: string | null
}) {
  return (
    <div className="online-page">
      <OnlineRoomPhaseHeader
        title="第一阶段 · 各自选牌"
        subtitle={<>{room.name} · 房间码 <span className="room-code">{room.code}</span></>}
        hint={<p>服务器已经把候选牌随机分成两份。请只从你看到的这一份牌池中选择 30 张。</p>}
        leaveLabel="退出本局"
        canReconnect={canReconnect}
        onReconnect={onReconnect}
        onLeave={onLeave}
      />
      <DraftCardPicker
        title="从你的随机牌池选择 30 张"
        description="选定后会锁定，等对手也完成选择；对手不会看到你的选择进度以外的内容。"
        cards={cards}
        selected={selected}
        limit={DRAFT_SELECTION_SIZE}
        opponentCount={room.draft.opponentSelectedCount}
        opponentLabel="对手已选"
        submitLabel="确认 30 张并进入互换"
        onToggle={onToggle}
        onSubmit={onSubmit}
      />
      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}

export function OnlineDraftBan({
  room,
  cards,
  selected,
  canReconnect,
  onReconnect,
  onLeave,
  onToggle,
  onSubmit,
  message,
}: {
  room: OnlineRoomView
  cards: OnlineCardView[]
  selected: Set<string>
  canReconnect: boolean
  onReconnect: () => void
  onLeave: () => void
  onToggle: (cardKey: string) => void
  onSubmit: () => void
  message: string | null
}) {
  return (
    <div className="online-page">
      <OnlineRoomPhaseHeader
        title="第二阶段 · 互换后 BAN 牌"
        subtitle={<>{room.name} · 你正在处理对手选出的 30 张牌</>}
        hint={<p>这些是对手选出的牌。请从中 BAN 5 张，剩余 25 张会成为你的起始牌区。</p>}
        leaveLabel="退出本局"
        canReconnect={canReconnect}
        onReconnect={onReconnect}
        onLeave={onLeave}
      />
      <DraftCardPicker
        title="从互换牌中 BAN 5 张"
        description="BAN 只作用于你收到的这 30 张牌；双方完成后会同时进入三分钟排牌准备。"
        cards={cards}
        selected={selected}
        limit={BAN_SIZE}
        opponentCount={room.draft.opponentBannedCount}
        opponentLabel="对手已 BAN"
        submitLabel="确认 BAN 5 张并进入排牌"
        onToggle={onToggle}
        onSubmit={onSubmit}
      />
      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}
