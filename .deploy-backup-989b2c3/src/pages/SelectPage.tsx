import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CardTile } from '../components/CardTile'
import { useDeck, useSettings } from '../hooks/useDecks'
import type { CardEntry, SelectionResult } from '../types/models'

function parseNumberInput(raw: string): number[] {
  return raw
    .split(/[\s,，、;；]+/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
}

function pickRandomCards(cards: CardEntry[], count: number): CardEntry[] {
  const sampleSize = Math.min(Math.max(0, count), cards.length)
  if (sampleSize === 0) return []

  // Reservoir sampling keeps random selection linear without sorting a large deck.
  const sample = cards.slice(0, sampleSize)
  for (let index = sampleSize; index < cards.length; index += 1) {
    const slot = Math.floor(Math.random() * (index + 1))
    if (slot < sampleSize) sample[slot] = cards[index]
  }
  return sample
}

interface LocalCardGridProps {
  cards: CardEntry[]
  selectedIds: Set<string>
  onToggle: (cardId: string) => void
}

/** Keeps the complete local deck scrollable while mounting only nearby rows. */
function LocalCardGrid({ cards, selectedIds, onToggle }: LocalCardGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
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
    if (viewportRef.current && viewportRef.current.scrollTop !== 0) {
      viewportRef.current.scrollTop = 0
    }
    setScrollTop((previous) => (previous === 0 ? previous : 0))
  }, [cards])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    scrollTopRef.current = event.currentTarget.scrollTop
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  const columns = Math.max(1, Math.floor((viewport.width + 12) / (viewport.width >= 700 ? 172 : 144)))
  const cardWidth = Math.max(120, (viewport.width - (columns - 1) * 12 - 6) / columns)
  const rowHeight = Math.ceil(cardWidth * 1.45 + 58)
  const rowCount = Math.ceil(cards.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewport.height) / rowHeight) + 2)
  const startIndex = firstRow * columns
  const renderedCards = cards.slice(startIndex, lastRow * columns)

  return (
    <div className="local-select-viewport" ref={viewportRef} onScroll={handleScroll} aria-label={`本地牌组，共 ${cards.length} 张卡面`}>
      <div className="local-select-canvas" style={{ height: `${rowCount * rowHeight}px` }}>
        <div
          className="local-select-window"
          style={{
            top: `${firstRow * rowHeight}px`,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoRows: `${rowHeight}px`,
          }}
        >
          {renderedCards.map((card) => (
            <CardTile key={card.id} card={card} selected={selectedIds.has(card.id)} onToggle={onToggle} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function SelectPage() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const { deck, loading } = useDeck(deckId)
  const { settings } = useSettings()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [numberInput, setNumberInput] = useState('')
  const [emptyMode, setEmptyMode] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const deferredKeyword = useDeferredValue(keyword)

  const cardLimit = Math.max(1, Math.min(settings.cardLimit, deck?.cards.length || settings.cardLimit))

  useEffect(() => {
    if (!deck || initialized) return
    const preset = deck.cards.slice(0, cardLimit).map((card) => card.id)
    setSelectedIds(new Set(preset))
    setInitialized(true)
  }, [deck, cardLimit, initialized])

  const searchableCards = useMemo(() => {
    if (!deck) return []
    return deck.cards.map((card) => ({
      card,
      workName: card.workName.toLowerCase(),
      number: String(card.number),
      hashNumber: `#${card.number}`,
    }))
  }, [deck])

  const cardsByNumber = useMemo(() => {
    const result = new Map<number, CardEntry[]>()
    for (const card of deck?.cards || []) {
      const matches = result.get(card.number)
      if (matches) matches.push(card)
      else result.set(card.number, [card])
    }
    return result
  }, [deck])

  const visibleCards = useMemo(() => {
    if (!deck) return []
    const q = deferredKeyword.trim().toLowerCase()
    if (!q) return deck.cards
    return searchableCards
      .filter(({ workName, number, hashNumber }) => workName.includes(q) || number.includes(q) || hashNumber.includes(q))
      .map(({ card }) => card)
  }, [deck, deferredKeyword, searchableCards])

  const toggleCard = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) {
        next.delete(cardId)
      } else {
        if (next.size >= cardLimit) {
          setMessage(`最多只能选择 ${cardLimit} 张卡牌。`)
          return prev
        }
        next.add(cardId)
      }
      return next
    })
  }, [cardLimit])

  function applyNumberEntry(mode: 'add' | 'replace') {
    if (!deck) return
    const numbers = parseNumberInput(numberInput)
    if (!numbers.length) {
      setMessage('请输入牌号，例如：1 5 12 或 1,5,12')
      return
    }

    const found: CardEntry[] = []
    const missing: number[] = []

    for (const num of numbers) {
      const matches = cardsByNumber.get(num) || []
      if (matches.length) found.push(...matches)
      else missing.push(num)
    }

    setSelectedIds((prev) => {
      const next = mode === 'replace' ? new Set<string>() : new Set(prev)
      for (const card of found) {
        if (next.size >= cardLimit && !next.has(card.id)) continue
        next.add(card.id)
      }
      return next
    })

    if (missing.length) {
      setMessage(`已录入 ${found.length} 张；未找到编号：${missing.join(', ')}`)
    } else {
      setMessage(`已按编号录入 ${found.length} 张`)
    }
    setNumberInput('')
  }

  function confirm() {
    if (!deck) return
    const selected = deck.cards.filter((card) => selectedIds.has(card.id))
    if (!selected.length) {
      setMessage('请至少选择 1 张卡牌')
      return
    }

    const unselected = deck.cards.filter((card) => !selectedIds.has(card.id))
    if (emptyMode && unselected.length < selected.length) {
      setMessage(`空牌模式需要 ${selected.length} 张未选中卡牌，目前只剩 ${unselected.length} 张`)
      return
    }

    const emptySources = emptyMode ? pickRandomCards(unselected, selected.length) : []
    const emptySourceIds = new Set(emptySources.map((card) => card.id))
    // 休息曲池排除参赛牌与空牌来源牌（与桌面版一致）
    const restPool = unselected
      .filter((card) => !emptySourceIds.has(card.id))
      .flatMap((card) => card.songs)
    const payload: SelectionResult = { selected, restPool, emptySources }
    sessionStorage.setItem(`karuta-selection:${deck.id}`, JSON.stringify(payload))
    navigate(`/game/${deck.id}`)
  }

  if (loading) return <div className="empty-state">加载中…</div>
  if (!deck) {
    return (
      <div className="stack">
        <div className="empty-state">数据集不存在</div>
        <Link className="btn btn-secondary" to="/">
          返回
        </Link>
      </div>
    )
  }

  return (
    <>
      <section className="hero">
        <h1>选择本局参赛卡牌</h1>
        <p>
          已选 {selectedIds.size} / {cardLimit} 张。可搜索标题，或直接输入牌号快速录入。
        </p>
      </section>

      <section className="panel stack">
        <div className="number-entry">
          <div className="field">
            <label htmlFor="numberEntry">按编号录入</label>
            <input
              id="numberEntry"
              inputMode="numeric"
              placeholder="例如 1 5 12 或 3- 直接输入编号"
              value={numberInput}
              onChange={(event) => setNumberInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyNumberEntry('add')
                }
              }}
            />
            <span className="kbd-hint">支持空格 / 逗号分隔多个编号，回车追加选中</span>
          </div>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={() => applyNumberEntry('add')}>
              追加编号
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => applyNumberEntry('replace')}>
              覆盖为这些编号
            </button>
          </div>
        </div>

        <div className="row">
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label htmlFor="search">标题 / 编号搜索</label>
            <input
              id="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="输入作品名或编号"
            />
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setSelectedIds(new Set(visibleCards.slice(0, cardLimit).map((card) => card.id)))
            }}
          >
            选当前结果前 {cardLimit} 张
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              const pool = pickRandomCards(visibleCards, cardLimit)
              setSelectedIds(new Set(pool.map((c) => c.id)))
            }}
          >
            随机选择
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setSelectedIds(new Set())}>
            清空
          </button>
        </div>

        <label className="row">
          <input type="checkbox" checked={emptyMode} onChange={(event) => setEmptyMode(event.target.checked)} />
          空牌开始模式（从未选中牌中抽取等量空牌）
        </label>
      </section>

      <section style={{ marginTop: 16 }}>
        <LocalCardGrid cards={visibleCards} selectedIds={selectedIds} onToggle={toggleCard} />
      </section>

      {!visibleCards.length ? <div className="empty-state">没有匹配的卡面</div> : null}

      <div className="sticky-actions">
        <Link className="btn btn-secondary" to="/">
          取消
        </Link>
        <button className="btn btn-primary btn-lg" type="button" onClick={confirm}>
          开始游戏
        </button>
      </div>

      {message ? <div className="toast">{message}</div> : null}
    </>
  )
}
