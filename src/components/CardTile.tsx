import { useObjectUrl } from '../hooks/useObjectUrl'
import type { CardEntry } from '../types/models'

interface CardTileProps {
  card: CardEntry
  selected?: boolean
  onClick?: () => void
  showSongCount?: boolean
}

export function CardTile({ card, selected, onClick, showSongCount = true }: CardTileProps) {
  const url = useObjectUrl(card.imageBlobKey)

  return (
    <button
      type="button"
      className={`card-tile${selected ? ' selected' : ''}`}
      onClick={onClick}
    >
      <span className="num-badge">#{card.number}</span>
      {selected ? <span className="check-badge">✓</span> : null}
      <div className="thumb">
        {url ? <img src={url} alt={card.workName} /> : <div className="empty-state small">无图片</div>}
      </div>
      <div className="title">{card.workName}</div>
      {showSongCount ? <div className="muted small">{card.songs.length} 首</div> : null}
    </button>
  )
}
