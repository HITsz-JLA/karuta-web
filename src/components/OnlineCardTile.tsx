import { useObjectUrl } from '../hooks/useObjectUrl'
import type { CardEntry } from '../types/models'
import type { OnlineCardView } from '../lib/onlineProtocol'

interface Props {
  meta: OnlineCardView
  card: CardEntry | null
  available: boolean
  picked?: boolean
  result?: boolean
  onClick?: () => void
}

/** A board tile deliberately keeps the HITsz-JLA card image as its main cue. */
export function OnlineCardTile({ meta, card, available, picked, result, onClick }: Props) {
  const imageUrl = useObjectUrl(card?.imageBlobKey)
  const className = [
    'online-card-tile',
    available ? 'available' : 'claimed',
    picked ? 'picked' : '',
    result ? 'result' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={className} type="button" disabled={!available || !onClick} onClick={onClick}>
      <span className="online-card-number">#{meta.number}</span>
      <div className="online-card-image">
        {imageUrl ? (
          <img src={imageUrl} alt={meta.workName} />
        ) : (
          <span className="online-card-missing">{card ? '暂无卡面' : '请加载同一数据包'}</span>
        )}
      </div>
      <span className="online-card-title">{meta.workName}</span>
      {!available ? <span className="online-card-state">已收取</span> : null}
    </button>
  )
}
