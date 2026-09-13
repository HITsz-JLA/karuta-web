import { useCallback, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { LibraryDrawer } from '../pages/LibraryPage'

export function Layout() {
  const location = useLocation()
  const [libraryOpen, setLibraryOpen] = useState(() => location.pathname === '/library')
  const closeLibrary = useCallback(() => setLibraryOpen(false), [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          Karuta <span>Web</span>
        </Link>
        <nav className="nav-actions">
          <Link className="btn btn-ghost" to="/">
            歌牌对战
          </Link>
          <Link className="btn btn-ghost" to="/online">
            在线 1v1
          </Link>
          <button
            className={`btn btn-ghost${libraryOpen ? ' active' : ''}`}
            type="button"
            onClick={() => setLibraryOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={libraryOpen}
          >
            曲库预览
          </button>
          <Link className="btn btn-ghost" to="/editor">
            数据集
          </Link>
          <Link className="btn btn-ghost" to="/admin">
            管理员
          </Link>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <LibraryDrawer open={libraryOpen} onClose={closeLibrary} />
    </div>
  )
}
