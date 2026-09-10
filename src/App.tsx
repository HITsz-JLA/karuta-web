import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { EditorPage } from './pages/EditorPage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { AdminPage } from './pages/AdminPage'
import { SelectPage } from './pages/SelectPage'
import { OnlinePage } from './pages/OnlinePage'

export default function App() {
  return (
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
  )
}
