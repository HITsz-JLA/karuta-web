import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useDeck, useSettings } from '../hooks/useDecks'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { GameEngine, type GameSnapshot } from '../lib/gameEngine'
import type { SelectionResult } from '../types/models'

export function GamePage() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const { deck, loading } = useDeck(deckId)
  const { settings, update } = useSettings()
  const [engine] = useState(() => new GameEngine())
  const [snap, setSnap] = useState<GameSnapshot | null>(null)
  const [showAdmin, setShowAdmin] = useState(false)
  const [selectedAdminId, setSelectedAdminId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const imageUrl = useObjectUrl(snap?.currentCard?.imageBlobKey)

  useEffect(() => {
    const unsubscribe = engine.subscribe(setSnap)
    return () => {
      unsubscribe()
      engine.dispose()
    }
  }, [engine])

  useEffect(() => {
    if (!deck || ready) return
    const raw = sessionStorage.getItem(`karuta-selection:${deck.id}`)
    if (!raw) {
      navigate(`/select/${deck.id}`, { replace: true })
      return
    }

    try {
      const selection = JSON.parse(raw) as SelectionResult
      engine.start({
        selectedCards: selection.selected,
        emptySources: selection.emptySources,
        restPool: selection.restPool,
        failureMode: settings.failureMode,
        enableRestMusic: settings.enableRestMusic,
        minDuration: settings.minDuration,
        maxDuration: settings.maxDuration,
        volume: settings.volume,
      })
      setReady(true)
    } catch {
      navigate(`/select/${deck.id}`, { replace: true })
    }
  }, [deck, engine, navigate, ready, settings])

  const successCount = useMemo(
    () => snap?.results.filter((item) => item === 'SUCCESS').length || 0,
    [snap],
  )
  const failureCount = useMemo(
    () => snap?.results.filter((item) => item === 'FAILURE').length || 0,
    [snap],
  )
  const successRate = snap?.results.length
    ? Math.round((successCount / snap.results.length) * 100)
    : 0

  const statusText = (() => {
    if (!snap) return '初始化中'
    switch (snap.roundState) {
      case 'IDLE':
        return '点击「准备」开始回合'
      case 'CARD_SELECTED':
        return '正在加载音频…'
      case 'MUSIC_PLAYING':
        return '播放中，可随时判定'
      case 'WAITING_RESULT':
        return '等待判定'
      case 'EMPTY_CARD':
        return '空牌回合（自动记成功）'
      case 'REST_MUSIC':
        return '休息中'
      case 'GAME_OVER':
        return '对局结束'
      default:
        return snap.roundState
    }
  })()

  const canJudge =
    snap &&
    (snap.roundState === 'MUSIC_PLAYING' ||
      snap.roundState === 'WAITING_RESULT' ||
      snap.roundState === 'EMPTY_CARD')

  const canPrepare =
    snap &&
    (snap.roundState === 'IDLE' ||
      snap.roundState === 'REST_MUSIC' ||
      snap.roundState === 'ROUND_COMPLETE')

  if (loading || !ready) return <div className="empty-state">加载对局…</div>

  return (
    <>
      <section className="hero">
        <div className="row spread">
          <div>
            <h1>对战中</h1>
            <p>
              已进行 {snap?.currentRound || 0} · 剩余实牌{' '}
              {snap?.activeCards.filter((card) => !card.emptyCard).length || 0}
            </p>
          </div>
          <div className="stat-chips">
            <span className="chip">
              成功 {successCount} · 失败 {failureCount} · {successRate}%
            </span>
            <span className="chip">在场 {snap?.activeCards.length || 0}</span>
          </div>
        </div>
      </section>

      <div className={`status-banner${snap?.error ? ' warn' : ''}`}>{snap?.error || statusText}</div>

      <div className="field" style={{ margin: '14px 0' }}>
        <label htmlFor="volume">音量 {Math.round(settings.volume * 100)}%</label>
        <input
          id="volume"
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.volume * 100)}
          onChange={(event) => {
            const volume = Number(event.target.value) / 100
            void update({ volume })
            engine.setVolume(volume)
          }}
        />
      </div>

      <div className="game-layout">
        <section className="panel warm stack">
          <strong>卡面</strong>
          <div className="preview-art">
            {imageUrl ? (
              <img src={imageUrl} alt={snap?.currentCard?.workName || ''} />
            ) : (
              <span className="muted">等待准备</span>
            )}
          </div>
          <div style={{ textAlign: 'center' }}>
            <strong>
              {snap?.currentCard
                ? `#${snap.currentCard.number} ${snap.currentCard.workName}`
                : '尚未选牌'}
            </strong>
            {snap?.currentCard?.emptyCard ? <div className="muted small">空牌</div> : null}
          </div>
        </section>

        <section className="panel cool stack">
          <strong>本回合</strong>
          <div>
            <div className="muted small">曲目</div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>
              {snap?.currentSong?.displayName || (snap?.currentCard?.emptyCard ? '（空牌无强制曲目）' : '—')}
            </div>
          </div>
          <div>
            <div className="muted small">片段时长</div>
            <div>{snap?.playbackDuration ? `${snap.playbackDuration} 秒` : '—'}</div>
          </div>
          <div className="game-actions-mobile">
            <button
              className="btn btn-primary btn-lg btn-prepare"
              type="button"
              disabled={!canPrepare || snap?.roundState === 'GAME_OVER'}
              onClick={() => engine.prepareNextRound()}
            >
              {snap?.currentRound === 0 ? '准备' : '准备下一回合'}
            </button>
            <button
              className="btn btn-primary btn-lg"
              type="button"
              disabled={!canJudge}
              onClick={() => engine.submitResult('SUCCESS')}
            >
              Success
            </button>
            <button
              className="btn btn-danger btn-lg"
              type="button"
              disabled={!canJudge || Boolean(snap?.currentCard?.emptyCard)}
              onClick={() => engine.submitResult('FAILURE')}
            >
              Failure
            </button>
            {snap?.roundState === 'REST_MUSIC' ? (
              <button className="btn btn-secondary btn-lg" type="button" onClick={() => engine.toggleRestMusic()}>
                {snap.isRestPlaying ? '暂停休息曲' : '播放休息曲'}
              </button>
            ) : null}
          </div>
          <div className="row">
            <button className="btn btn-secondary" type="button" onClick={() => setShowAdmin((value) => !value)}>
              {showAdmin ? '收起管理' : '管理员面板'}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                engine.abort()
                navigate('/')
              }}
            >
              结束并返回
            </button>
          </div>
        </section>

        <section className="panel queue-panel stack">
          <strong>在场队列</strong>
          <div className="works-list">
            {(snap?.activeCards || []).map((card) => (
              <div className="work-item" key={card.id}>
                <span className="num">#{card.number}</span>
                <span>
                  <strong>{card.workName}</strong>
                  <div className="muted small">{card.emptyCard ? '空牌' : `${card.songs.length} 首`}</div>
                </span>
              </div>
            ))}
            {!snap?.activeCards.length ? <div className="empty-state">无在场卡牌</div> : null}
          </div>
        </section>
      </div>

      {showAdmin ? (
        <section className="panel stack" style={{ marginTop: 16 }}>
          <div className="row spread">
            <strong>管理员面板</strong>
            <button className="btn btn-secondary" type="button" onClick={() => engine.resetInactiveToActive()}>
              重置 inactive → active
            </button>
          </div>
          <div className="admin-cols">
            <div className="stack">
              <span className="muted small">Active</span>
              <div className="list-box">
                {snap?.activeCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={selectedAdminId === card.id ? 'selected' : ''}
                    onClick={() => setSelectedAdminId(card.id)}
                  >
                    #{card.number} {card.workName}
                    {card.emptyCard ? '（空）' : ''}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!selectedAdminId}
                onClick={() => selectedAdminId && engine.moveCard(selectedAdminId, false)}
              >
                移到 inactive
              </button>
            </div>
            <div className="stack">
              <span className="muted small">Inactive</span>
              <div className="list-box">
                {snap?.inactiveCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={selectedAdminId === card.id ? 'selected' : ''}
                    onClick={() => setSelectedAdminId(card.id)}
                  >
                    #{card.number} {card.workName}
                    {card.emptyCard ? '（空）' : ''}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!selectedAdminId}
                onClick={() => selectedAdminId && engine.moveCard(selectedAdminId, true)}
              >
                移到 active
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {snap?.roundState === 'GAME_OVER' ? (
        <div className="sticky-actions">
          <Link className="btn btn-primary btn-lg" to="/">
            返回首页
          </Link>
        </div>
      ) : null}
    </>
  )
}
