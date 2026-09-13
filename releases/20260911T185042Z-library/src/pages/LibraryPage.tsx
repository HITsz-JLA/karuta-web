import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CURATED_SERVER_PACKAGES,
  getServerPackageCatalog,
  listServerPackages,
  serverCardAudioUrl,
  serverCardImageUrl,
  type ServerPackage,
  type ServerPackageCatalog,
  type ServerPackageCatalogCard,
  type ServerPackageCatalogSong,
} from '../lib/serverPackages'

interface NowPlaying {
  key: string
  workName: string
  songName: string
}

function packageDisplayName(item: ServerPackage) {
  return CURATED_SERVER_PACKAGES.find((candidate) => candidate.id === item.id)?.name || item.name
}

export function LibraryPage() {
  const [packages, setPackages] = useState<ServerPackage[]>([])
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [catalog, setCatalog] = useState<ServerPackageCatalog | null>(null)
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [error, setError] = useState('')
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [audioError, setAudioError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeAudioKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPackagesLoading(true)
    listServerPackages()
      .then((items) => {
        if (cancelled) return
        setPackages(items)
        setSelectedPackageId((current) => current || items[0]?.id || '')
        setError('')
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取服务器曲库')
      })
      .finally(() => {
        if (!cancelled) setPackagesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    audio?.pause()
    if (audio) {
      audio.removeAttribute('src')
      audio.load()
    }
    setNowPlaying(null)
    setPlayingKey(null)
    activeAudioKeyRef.current = null
    setAudioError('')
    setCatalog(null)
    if (!selectedPackageId) return

    let cancelled = false
    setCatalogLoading(true)
    getServerPackageCatalog(selectedPackageId)
      .then((nextCatalog) => {
        if (!cancelled) {
          setCatalog(nextCatalog)
          setError('')
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取曲库内容')
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPackageId])

  useEffect(() => () => {
    const audio = audioRef.current
    audio?.pause()
    audio?.removeAttribute('src')
  }, [])

  const selectedPackage = packages.find((item) => item.id === selectedPackageId)
  const songCount = useMemo(
    () => catalog?.cards.reduce((total, card) => total + card.songs.length, 0) || 0,
    [catalog],
  )

  const playSong = useCallback(async (card: ServerPackageCatalogCard, song: ServerPackageCatalogSong) => {
    const audio = audioRef.current
    if (!audio || !selectedPackageId) return
    const key = `${card.key}:${song.index}`
    if (playingKey === key && !audio.paused) {
      audio.pause()
      return
    }

    activeAudioKeyRef.current = key
    setNowPlaying({ key, workName: card.workName, songName: song.displayName })
    setAudioError('')
    audio.src = serverCardAudioUrl(selectedPackageId, card.key, song.index)
    audio.load()
    try {
      await audio.play()
    } catch {
      setPlayingKey(null)
      setAudioError('无法播放这首音频，请检查浏览器音频权限或资源格式。')
    }
  }, [playingKey, selectedPackageId])

  return (
    <section className="library-page">
      <div className="library-aura library-aura-one" aria-hidden="true" />
      <div className="library-aura library-aura-two" aria-hidden="true" />

      <header className="hero library-hero">
        <div>
          <span className="library-kicker">SERVER MUSIC LIBRARY</span>
          <h1>曲库预览</h1>
          <p>选择曲库，浏览全部卡牌并试听其中的歌曲。</p>
        </div>
        {catalog ? (
          <div className="library-stats" aria-label="曲库统计">
            <span><strong>{catalog.cards.length}</strong> 张卡牌</span>
            <span><strong>{songCount}</strong> 首歌曲</span>
          </div>
        ) : null}
      </header>

      <section className="panel library-toolbar" aria-label="曲库选择">
        <div className="field">
          <label htmlFor="libraryPackage">选择曲库</label>
          <select
            id="libraryPackage"
            value={selectedPackageId}
            onChange={(event) => setSelectedPackageId(event.target.value)}
            disabled={packagesLoading || !packages.length}
          >
            {!packages.length ? <option value="">暂无可用曲库</option> : null}
            {packages.map((item) => (
              <option key={item.id} value={item.id}>{packageDisplayName(item)}</option>
            ))}
          </select>
        </div>
        <div className="library-selection-summary">
          <span>当前曲库</span>
          <strong>{selectedPackage ? packageDisplayName(selectedPackage) : '等待选择'}</strong>
          <small>{catalog ? `共 ${catalog.cards.length} 张卡牌，可直接点击曲目试听` : '请选择一个服务器曲库'}</small>
        </div>
      </section>

      {error ? <div className="status-banner warn library-message" role="alert">{error}</div> : null}
      {packagesLoading || catalogLoading ? <div className="panel empty-state library-message">正在读取曲库…</div> : null}
      {!packagesLoading && !catalogLoading && !error && !catalog?.cards.length ? (
        <div className="panel empty-state library-message">这个曲库中还没有可预览的卡牌</div>
      ) : null}

      {catalog?.cards.length ? (
        <>
          <div className={`library-player${nowPlaying ? ' active' : ''}`}>
            <div className="library-player-copy">
              <span>{nowPlaying ? '正在试听' : '选择一首歌曲开始试听'}</span>
              <strong>{nowPlaying ? nowPlaying.workName : selectedPackage ? packageDisplayName(selectedPackage) : '曲库预览'}</strong>
              <small>{nowPlaying?.songName || '每张卡牌下方会列出可播放曲目'}</small>
            </div>
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              onPlay={() => setPlayingKey(activeAudioKeyRef.current)}
              onPause={() => setPlayingKey(null)}
              onEnded={() => setPlayingKey(null)}
              onError={() => setAudioError('音频加载失败，请稍后重试。')}
            />
            {audioError ? <span className="library-audio-error" role="alert">{audioError}</span> : null}
          </div>

          <div className="library-card-grid" aria-label={`${catalog.deckName} 全部卡牌`}>
            {catalog.cards.map((card) => (
              <article className="library-card" key={card.key}>
                <div className="library-card-art">
                  <span className="library-card-number">#{card.number}</span>
                  <img
                    src={serverCardImageUrl(catalog.packageId, card.key)}
                    alt={card.workName}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className="library-card-copy">
                  <h2>{card.workName}</h2>
                  <span>{card.songCount} 首歌曲</span>
                </div>
                <div className="library-song-list">
                  {card.songs.map((song) => {
                    const songKey = `${card.key}:${song.index}`
                    const isPlaying = playingKey === songKey
                    return (
                      <button
                        className={`library-song-button${isPlaying ? ' playing' : ''}`}
                        type="button"
                        key={songKey}
                        onClick={() => void playSong(card, song)}
                        aria-pressed={isPlaying}
                        aria-label={`${isPlaying ? '暂停' : '播放'} ${card.workName}：${song.displayName}`}
                      >
                        <span className="library-play-icon" aria-hidden="true">{isPlaying ? 'Ⅱ' : '▶'}</span>
                        <span>{song.displayName}</span>
                      </button>
                    )
                  })}
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
}
