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
            对局
          </Link>
          <Link className="btn btn-ghost" to="/editor">
            数据集
          </Link>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
