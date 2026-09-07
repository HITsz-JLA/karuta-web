import { useEffect, useMemo, useState } from 'react'
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

  const cardLimit = Math.max(1, Math.min(settings.cardLimit, deck?.cards.length || settings.cardLimit))

  useEffect(() => {
    if (!deck || initialized) return
    const preset = deck.cards.slice(0, cardLimit).map((card) => card.id)
    setSelectedIds(new Set(preset))
    setInitialized(true)
  }, [deck, cardLimit, initialized])

  const visibleCards = useMemo(() => {
    if (!deck) return []
    const q = keyword.trim().toLowerCase()
    return deck.cards.filter((card) => {
      if (!q) return true
      return (
        card.workName.toLowerCase().includes(q) ||
        String(card.number).includes(q) ||
        `#${card.number}`.includes(q)
      )
    })
  }, [deck, keyword])

  function toggleCard(card: CardEntry) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(card.id)) {
        next.delete(card.id)
      } else {
        if (next.size >= cardLimit) {
          setMessage(`最多只能选择 ${cardLimit} 张卡牌。`)
          return prev
        }
        next.add(card.id)
      }
      return next
    })
  }

  function applyNumberEntry(mode: 'add' | 'replace') {
    if (!deck) return
    const numbers = parseNumberInput(numberInput)
    if (!numbers.length) {
      setMessage('请输入牌号，例如：1 5 12 或 1,5,12')
      return
    }

    const byNumber = new Map(deck.cards.map((card) => [card.number, card]))
    const found: CardEntry[] = []
    const missing: number[] = []

    for (const num of numbers) {
      const card = byNumber.get(num)
      if (card) found.push(card)
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

    const emptySources = emptyMode
      ? [...unselected].sort(() => Math.random() - 0.5).slice(0, selected.length)
      : []

    const restPool = unselected.flatMap((card) => card.songs)
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
              const pool = [...visibleCards].sort(() => Math.random() - 0.5)
              setSelectedIds(new Set(pool.slice(0, Math.min(cardLimit, pool.length)).map((c) => c.id)))
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

      <section className="card-grid" style={{ marginTop: 16 }}>
        {visibleCards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            selected={selectedIds.has(card.id)}
            onClick={() => toggleCard(card)}
          />
        ))}
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
