import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AuthUiError } from './auth-service.ts'
import { SocialApiError } from '../../shared/api/social-api.ts'

export function useTask() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function run(action: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await action() }
    catch (error) { if (mounted.current) setError(error instanceof AuthUiError || error instanceof SocialApiError ? error.message : 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.') }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  function submit(action: () => Promise<void>) { return (event: FormEvent) => { event.preventDefault(); void run(action) } }
  return { busy, error, setError, run, submit }
}
