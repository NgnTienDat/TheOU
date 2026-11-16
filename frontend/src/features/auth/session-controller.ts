import type { QueryClient } from '@tanstack/react-query'
import type { Me } from '../../shared/api/SocialApiClient.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'
import type { AuthIdentity, AuthService } from './auth-service.ts'

export interface AuthState {
  phase: 'loading' | 'guest' | 'ready' | 'blocked' | 'error'
  me: Me | null
}
export function createSessionController(auth: AuthService, api: { getMe(): Promise<Me> }, cache: QueryClient) {
  let state: AuthState = { phase: 'loading', me: null }
  let current: AuthIdentity | null = null
  let epoch = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const emit = (next: AuthState) => { state = next; listeners.forEach(listener => listener()) }
  function resetCache() { void cache.cancelQueries(); cache.clear() }
  async function load(version: number, userId: string) {
    try {
      const me = await cache.fetchQuery({ queryKey: ['me', userId, version], queryFn: () => api.getMe(), retry: false })
      if (!disposed && version === epoch) emit({ phase: 'ready', me })
    } catch (error) {
      if (disposed || version !== epoch) return
      resetCache()
      if (error instanceof SocialApiError && error.code === 'UNAUTHENTICATED') {
        current = null
        emit({ phase: 'guest', me: null })
        void auth.logout().catch(() => {})
      } else emit({ phase: error instanceof SocialApiError && error.code === 'FORBIDDEN' ? 'blocked' : 'error', me: null })
    }
  }
  function accept(value: AuthIdentity | null) {
    if (disposed) return
    if (value && current?.token === value.token && current.userId === value.userId && state.phase === 'ready') return
    current = value
    const version = ++epoch
    resetCache()
    emit({ phase: value ? 'loading' : 'guest', me: null })
    // Không gọi SDK bất đồng bộ bên trong callback Auth (tránh giữ Auth lock).
    if (value) queueMicrotask(() => { if (version === epoch && !disposed) void load(version, value.userId) })
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start() {
      disposed = false
      const unsubscribe = auth.subscribe(accept)
      const version = epoch
      void auth.restore().then(value => { if (version === epoch) accept(value) }).catch(() => {
        if (!disposed && version === epoch) emit({ phase: 'error', me: null })
      })
      return () => { disposed = true; ++epoch; unsubscribe(); resetCache() }
    },
    retry: () => {
      if (current) { accept(current); return }
      const version = ++epoch
      resetCache(); emit({ phase: 'loading', me: null })
      void auth.restore().then(value => { if (!disposed && version === epoch) accept(value) })
        .catch(() => { if (!disposed && version === epoch) emit({ phase: 'error', me: null }) })
    },
    replaceNickname(nickname: string, expected: Me) {
      if (state.phase === 'ready' && state.me === expected) {
        const me = { ...expected, nickname }
        cache.setQueriesData({ queryKey: ['me'] }, me)
        emit({ phase: 'ready', me })
      }
    },
    reject(error: unknown) {
      if (error instanceof SocialApiError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) {
        ++epoch; current = null; resetCache()
        emit({ phase: error.code === 'FORBIDDEN' ? 'blocked' : 'guest', me: null })
        if (error.code === 'UNAUTHENTICATED') void auth.logout().catch(() => {})
      }
    },
    async logout() {
      ++epoch; current = null; resetCache(); emit({ phase: 'loading', me: null })
      try { await auth.logout(); emit({ phase: 'guest', me: null }) }
      catch (error) { emit({ phase: 'error', me: null }); throw error }
    },
  }
}
