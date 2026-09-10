import { Link, Outlet } from 'react-router-dom'

export function Layout() {
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
    </div>
  )
}
