import type { DragEvent, PointerEvent } from 'react'
import { useObjectUrl } from '../hooks/useObjectUrl'
import type { CardEntry } from '../types/models'
import type { OnlineCardView } from '../lib/onlineProtocol'

interface Props {
  meta: OnlineCardView
  card?: CardEntry | null
  available: boolean
  picked?: boolean
  result?: boolean
  pinned?: boolean
  stateLabel?: string
  draggable?: boolean
  dragging?: boolean
  dropTarget?: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: () => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void
  onClick?: () => void
}

/** A board tile deliberately keeps the local karuta card image as its main cue. */
export function OnlineCardTile({
  meta,
  card,
  available,
  picked,
  result,
  pinned = false,
  stateLabel,
  draggable = false,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClick,
}: Props) {
  const localImageUrl = useObjectUrl(card?.imageBlobKey)
  const imageUrl = meta.imageUrl || localImageUrl
  const className = [
    'online-card-tile',
    available ? 'available' : draggable ? 'arrangeable' : 'claimed',
    picked ? 'picked' : '',
    result ? 'result' : '',
    pinned ? 'pinned' : '',
    draggable ? 'draggable' : '',
    dragging ? 'dragging' : '',
    dropTarget ? 'drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      className={className}
      type="button"
      draggable={draggable}
      disabled={!draggable && (!available || !onClick)}
      onClick={available || draggable ? onClick : undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-online-card-key={meta.key}
      aria-grabbed={dragging}
      aria-label={`#${meta.number} ${meta.workName}`}
    >
      <span className="online-card-number">#{meta.number}</span>
      <div className="online-card-image">
        {imageUrl ? (
          <img src={imageUrl} alt={meta.workName} loading="lazy" decoding="async" />
        ) : (
          <span className="online-card-missing">{card ? '暂无卡面' : '服务器卡面加载中'}</span>
        )}
      </div>
      <span className="online-card-title">{meta.workName}</span>
      {pinned ? <span className="online-card-state">已固定</span> : stateLabel ? <span className="online-card-state">{stateLabel}</span> : !available ? <span className="online-card-state">已收取</span> : null}
    </button>
  )
}
