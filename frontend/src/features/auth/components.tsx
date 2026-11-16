import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'

export function Arrow() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h16m-7-7 7 7-7 7" /></svg> }
export function Note({ children }: { children: ReactNode }) {
  return <div className="note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg><span>{children}</span></div>
}
export function Field({ label, error, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const password = props.type === 'password'
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="input-wrap">
      <input {...props} id={id} type={password && visible ? 'text' : props.type} className={`input${password ? ' password' : ''}`} aria-invalid={!!error} aria-describedby={error || hint ? `${id}-help` : undefined} />
      {password && <button type="button" className="text-btn toggle-password" disabled={props.disabled} onClick={() => setVisible(!visible)} aria-label={`${visible ? 'Ẩn' : 'Hiện'} ${label.toLowerCase()}`} aria-pressed={visible}>{visible ? 'Ẩn' : 'Hiện'}</button>}
    </div>
    {(error || hint) && <p id={`${id}-help`} className={error ? 'error visible' : 'microcopy'}>{error || hint}</p>}
  </div>
}
export function Alert({ message }: { message: string }) { return message ? <div className="form-alert visible" role="alert">{message}</div> : null }
export function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <button className="primary" type="submit" disabled={busy}>{busy ? 'Đang xử lý…' : children}{busy ? <span className="spinner" aria-hidden="true" /> : <Arrow />}</button>
}
