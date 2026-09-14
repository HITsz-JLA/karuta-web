import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  CURATED_SERVER_PACKAGES,
  getServerPackageCatalog,
  listServerPackages,
  previewAudioUrl,
  serverCardImageUrl,
  type ServerPackage,
  type ServerPackageCatalog,
  type ServerPackageCatalogCard,
} from '../lib/serverPackages'

type PreviewFilter = 'all' | 'multi'

function decodePackageId(value: string | undefined) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function packageLabel(serverPackage: ServerPackage) {
  const curated = CURATED_SERVER_PACKAGES.find((item) => item.id === serverPackage.id)
  return curated ? `${curated.name} · ${serverPackage.name}` : serverPackage.name
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const wholeSeconds = Math.floor(seconds)
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
}

function rangeStyle(value: number, max: number) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return { '--preview-range-progress': `${percent}%` } as CSSProperties
}

const PreviewCardTile = function PreviewCardTile({
  card,
  packageId,
  selected,
  onSelect,
}: {
  card: ServerPackageCatalogCard
  packageId: string
  selected: boolean
  onSelect: (card: ServerPackageCatalogCard) => void
}) {
  const handleClick = useCallback(() => onSelect(card), [card, onSelect])
  return (
    <button
      className={`package-preview-card${selected ? ' selected' : ''}`}
      type="button"
      onClick={handleClick}
      aria-pressed={selected}
      aria-label={`#${card.number} ${card.workName}，${card.songCount} 首歌曲`}
    >
      <span className="package-preview-number">#{card.number}</span>
      <div className="package-preview-image">
        <img
          src={serverCardImageUrl(packageId, card.key)}
          alt={card.workName}
          loading="lazy"
          decoding="async"
        />
      </div>
      <strong>{card.workName}</strong>
      <span className="muted small">{card.songCount} 首歌曲</span>
    </button>
  )
}

interface PreviewCardGridProps {
  cards: ServerPackageCatalogCard[]
  packageId: string
  selectedKey: string | null
  onSelect: (card: ServerPackageCatalogCard) => void
  resetKey: string
}

