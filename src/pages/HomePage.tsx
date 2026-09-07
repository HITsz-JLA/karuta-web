import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDeck, useDeckList, useSettings } from '../hooks/useDecks'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { createId, saveDeck } from '../lib/storage'
import { importDeckZip } from '../lib/zipPackage'
import type { FailureMode } from '../types/models'

export function HomePage() {
  const navigate = useNavigate()
  const { decks, loading, refresh } = useDeckList()
  const { settings, update } = useSettings()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const { deck } = useDeck(selectedId)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState(0)

  useEffect(() => {
    if (!selectedId && decks[0]) setSelectedId(decks[0].id)
  }, [decks, selectedId])

  useEffect(() => {
    setPreviewIndex(0)
  }, [selectedId])

  const previewCard = deck?.cards[previewIndex] || null
  const previewUrl = useObjectUrl(previewCard?.imageBlobKey)

  const songCount = useMemo(
    () => deck?.cards.reduce((sum, card) => sum + card.songs.length, 0) || 0,
    [deck],
  )

  async function handleImportZip(file: File) {
    setBusy(true)
    setMessage(null)
    try {
      const imported = await importDeckZip(file)
      await refresh()
      setSelectedId(imported.id)
      setMessage(`已导入：${imported.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  async function createEmptyDeck() {
    const name = window.prompt('新数据集名称', `deck-${decks.length + 1}`)
    if (!name) return
    const id = createId('deck')
    await saveDeck({
      id,
      name: name.trim(),
      updatedAt: Date.now(),
      cards: [],
    })
    await refresh()
    setSelectedId(id)
    navigate(`/editor/${id}`)
  }

  function startGame() {
    if (!deck) {
      setMessage('请先选择数据集')
      return
    }
    if (!deck.cards.length) {
      setMessage('数据集为空，请先录入卡牌')
      return
    }
    navigate(`/select/${deck.id}`)
  }

  return (
    <>
      <section className="hero">
        <h1>点歌对战</h1>
        <p>数据与音频都保存在本机浏览器，服务器只托管页面静态资源。</p>
      </section>

      <div className="grid-home">
        <section className="panel warm stack">
          <div className="row spread">
            <strong>可用数据集</strong>
            <button className="btn btn-secondary" type="button" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          <p className="muted small">左侧选择数据集，右侧预览卡面。可导入原版兼容的 ZIP / 本地新建。</p>

          <div className="row">
            <button className="btn btn-secondary" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
              导入 ZIP
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void createEmptyDeck()}>
              新建
            </button>
            {selectedId ? (
              <Link className="btn btn-secondary" to={`/editor/${selectedId}`}>
                编辑
              </Link>
            ) : null}
          </div>
          <input
            ref={fileRef}
            className="hidden-file"
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleImportZip(file)
              event.target.value = ''
            }}
          />

          <div className="deck-list">
            {loading ? <div className="empty-state">加载中…</div> : null}
            {!loading && !decks.length ? <div className="empty-state">还没有数据集</div> : null}
            {decks.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`deck-item${item.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.name}</strong>
                <span className="muted small">
                  卡牌 {item.cardCount} · 歌曲 {item.songCount}
                </span>
              </button>
            ))}
          </div>

          <div className="panel stack" style={{ boxShadow: 'none' }}>
            <strong>对战设置</strong>
            <div className="field">
              <label htmlFor="cardLimit">卡牌数上限</label>
              <input
                id="cardLimit"
                type="number"
                min={1}
                max={500}
                value={settings.cardLimit}
                onChange={(event) => void update({ cardLimit: Number(event.target.value) || 1 })}
              />
            </div>
            <div className="field">
              <label htmlFor="failureMode">失败处理</label>
              <select
                id="failureMode"
                value={settings.failureMode}
                onChange={(event) => void update({ failureMode: event.target.value as FailureMode })}
              >
                <option value="PASS">PASS（失败后保留）</option>
                <option value="SKIP">SKIP（失败后移出）</option>
              </select>
            </div>
            <label className="row">
              <input
                type="checkbox"
                checked={settings.enableRestMusic}
                onChange={(event) => void update({ enableRestMusic: event.target.checked })}
              />
              休息时间播放歌曲
            </label>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="minDuration">最短片段（秒）</label>
                <input
                  id="minDuration"
                  type="number"
                  min={1}
                  value={settings.minDuration}
                  onChange={(event) => void update({ minDuration: Number(event.target.value) || 1 })}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="maxDuration">最长片段（秒）</label>
                <input
                  id="maxDuration"
                  type="number"
                  min={1}
                  value={settings.maxDuration}
                  onChange={(event) => void update({ maxDuration: Number(event.target.value) || 1 })}
                />
              </div>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="button" onClick={startGame}>
              开始
            </button>
          </div>
        </section>

        <section className="panel cool stack">
          <div>
            <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--display)' }}>
              {deck?.name || '未选择数据集'}
            </h2>
            <p className="muted small">
              卡牌 {deck?.cards.length || 0} · 歌曲 {songCount}
            </p>
          </div>

          <div className="preview-art">
            {previewUrl ? (
              <img src={previewUrl} alt={previewCard?.workName || ''} />
            ) : (
              <span className="muted">卡面预览区域</span>
            )}
          </div>

          <div className="stack" style={{ textAlign: 'center' }}>
            <strong>{previewCard ? `#${previewCard.number} ${previewCard.workName}` : '请选择数据集'}</strong>
            <span className="muted small">
              {previewCard
                ? previewCard.songs.map((song) => song.displayName).join(' / ') || '无歌曲'
                : '歌曲信息将显示在这里。'}
            </span>
          </div>

          <div className="works-list">
            {(deck?.cards || []).map((card, index) => (
              <button
                key={card.id}
                type="button"
                className={`work-item${index === previewIndex ? ' active' : ''}`}
                onClick={() => setPreviewIndex(index)}
              >
                <span className="num">#{card.number}</span>
                <span>
                  <strong>{card.workName}</strong>
                  <div className="muted small">{card.songs.length} 首</div>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {message ? <div className="toast">{message}</div> : null}
    </>
  )
}
