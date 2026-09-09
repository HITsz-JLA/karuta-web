import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDeck, useDeckList, useSettings } from '../hooks/useDecks'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { createId, saveDeck } from '../lib/storage'
import { importDeckZip, type ImportProgress } from '../lib/zipPackage'
import { downloadServerPackage, listServerPackages, type ServerPackage } from '../lib/serverPackages'
import type { FailureMode } from '../types/models'

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function readableImportError(error: unknown) {
  if (error instanceof Error && /connection is closing|transactioninactiveerror|invalidstateerror/i.test(error.message)) {
    return '浏览器本地数据连接已关闭，请关闭本页面的其他标签后按 Ctrl+F5 重试；若仍失败，请清理本站点的 IndexedDB 后重新导入'
  }
  return error instanceof Error ? error.message : '导入失败'
}

export function HomePage() {
  const navigate = useNavigate()
  const { decks, loading, refresh } = useDeckList()
  const { settings, update } = useSettings()
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const { deck } = useDeck(selectedId)
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [serverPackages, setServerPackages] = useState<ServerPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)

  useEffect(() => {
    if (!selectedId && decks[0]) setSelectedId(decks[0].id)
  }, [decks, selectedId])

  useEffect(() => {
    setPreviewIndex(0)
  }, [selectedId])

  useEffect(() => {
    void refreshServerPackages()
  }, [])

  const previewCard = deck?.cards[previewIndex] || null
  const previewUrl = useObjectUrl(previewCard?.imageBlobKey)

  const songCount = useMemo(
    () => deck?.cards.reduce((sum, card) => sum + card.songs.length, 0) || 0,
    [deck],
  )

  const importProgressLabel =
    importProgress?.stage === 'reading'
      ? importProgress.total
        ? `正在分块读取 ZIP ${Math.min(Math.ceil(importProgress.current / 1024 / 1024), Math.ceil(importProgress.total / 1024 / 1024))}/${Math.ceil(importProgress.total / 1024 / 1024)} MB`
        : '正在读取 ZIP…'
      : importProgress?.stage === 'parsing'
        ? '正在解析 CSV…'
        : importProgress?.stage === 'resources'
          ? importProgress.total
            ? `正在导入资源 ${Math.min(Math.ceil(importProgress.current), importProgress.total)}/${importProgress.total}`
            : '正在整理数据…'
          : null

  const importProgressValue = importProgress
    ? importProgress.total > 0
      ? Math.min(importProgress.current, importProgress.total)
      : 0
    : 0

  async function loadServerPackage(serverPackage: ServerPackage) {
    setBusy(true)
    setImportProgress(null)
    setMessage(null)
    try {
      setImportProgress({ stage: 'reading', current: 0, total: serverPackage.size, fileName: serverPackage.fileName })
      const blob = await downloadServerPackage(serverPackage.id, serverPackage.size, ({ loaded, total }) => {
        setImportProgress({ stage: 'reading', current: loaded, total, fileName: serverPackage.fileName })
      })
      const file = new File([blob], serverPackage.fileName, { type: 'application/zip' })
      const imported = await importDeckZip(
        file,
        serverPackage.name,
        (progress) => setImportProgress(progress),
        serverPackage.mode,
      )
      const synced = { ...imported, sourcePackageId: serverPackage.id }
      await saveDeck(synced)
      await refresh()
      setSelectedId(synced.id)
      setMessage(`已导入：${synced.name}`)
    } catch (error) {
      setMessage(readableImportError(error))
    } finally {
      setBusy(false)
      setImportProgress(null)
    }
  }

  async function refreshServerPackages() {
    setPackagesLoading(true)
    try {
      setServerPackages(await listServerPackages())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取服务器数据包')
    } finally {
      setPackagesLoading(false)
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
        <h1>歌牌对战</h1>
        <p>复用服务器本地歌牌数据包；可在本机进行歌牌练习，也可创建在线 1v1 房间。</p>
      </section>

      <div className="grid-home">
        <section className="panel warm stack">
          <div className="row spread">
            <strong>可用数据集</strong>
            <button className="btn btn-secondary" type="button" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          <p className="muted small">从服务器选择数据包并加载到当前浏览器后开始对战。</p>

          <div className="row">
            <button className="btn btn-secondary" type="button" onClick={() => void refreshServerPackages()} disabled={packagesLoading || busy}>
              刷新服务器包
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void createEmptyDeck()}>
              新建本地数据集
            </button>
            {selectedId ? (
              <Link className="btn btn-secondary" to={`/editor/${selectedId}`}>
                编辑本地副本
              </Link>
            ) : null}
            <Link className="btn btn-primary" to="/online">
              在线 1v1 歌牌对战
            </Link>
          </div>

          <section className="panel stack" style={{ boxShadow: 'none' }}>
            <div className="row spread">
              <strong>服务器数据包</strong>
              <span className="muted small">普通用户只读</span>
            </div>
            {packagesLoading ? <div className="empty-state">正在读取服务器数据包…</div> : null}
            {!packagesLoading && !serverPackages.length ? (
              <div className="empty-state">服务器暂时没有数据包</div>
            ) : null}
            {!packagesLoading
              ? serverPackages.map((serverPackage) => (
                  <div className="row spread" key={serverPackage.id}>
                    <div>
                      <strong>{serverPackage.name}</strong>
                      <div className="muted small">
                        {formatBytes(serverPackage.size)} · {serverPackage.mode === 'full' ? '完整包' : '精简包'} ·{' '}
                        {new Date(serverPackage.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void loadServerPackage(serverPackage)}
                    >
                      加载
                    </button>
                  </div>
                ))
              : null}
          </section>

          {busy && importProgressLabel ? (
            <div className="stack" role="status" aria-live="polite" style={{ marginTop: 12 }}>
              <span className="muted small">
                {importProgressLabel}
                {importProgress?.fileName ? `：${importProgress.fileName}` : ''}
              </span>
              <progress
                value={importProgressValue}
                max={importProgress?.total || 1}
                style={{ width: '100%' }}
              />
            </div>
          ) : null}

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
              开始本地歌牌对战
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