function PreviewCardGrid({ cards, packageId, selectedKey, onSelect, resetKey }: PreviewCardGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 560 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight || 560 })
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

  const columns = Math.max(1, Math.floor((viewport.width + 12) / (viewport.width >= 720 ? 196 : 146)))
  const availableWidth = Math.max(320, viewport.width)
  const cardWidth = Math.max(130, (availableWidth - (columns - 1) * 12 - 6) / columns)
  const rowHeight = Math.max(238, Math.ceil(cardWidth * 1.45 + 76))
  const rowCount = Math.ceil(cards.length / columns)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewport.height) / rowHeight) + 2)
  const startIndex = firstRow * columns
  const visibleCards = cards.slice(startIndex, lastRow * columns)

  return (
    <div
      className="package-preview-viewport"
      ref={viewportRef}
      onScroll={handleScroll}
      aria-label={`服务器曲库，共 ${cards.length} 张卡面`}
    >
      <div className="package-preview-canvas" style={{ height: `${rowCount * rowHeight}px` }}>
        <div
          className="package-preview-window"
          style={{
            top: `${firstRow * rowHeight}px`,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoRows: `${rowHeight}px`,
          }}
        >
          {visibleCards.map((card) => (
            <PreviewCardTile
              key={card.key}
              card={card}
              packageId={packageId}
              selected={card.key === selectedKey}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function PackagePreviewPage() {
  const navigate = useNavigate()
  const { packageId: packageParam } = useParams()
  const packageId = decodePackageId(packageParam)
  const [catalog, setCatalog] = useState<ServerPackageCatalog | null>(null)
  const [serverPackages, setServerPackages] = useState<ServerPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<PreviewFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [songIndex, setSongIndex] = useState(0)
  const [pendingAutoplay, setPendingAutoplay] = useState(false)
  const [audioMessage, setAudioMessage] = useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioPosition, setAudioPosition] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [audioVolume, setAudioVolume] = useState(0.8)
  const [audioMuted, setAudioMuted] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const deferredKeyword = useDeferredValue(keyword)

  useEffect(() => {
    if (!packageId) {
      setError('牌组链接无效')
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    setCatalog(null)
    setSelectedKey(null)
    setSongIndex(0)
    setPendingAutoplay(false)
    setAudioMessage(null)
    void Promise.allSettled([getServerPackageCatalog(packageId), listServerPackages()]).then((results) => {
      if (!active) return
      const [catalogResult, packagesResult] = results
      if (catalogResult.status === 'rejected') {
        setError(catalogResult.reason instanceof Error ? catalogResult.reason.message : '无法读取服务器曲库')
        setLoading(false)
        return
      }
      setCatalog(catalogResult.value)
      if (packagesResult.status === 'fulfilled') {
        setServerPackages(packagesResult.value)
      }
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [packageId])

  const visibleCards = useMemo(() => {
    if (!catalog) return []
    const query = deferredKeyword.trim().toLowerCase()
    return catalog.cards.filter((card) => {
      if (filter === 'multi' && card.songCount < 2) return false
      if (!query) return true
      const songs = card.songs.map((song) => song.displayName).join(' ')
      return `${card.number} ${card.workName} ${songs}`.toLowerCase().includes(query)
    })
  }, [catalog, deferredKeyword, filter])

  useEffect(() => {
    setSelectedKey((previous) => {
      if (previous && visibleCards.some((card) => card.key === previous)) return previous
      return visibleCards[0]?.key || null
    })
  }, [visibleCards])

  useEffect(() => {
    setSongIndex(0)
    setPendingAutoplay(false)
    setAudioMessage(null)
    setAudioPlaying(false)
    setAudioPosition(0)
    setAudioDuration(0)
  }, [selectedKey])

  const selectedCard = useMemo(
    () => catalog?.cards.find((card) => card.key === selectedKey) || null,
    [catalog, selectedKey],
  )
  const audioSource = selectedCard ? previewAudioUrl(packageId, selectedCard.key, songIndex) : null

  useEffect(() => {
    setAudioPlaying(false)
    setAudioPosition(0)
    setAudioDuration(0)
  }, [audioSource])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = audioVolume
    audio.muted = audioMuted
  }, [audioMuted, audioSource, audioVolume])

  useEffect(() => {
    const audio = audioRef.current
    if (!pendingAutoplay || !audioSource || !audio) return
    let active = true
    void audio
      .play()
      .catch(() => {
        if (active) setAudioMessage('浏览器阻止了自动播放，请点击下方播放器的播放按钮')
      })
      .finally(() => {
        if (active) setPendingAutoplay(false)
      })
    return () => {
      active = false
    }
  }, [audioSource, pendingAutoplay])

  const handleSelect = useCallback((card: ServerPackageCatalogCard) => {
    setSelectedKey(card.key)
  }, [])

  const playSong = useCallback((index: number) => {
    setSongIndex(index)
    setAudioMessage(null)
    setPendingAutoplay(true)
  }, [])

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!audio.paused) {
      audio.pause()
      return
    }
    setAudioMessage(null)
    void audio.play().catch(() => setAudioMessage('浏览器暂时无法播放这首音频，请重试'))
  }, [])

  const seekAudio = useCallback((value: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(value)) return
    audio.currentTime = value
    setAudioPosition(value)
  }, [])

  const updateAudioVolume = useCallback((value: number) => {
    const nextVolume = Math.min(1, Math.max(0, value))
    setAudioVolume(nextVolume)
    setAudioMuted(nextVolume === 0)
  }, [])

  const toggleAudioMute = useCallback(() => {
    setAudioMuted((previous) => !previous)
  }, [])

  if (loading) return <div className="empty-state">正在读取服务器曲库目录…</div>

  if (error || !catalog) {
    return (
      <div className="stack">
        <section className="hero">
          <h1>歌牌预览器</h1>
          <p>{error || '服务器曲库暂时不可用'}</p>
        </section>
        <Link className="btn btn-secondary" to="/">
          返回首页
        </Link>
      </div>
    )
  }

  return (
    <div className="package-preview-page">
      <section className="hero package-preview-hero">
        <div className="package-preview-hero-copy">
          <span className="eyebrow">SERVER LIBRARY PREVIEW</span>
          <label className="visually-hidden" htmlFor="packagePreviewLibrary">选择曲库</label>
          <select
            className="package-preview-library-title"
            id="packagePreviewLibrary"
            value={packageId}
            disabled={serverPackages.length < 2}
            onChange={(event) => navigate(`/preview/${encodeURIComponent(event.target.value)}`)}
          >
            {serverPackages.length ? (
              serverPackages.map((serverPackage) => (
                <option key={serverPackage.id} value={serverPackage.id}>
                  {packageLabel(serverPackage)}
                </option>
              ))
            ) : (
              <option value={packageId}>{catalog.deckName}</option>
            )}
          </select>
          <div className="package-preview-stats">
            <span className="chip">{catalog.cards.length} 张卡牌</span>
            <span className="chip">{catalog.cards.reduce((sum, card) => sum + card.songCount, 0)} 首歌曲</span>
          </div>
        </div>
        <div className="package-preview-actions">
          <Link className="btn btn-secondary" to="/">
            返回首页
          </Link>
          <Link className="btn btn-primary" to="/online">
            在线 1v1
          </Link>
        </div>
      </section>

      <section className="panel package-preview-toolbar">
        <div className="field package-preview-search">
          <label htmlFor="packagePreviewSearch">搜索作品或歌曲</label>
          <input
            id="packagePreviewSearch"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="输入作品名、牌号或曲名"
          />
        </div>
        <div className="selection-toolbar" role="group" aria-label="曲库筛选">
          <span className="muted small">显示</span>
          {([
            ['all', `全部 ${catalog.cards.length}`],
            ['multi', `多曲作品 ${catalog.cards.filter((card) => card.songCount > 1).length}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={`filter-chip${filter === value ? ' active' : ''}`}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
          <span className="muted small">当前 {visibleCards.length} 张</span>
        </div>
      </section>

      <div className="package-preview-layout">
        <section className="panel stack">
          <div className="row spread">
            <div>
              <strong>曲库卡面</strong>
            </div>
            <span className="muted small">{visibleCards.length} / {catalog.cards.length}</span>
          </div>
          {visibleCards.length ? (
            <PreviewCardGrid
              cards={visibleCards}
              packageId={packageId}
              selectedKey={selectedKey}
              onSelect={handleSelect}
              resetKey={`${deferredKeyword}:${filter}`}
            />
          ) : (
            <div className="empty-state">没有匹配的作品</div>
          )}
        </section>

        <aside className="panel stack package-preview-detail" aria-label="曲目试听">
          {!selectedCard ? (
            <div className="empty-state">选择一张卡面查看曲目</div>
          ) : (
            <>
              <div className="row spread">
                <strong>作品详情</strong>
                <span className="package-preview-number">#{selectedCard.number}</span>
              </div>
              <div className="package-preview-detail-cover">
                <img
                  src={serverCardImageUrl(packageId, selectedCard.key)}
                  alt={selectedCard.workName}
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div className="stack package-preview-detail-heading">
                <h2>{selectedCard.workName}</h2>
                <span className="muted small">{selectedCard.songCount} 首曲目</span>
              </div>
              <div className="package-preview-song-list">
                {selectedCard.songs.map((song, index) => (
                  <button
                    key={`${song.fileName}-${index}`}
                    className={`package-preview-song${songIndex === index ? ' active' : ''}`}
                    type="button"
                    aria-pressed={songIndex === index}
                    onClick={() => playSong(index)}
                  >
                    <span className="package-preview-song-index">{index + 1}</span>
                    <span className="package-preview-song-name">{song.displayName}</span>
                    <span className="package-preview-song-action">{songIndex === index ? '当前' : '试听'}</span>
                  </button>
                ))}
              </div>
              <div className="package-preview-audio">
                <strong>单曲试听</strong>
                {audioSource ? (
                  <>
                    <audio
                      key={audioSource}
                      ref={audioRef}
                      preload="metadata"
                      src={audioSource}
                      onDurationChange={(event) => setAudioDuration(event.currentTarget.duration || 0)}
                      onTimeUpdate={(event) => setAudioPosition(event.currentTarget.currentTime)}
                      onError={() => {
                        setAudioPlaying(false)
                        setAudioMessage('音频暂时无法读取，请稍后重试')
                      }}
                      onPlay={() => {
                        setAudioPlaying(true)
                        setAudioMessage(null)
                      }}
                      onPause={() => setAudioPlaying(false)}
                      onEnded={() => setAudioPlaying(false)}
                    />
                    <div className="package-preview-player">
                      <button
                        className="package-preview-player-button"
                        type="button"
                        aria-label={audioPlaying ? '暂停试听' : '播放试听'}
                        onClick={togglePlayback}
                      >
                        {audioPlaying ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
                        )}
                      </button>
                      <span className="package-preview-player-time">{formatTime(audioPosition)}</span>
                      <input
                        className="package-preview-range package-preview-progress"
                        type="range"
                        min={0}
                        max={audioDuration || 0}
                        step={0.05}
                        value={Math.min(audioPosition, audioDuration || 0)}
                        style={rangeStyle(audioPosition, audioDuration)}
                        aria-label="试听进度"
                        disabled={!audioDuration}
                        onChange={(event) => seekAudio(Number(event.target.value))}
                      />
                      <span className="package-preview-player-time">{formatTime(audioDuration)}</span>
                      <button
                        className="package-preview-volume-button"
                        type="button"
                        aria-label={audioMuted ? '取消静音' : '静音'}
                        aria-pressed={audioMuted}
                        onClick={toggleAudioMute}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 9v6h4l5 4V5L8 9H4zm12.2-.9a5 5 0 0 1 0 7.8l-1.2-1.5a3 3 0 0 0 0-4.8l1.2-1.5z" />
                          {audioMuted ? <path d="m18.2 9.2 1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4 1.4 1.4 1.4-1.4z" /> : null}
                        </svg>
                      </button>
                      <input
                        className="package-preview-range package-preview-volume"
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={audioMuted ? 0 : audioVolume}
                        style={rangeStyle(audioMuted ? 0 : audioVolume, 1)}
                        aria-label="试听音量"
                        onChange={(event) => updateAudioVolume(Number(event.target.value))}
                      />
                    </div>
                  </>
                ) : null}
                {audioMessage ? <span className="notice warn">{audioMessage}</span> : null}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
