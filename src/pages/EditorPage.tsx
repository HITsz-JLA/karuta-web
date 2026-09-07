import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useDeck, useDeckList } from '../hooks/useDecks'
import { useObjectUrl } from '../hooks/useObjectUrl'
import { cardsToCsv, withBom } from '../lib/csv'
import { buildPrintableCards, downloadBlob, exportPrintPdf } from '../lib/printPdf'
import { createId, putBlob } from '../lib/storage'
import { exportDeckZip } from '../lib/zipPackage'
import type { CardEntry, PrintMode, SongEntry } from '../types/models'

function blankCard(number: number): CardEntry {
  return {
    id: createId('card'),
    number,
    imageName: '',
    imageBlobKey: null,
    workName: '',
    songs: [],
  }
}

export function EditorPage() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const { decks, refresh: refreshList } = useDeckList()
  const effectiveId = deckId || decks[0]?.id
  const { deck, loading, persist, remove, refresh } = useDeck(effectiveId)
  const [draft, setDraft] = useState<CardEntry | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const imageRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!deckId && decks[0]) navigate(`/editor/${decks[0].id}`, { replace: true })
  }, [deckId, decks, navigate])

  useEffect(() => {
    if (!deck) return
    if (editingId) {
      const found = deck.cards.find((card) => card.id === editingId)
      if (found) {
        setDraft(structuredClone(found))
        return
      }
    }
    setDraft(null)
    setEditingId(null)
  }, [deck, editingId])

  const previewUrl = useObjectUrl(draft?.imageBlobKey)
  const sortedCards = useMemo(() => deck?.cards || [], [deck])

  async function saveCurrent() {
    if (!deck || !draft) return
    if (!draft.workName.trim()) {
      setStatus('请填写作品名')
      return
    }

    const nextCards = [...deck.cards]
    const index = nextCards.findIndex((card) => card.id === draft.id)
    const normalized: CardEntry = {
      ...draft,
      workName: draft.workName.trim(),
      imageName: draft.imageName || `card_${draft.number || nextCards.length + 1}.jpg`,
      number: draft.number > 0 ? draft.number : index >= 0 ? index + 1 : nextCards.length + 1,
    }

    if (index >= 0) nextCards[index] = normalized
    else nextCards.push(normalized)

    // Keep explicit numbers when possible, then renumber gaps by sort
    nextCards.sort((a, b) => a.number - b.number)
    await persist({ ...deck, cards: nextCards })
    setEditingId(normalized.id)
    setStatus('已保存')
    await refreshList()
  }

  async function deleteCurrent() {
    if (!deck || !draft) return
    if (!window.confirm(`删除「${draft.workName || '未命名'}」？`)) return
    const nextCards = deck.cards.filter((card) => card.id !== draft.id)
    await persist({ ...deck, cards: nextCards })
    setEditingId(null)
    setDraft(null)
    setStatus('已删除作品')
    await refreshList()
  }

  async function onPickImage(file: File) {
    if (!draft) return
    const key = createId('img')
    await putBlob(key, file, file.type)
    setDraft({
      ...draft,
      imageBlobKey: key,
      imageName: file.name,
    })
  }

  async function onPickAudio(files: FileList) {
    if (!draft) return
    const songs: SongEntry[] = [...draft.songs]
    for (const file of Array.from(files)) {
      const key = createId('audio')
      await putBlob(key, file, file.type)
      songs.push({
        id: createId('song'),
        fileName: file.name,
        displayName: file.name.replace(/\.[^.]+$/, ''),
        blobKey: key,
      })
    }
    setDraft({ ...draft, songs })
  }

  async function exportZip() {
    if (!deck) return
    setBusy(true)
    try {
      const blob = await exportDeckZip(deck)
      downloadBlob(blob, `${deck.name}.zip`)
      setStatus('ZIP 已导出')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv() {
    if (!deck) return
    downloadBlob(withBom(cardsToCsv(deck.cards)), `${deck.name}.csv`)
    setStatus('CSV 已导出')
  }

  async function exportPdf(mode: PrintMode) {
    if (!deck) return
    setBusy(true)
    try {
      const printable = await buildPrintableCards(deck.cards)
      const pdf = await exportPrintPdf(printable, mode)
      const suffix = mode === 'ALBUM' ? '-album-print-a4.pdf' : '-print-a4.pdf'
      downloadBlob(pdf, `${deck.name}${suffix}`)
      setStatus(mode === 'ALBUM' ? '专辑打印 PDF 已导出（图片不翻转）' : '标准打印 PDF 已导出')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'PDF 导出失败')
    } finally {
      setBusy(false)
    }
  }

  async function renameDeck() {
    if (!deck) return
    const name = window.prompt('数据集名称', deck.name)
    if (!name?.trim()) return
    await persist({ ...deck, name: name.trim() })
    await refreshList()
  }

  async function removeDeck() {
    if (!deck) return
    if (!window.confirm(`删除数据集「${deck.name}」及其本地资源？`)) return
    await remove(true)
    await refreshList()
    navigate('/editor')
  }

  if (loading) return <div className="empty-state">加载中…</div>

  if (!deck) {
    return (
      <div className="stack">
        <section className="hero">
          <h1>数据集编辑</h1>
          <p>先在首页新建或导入数据集。</p>
        </section>
        <Link className="btn btn-primary" to="/">
          返回首页
        </Link>
      </div>
    )
  }

  return (
    <>
      <section className="hero">
        <h1>{deck.name}</h1>
        <p>录入时可直接指定牌号；专辑打印模式导出时图片保持原方向，不翻转。</p>
      </section>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn btn-secondary" type="button" onClick={() => void renameDeck()}>
          重命名
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => void exportCsv()} disabled={busy}>
          导出 CSV
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => void exportZip()} disabled={busy}>
          导出 ZIP
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => void exportPdf('STANDARD')} disabled={busy}>
          标准打印 PDF
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => void exportPdf('ALBUM')} disabled={busy}>
          专辑打印 PDF
        </button>
        <button className="btn btn-danger" type="button" onClick={() => void removeDeck()}>
          删除数据集
        </button>
      </div>

      <div className="works-layout">
        <section className="panel warm stack">
          <div className="row spread">
            <strong>作品列表</strong>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                const nextNumber =
                  deck.cards.reduce((max, card) => Math.max(max, card.number), 0) + 1
                const card = blankCard(nextNumber)
                setDraft(card)
                setEditingId(card.id)
              }}
            >
              新建作品
            </button>
          </div>
          <div className="works-list">
            {sortedCards.map((card) => (
              <button
                key={card.id}
                type="button"
                className={`work-item${card.id === editingId ? ' active' : ''}`}
                onClick={() => setEditingId(card.id)}
              >
                <span className="num">#{card.number}</span>
                <span>
                  <strong>{card.workName || '未命名'}</strong>
                  <div className="muted small">{card.songs.length} 首</div>
                </span>
              </button>
            ))}
            {!sortedCards.length ? <div className="empty-state">还没有作品</div> : null}
          </div>
        </section>

        <section className="panel cool stack">
          {!draft ? (
            <div className="empty-state">选择左侧作品，或新建作品开始录入</div>
          ) : (
            <>
              <div className="row">
                <div className="field" style={{ flex: '0 0 110px' }}>
                  <label htmlFor="cardNumber">牌号</label>
                  <input
                    id="cardNumber"
                    type="number"
                    min={1}
                    value={draft.number}
                    onChange={(event) =>
                      setDraft({ ...draft, number: Number.parseInt(event.target.value, 10) || 1 })
                    }
                  />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="workName">作品名</label>
                  <input
                    id="workName"
                    value={draft.workName}
                    onChange={(event) => setDraft({ ...draft, workName: event.target.value })}
                    placeholder="作品显示名"
                  />
                </div>
              </div>

              <div className="preview-art">
                {previewUrl ? <img src={previewUrl} alt="" /> : <span className="muted">未选择图片</span>}
              </div>

              <div className="row">
                <button className="btn btn-secondary" type="button" onClick={() => imageRef.current?.click()}>
                  选择图片
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => audioRef.current?.click()}>
                  添加歌曲
                </button>
              </div>
              <input
                ref={imageRef}
                className="hidden-file"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void onPickImage(file)
                  event.target.value = ''
                }}
              />
              <input
                ref={audioRef}
                className="hidden-file"
                type="file"
                accept="audio/*,.flac,.mp3,.wav,.m4a,.ogg"
                multiple
                onChange={(event) => {
                  if (event.target.files?.length) void onPickAudio(event.target.files)
                  event.target.value = ''
                }}
              />

              <div className="stack">
                <strong>歌曲</strong>
                {draft.songs.map((song, index) => (
                  <div className="row" key={song.id}>
                    <div className="field" style={{ flex: 1 }}>
                      <label>显示名</label>
                      <input
                        value={song.displayName}
                        onChange={(event) => {
                          const songs = [...draft.songs]
                          songs[index] = { ...song, displayName: event.target.value }
                          setDraft({ ...draft, songs })
                        }}
                      />
                    </div>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          songs: draft.songs.filter((item) => item.id !== song.id),
                        })
                      }
                    >
                      移除
                    </button>
                  </div>
                ))}
                {!draft.songs.length ? <div className="muted small">尚未添加歌曲</div> : null}
              </div>

              <div className="row">
                <button className="btn btn-primary" type="button" onClick={() => void saveCurrent()}>
                  保存作品
                </button>
                <button className="btn btn-danger" type="button" onClick={() => void deleteCurrent()}>
                  删除作品
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    setDraft(null)
                    setEditingId(null)
                    void refresh()
                  }}
                >
                  取消
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {status ? <div className="toast">{status}</div> : null}
    </>
  )
}
