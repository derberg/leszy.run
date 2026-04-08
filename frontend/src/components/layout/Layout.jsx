import { Outlet } from 'react-router-dom'
import Navbar from './Navbar.jsx'

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-1 px-6 py-6 max-w-screen-2xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  )
}
