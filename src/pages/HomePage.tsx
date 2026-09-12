import { memo, useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDeck, useDeckList, useSettings } from '../hooks/useDecks'
import { HomeNowPlaying } from '../components/HomeNowPlaying'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { createId, saveDeck } from '../lib/storage'
import type { ImportProgress } from '../lib/zipPackage'
import {
  CURATED_SERVER_PACKAGES,
  downloadServerPackage,
  isCuratedMucaPackage,
  listServerPackages,
  type ServerPackage,
} from '../lib/serverPackages'
import type { CardEntry, FailureMode } from '../types/models'

const HOME_WORK_ROW_HEIGHT = 64
const HOME_WORK_VIEWPORT_HEIGHT = 640

interface HomeWorkListProps {
  cards: CardEntry[]
  selectedIndex: number
  onSelect: (index: number) => void
}

const HomeWorkItem = memo(function HomeWorkItem({
  card,
  index,
  selected,
  onSelect,
}: {
  card: CardEntry
  index: number
  selected: boolean
  onSelect: (index: number) => void
}) {
  const handleClick = useCallback(() => onSelect(index), [index, onSelect])
  return (
    <button type="button" className={`work-item${selected ? ' active' : ''}`} onClick={handleClick}>
      <span className="num">#{card.number}</span>
      <span>
        <strong>{card.workName}</strong>
        <div className="muted small">{card.songs.length} 首</div>
      </span>
    </button>
  )
})

