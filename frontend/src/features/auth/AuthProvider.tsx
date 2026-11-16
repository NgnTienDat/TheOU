import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getSupabaseClient } from '../../shared/lib/supabase.ts'
import { createProfileApi } from '../../shared/api/social-api.ts'
import { createAuthService } from './auth-service.ts'
import { createSessionController } from './session-controller.ts'
import { clearPending, readPending, savePending, type PendingVerification } from './pending-verification.ts'

function useAuthRuntime() {
  const cache = useQueryClient()
  const [runtime] = useState(() => {
    const client = getSupabaseClient()
    const auth = createAuthService(client)
    const api = createProfileApi(client)
    return { auth, api, controller: createSessionController(auth, api, cache) }
  })
  const state = useSyncExternalStore(runtime.controller.subscribe, runtime.controller.getSnapshot)
  const [pending, setPendingState] = useState<PendingVerification | null>(() => {
    try { return readPending(sessionStorage) } catch { return null }
  })
  const [notice, notify] = useState('')
  useEffect(() => runtime.controller.start(), [runtime])
  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => notify(''), 3500)
    return () => clearTimeout(timeout)
  }, [notice])
  function setPending(value: PendingVerification | null) {
    setPendingState(value)
    try { if (value) savePending(sessionStorage, value); else clearPending(sessionStorage) } catch { /* Không phụ thuộc storage để xác thực. */ }
  }
  return { ...runtime, state, pending, setPending, notice, notify }
}
const AuthContext = createContext<ReturnType<typeof useAuthRuntime> | null>(null)
export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthRuntime()
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
// Provider và hook cùng feature; chỉ provider được đưa vào cây route.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('Thiếu AuthProvider')
  return value
}
