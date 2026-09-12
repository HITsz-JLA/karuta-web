import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
const GamePage = lazy(() => import('./pages/GamePage').then((module) => ({ default: module.GamePage })))
const SelectPage = lazy(() => import('./pages/SelectPage').then((module) => ({ default: module.SelectPage })))

const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })))
const EditorPage = lazy(() => import('./pages/EditorPage').then((module) => ({ default: module.EditorPage })))
const OnlinePage = lazy(() => import('./pages/OnlinePage').then((module) => ({ default: module.OnlinePage })))

function RouteFallback() {
  return (
    <div className="empty-state" role="status">
      页面加载中…
    </div>
  )
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="editor" element={<EditorPage />} />
          <Route path="editor/:deckId" element={<EditorPage />} />
          <Route path="select/:deckId" element={<SelectPage />} />
          <Route path="game/:deckId" element={<GamePage />} />
          <Route path="online" element={<OnlinePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