/** Keeps large local decks scrollable without mounting every work row at once. */
function HomeWorkList({ cards, selectedIndex, onSelect }: HomeWorkListProps) {
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const [scrollTop, setScrollTop] = useState(0)

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

  const firstIndex = Math.max(0, Math.floor(scrollTop / HOME_WORK_ROW_HEIGHT) - 3)
  const lastIndex = Math.min(
    cards.length,
    Math.ceil((scrollTop + HOME_WORK_VIEWPORT_HEIGHT) / HOME_WORK_ROW_HEIGHT) + 3,
  )

  return (
    <div className="works-list works-list-virtualized" onScroll={handleScroll} aria-label={`作品列表，共 ${cards.length} 张卡牌`}>
      <div className="works-list-canvas" style={{ height: `${cards.length * HOME_WORK_ROW_HEIGHT}px` }}>
        <div className="works-list-window" style={{ top: `${firstIndex * HOME_WORK_ROW_HEIGHT}px` }}>
          {cards.slice(firstIndex, lastIndex).map((card, offset) => {
            const index = firstIndex + offset
            return <HomeWorkItem key={card.id} card={card} index={index} selected={index === selectedIndex} onSelect={onSelect} />
          })}
        </div>
      </div>
    </div>
  )
}

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
  const { deck, loading: deckLoading } = useDeck(selectedId)
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [serverPackages, setServerPackages] = useState<ServerPackage[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const selectPreview = useCallback((index: number) => setPreviewIndex(index), [])
  const updateVolume = useCallback((volume: number) => void update({ volume }), [update])

  useEffect(() => {
    const preferredDeck = decks.find((item) => isCuratedMucaPackage(item.sourcePackageId)) || decks[0]
    if (!selectedId && preferredDeck) setSelectedId(preferredDeck.id)
  }, [decks, selectedId])

  useEffect(() => {
    setPreviewIndex(0)
  }, [selectedId])

  useEffect(() => {
    void refreshServerPackages()
  }, [])

  const previewCard = deck?.cards[previewIndex] || null
  const previewUrl = useObjectUrl(previewCard?.imageBlobKey, { thumbnail: true })

  const curatedServerPackages = useMemo(
    () =>
      CURATED_SERVER_PACKAGES.map((meta) => ({
        meta,
        serverPackage: serverPackages.find((item) => item.id === meta.id),
      })).filter(
        (item): item is {
          meta: (typeof CURATED_SERVER_PACKAGES)[number]
          serverPackage: ServerPackage
        } => Boolean(item.serverPackage),
      ),
    [serverPackages],
  )

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
      const { importDeckZip } = await import('../lib/zipPackage')
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
    if (!name?.trim() || busy) return
    setBusy(true)
    setMessage(null)
    try {
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
    } catch (error) {
      setMessage(readableImportError(error))
    } finally {
      setBusy(false)
    }
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
    <div className="home-page">
      <section className="home-stage-hero">
        <div className="home-hero-copy">
          <span className="home-stage-kicker">KARUTA LIVE · MUSIC SELECT</span>
          <h1>歌牌对战</h1>
          <p>把本地曲库变成一座闪耀的节奏舞台：先选曲，再和朋友进行 1v1 抢牌。</p>
          <div className="row home-hero-actions">
            <button className="btn btn-primary btn-lg" type="button" onClick={startGame} disabled={deckLoading && !deck}>
              开始歌牌对战
            </button>
            <Link className="btn btn-secondary btn-lg" to="/online">
              进入在线 1v1
            </Link>
          </div>
        </div>
        <div className="home-stage-visual" aria-label="首页歌曲试听">
          <div className="home-stage-aura home-stage-aura-one" />
          <div className="home-stage-aura home-stage-aura-two" />
          <div className="home-beat-ring home-beat-ring-one" />
          <div className="home-beat-ring home-beat-ring-two" />
          <HomeNowPlaying
            deck={deck}
            selectedCard={previewCard}
            volume={settings.volume}
            onVolumeChange={updateVolume}
          />
          <div className={`home-equalizer${deck?.cards.some((card) => card.songs.length) ? '' : ' paused'}`}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((bar) => (
              <i key={bar} style={{ animationDelay: `${bar * 70}ms` }} />
            ))}
          </div>
        </div>
      </section>

      <div className="grid-home">
        <section className="panel warm stack">
          <div className="row spread">
            <strong>可用数据集</strong>
            <button className="btn btn-secondary" type="button" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          <p className="muted small">在线 1v1 直接使用服务器牌组；下面的导入操作只用于本地练习或编辑。</p>

          <div className="row">
            <button className="btn btn-secondary" type="button" onClick={() => void refreshServerPackages()} disabled={packagesLoading || busy}>
              刷新服务器包
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void createEmptyDeck()} disabled={busy}>
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
              <strong>服务器牌组</strong>
              <span className="muted small">在线使用服务器卡面</span>
            </div>
            {packagesLoading ? <div className="empty-state">正在读取服务器数据包…</div> : null}
            {!packagesLoading && !curatedServerPackages.length ? (
              <div className="empty-state">服务器暂时没有可用的牌组</div>
            ) : null}
            {!packagesLoading ? (
              <div className="muca-package-grid">
                {curatedServerPackages.map(({ meta, serverPackage }) => {
                  const loaded = decks.some((item) => item.sourcePackageId === serverPackage.id)
                  return (
                    <article className={`muca-package-card ${meta.tone}`} key={serverPackage.id}>
                      <div className="muca-package-badge">{meta.code}</div>
                      <div className="muca-package-info">
                        <strong>{meta.name}</strong>
                        <span>{serverPackage.name}</span>
                        <small>
                          {formatBytes(serverPackage.size)} · {serverPackage.mode === 'full' ? '完整包' : '精简包'}
                        </small>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void loadServerPackage(serverPackage)}
                      >
                        {loaded ? '重新导入本地' : '导入本地'}
                      </button>
                    </article>
                  )
                })}
              </div>
            ) : null}
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
            <button className="btn btn-primary btn-lg btn-block" type="button" onClick={startGame} disabled={deckLoading && !deck}>
              开始本地歌牌对战
            </button>
          </div>
        </section>

        <section className="panel cool stack">
          <div>
            <h2 style={{ margin: '0 0 6px', fontFamily: 'var(--display)' }}>
              {deckLoading && !deck ? '正在读取本地牌组…' : deck?.name || '未选择数据集'}
            </h2>
            <p className="muted small">
              {deckLoading && !deck
                ? '卡面和歌曲列表会在读取完成后出现'
                : `卡牌 ${deck?.cards.length || 0} · 歌曲 ${songCount}`}
            </p>
          </div>

          <div className="preview-art">
            {previewUrl ? (
              <img src={previewUrl} alt={previewCard?.workName || ''} />
            ) : (
              <span className="muted">{deckLoading && selectedId ? '正在准备卡面预览' : '卡面预览区域'}</span>
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

          <HomeWorkList
            key={selectedId || 'empty-deck'}
            cards={deck?.cards || []}
            selectedIndex={previewIndex}
            onSelect={selectPreview}
          />
        </section>
      </div>

      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}
