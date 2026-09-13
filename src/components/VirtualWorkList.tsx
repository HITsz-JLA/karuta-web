import { memo, useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import type { CardEntry } from '../types/models'

const WORK_ROW_HEIGHT = 64
const WORK_OVERSCAN = 3

interface VirtualWorkListProps {
  cards: CardEntry[]
  selectedId?: string | null
  onSelect: (card: CardEntry, index: number) => void
  resetKey?: string
  ariaLabel?: string
}

const WorkRow = memo(function WorkRow({
  card,
  index,
  selected,
  onSelect,
}: {
  card: CardEntry
  index: number
  selected: boolean
  onSelect: (card: CardEntry, index: number) => void
}) {
  const handleClick = useCallback(() => onSelect(card, index), [card, index, onSelect])
  return (
    <button
      type="button"
      className={`work-item${selected ? ' active' : ''}`}
      onClick={handleClick}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="num">#{card.number}</span>
      <span>
        <strong>{card.workName || '未命名'}</strong>
        <div className="muted small">{card.songs.length} 首</div>
      </span>
    </button>
  )
})

/** Keeps long offline deck lists responsive by mounting only nearby rows. */
export function VirtualWorkList({
  cards,
  selectedId = null,
  onSelect,
  resetKey = '',
  ariaLabel = `作品列表，共 ${cards.length} 张卡牌`,
}: VirtualWorkListProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(640)

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewportHeight(element.clientHeight || 640)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = null
    scrollTopRef.current = 0
    if (viewportRef.current && viewportRef.current.scrollTop !== 0) viewportRef.current.scrollTop = 0
    setScrollTop((previous) => (previous === 0 ? previous : 0))
  }, [resetKey])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  const firstIndex = Math.max(0, Math.floor(scrollTop / WORK_ROW_HEIGHT) - WORK_OVERSCAN)
  const lastIndex = Math.min(
    cards.length,
    Math.ceil((scrollTop + viewportHeight) / WORK_ROW_HEIGHT) + WORK_OVERSCAN,
  )

  return (
    <div className="works-list works-list-virtualized" ref={viewportRef} onScroll={handleScroll} aria-label={ariaLabel}>
      <div className="works-list-canvas" style={{ height: `${cards.length * WORK_ROW_HEIGHT}px` }}>
        <div className="works-list-window" style={{ top: `${firstIndex * WORK_ROW_HEIGHT}px` }}>
          {cards.slice(firstIndex, lastIndex).map((card, offset) => {
            const index = firstIndex + offset
            return (
              <WorkRow
                key={card.id}
                card={card}
                index={index}
                selected={card.id === selectedId}
                onSelect={onSelect}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
