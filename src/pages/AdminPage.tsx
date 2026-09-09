import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getAdminSession,
  listServerPackages,
  loginAdmin,
  logoutAdmin,
  type ServerPackage,
  uploadServerPackage,
} from '../lib/serverPackages'
import type { PackageMode } from '../types/models'

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function AdminPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [password, setPassword] = useState('')
  const [packageMode, setPackageMode] = useState<PackageMode>('full')
  const [packages, setPackages] = useState<ServerPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
    void checkSession()
  }, [])

  async function refresh() {
    setLoading(true)
    try {
      setPackages(await listServerPackages())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法读取服务器数据包')
    } finally {
      setLoading(false)
    }
  }

  async function checkSession() {
    try {
      setAuthenticated(await getAdminSession())
    } catch {
      setAuthenticated(false)
    }
  }

  async function handleLogin() {
    if (!password) return
    setBusy(true)
    setMessage(null)
    try {
      await loginAdmin(password)
      setAuthenticated(true)
      setPassword('')
      setMessage('管理员登录成功')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '管理员登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    setBusy(true)
    try {
      await logoutAdmin()
      setAuthenticated(false)
      setMessage('已退出管理员登录')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleUpload(file: File) {
    setBusy(true)
    setMessage(null)
    try {
      await uploadServerPackage(file, packageMode)
      await refresh()
      setMessage(`已上传服务器数据包：${file.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '上传服务器数据包失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <section className="hero">
        <h1>管理员控制台</h1>
        <p>只有管理员可以上传或更新服务器歌牌数据包。</p>
      </section>

      <section className="panel stack">
        {!authenticated ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              void handleLogin()
            }}
          >
            <div className="field">
              <label htmlFor="adminPassword">管理员密码</label>
              <input
                id="adminPassword"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !password}>
              {busy ? '登录中…' : '登录管理员控制台'}
            </button>
          </form>
        ) : (
          <>
            <div className="row spread">
              <strong>已登录管理员</strong>
              <button className="btn btn-secondary" type="button" onClick={() => void handleLogout()} disabled={busy}>
                退出登录
              </button>
            </div>
            <p className="muted small">上传的 ZIP 会保存到服务器本地 data-packages 目录，普通用户只能读取。</p>
            <div className="field">
              <label htmlFor="packageMode">数据包模式</label>
              <select
                id="packageMode"
                value={packageMode}
                onChange={(event) => setPackageMode(event.target.value as PackageMode)}
                disabled={busy}
              >
                <option value="full">完整包（对局片段 + 休息完整歌曲）</option>
                <option value="lite">精简包（只保留 30 秒片段）</option>
              </select>
              <span className="muted small">模式会保存到服务器元数据；服务器选择会优先于 ZIP 内 manifest。</span>
            </div>
            <div className="row">
              <button className="btn btn-primary" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
                选择 ZIP 数据包
              </button>
              <input
                ref={fileRef}
                className="hidden-file"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleUpload(file)
                  event.target.value = ''
                }}
              />
            </div>
          </>
        )}
      </section>

      <section className="panel stack">
        <div className="row spread">
          <strong>服务器数据包</strong>
          <button className="btn btn-secondary" type="button" onClick={() => void refresh()} disabled={loading || busy}>
            刷新
          </button>
        </div>
        {loading ? <div className="empty-state">正在读取…</div> : null}
        {!loading && !packages.length ? <div className="empty-state">还没有上传数据包</div> : null}
        {!loading
          ? packages.map((item) => (
              <div className="row spread" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <div className="muted small">
                    {formatBytes(item.size)} · {item.mode === 'full' ? '完整包' : '精简包'} ·{' '}
                    {new Date(item.updatedAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))
          : null}
      </section>

      <Link className="btn btn-secondary" to="/">
        返回首页
      </Link>

      {message ? <div className="toast">{message}</div> : null}
    </div>
  )
}
