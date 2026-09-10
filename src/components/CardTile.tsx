import { memo } from 'react'
import { useObjectUrl } from '../hooks/useObjectUrl'
import type { CardEntry } from '../types/models'

interface CardTileProps {
  card: CardEntry
  selected?: boolean
  onClick?: () => void
  onToggle?: (cardId: string) => void
  showSongCount?: boolean
}

function areCardTilePropsEqual(previous: CardTileProps, next: CardTileProps) {
  return (
    previous.card.id === next.card.id &&
    previous.card.number === next.card.number &&
    previous.card.imageBlobKey === next.card.imageBlobKey &&
    previous.card.workName === next.card.workName &&
    previous.card.songs.length === next.card.songs.length &&
    previous.selected === next.selected &&
    previous.onClick === next.onClick &&
    previous.onToggle === next.onToggle &&
    previous.showSongCount === next.showSongCount
  )
}

export const CardTile = memo(function CardTile({ card, selected, onClick, onToggle, showSongCount = true }: CardTileProps) {
  // Selection only needs a small preview. Generating this thumbnail off the
  // render path avoids decoding every imported full-resolution cover at once.
  const url = useObjectUrl(card.imageBlobKey, { thumbnail: true })
  const handleClick = onToggle ? () => onToggle(card.id) : onClick

  return (
    <button
      type="button"
      className={`card-tile${selected ? ' selected' : ''}`}
      onClick={handleClick}
    >
      <span className="num-badge">#{card.number}</span>
      {selected ? <span className="check-badge">✓</span> : null}
      <div className="thumb">
        {url ? <img src={url} alt={card.workName} loading="lazy" decoding="async" /> : <div className="empty-state small">无图片</div>}
      </div>
      <div className="title">{card.workName}</div>
      {showSongCount ? <div className="muted small">{card.songs.length} 首</div> : null}
    </button>
  )
}, areCardTilePropsEqual)
