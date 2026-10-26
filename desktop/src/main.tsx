import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { FirstStart } from './Role'
import { lang } from './i18n'
import './styles.css'

document.documentElement.lang = lang()
/** The app once this computer knows whether it is the server or a client; the question before that. */
function Root() {
  const [role, setRole] = useState<string | null | undefined>(undefined)
  useEffect(() => { window.drive.role.get().then(r => setRole(r.role)) }, [])
  if (role === undefined) return null
  return role ? <App /> : <FirstStart onDone={setRole} />
}

createRoot(document.getElementById('root')!).render(<Root />)
