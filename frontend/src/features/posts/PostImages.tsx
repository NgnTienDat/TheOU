import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { PublicImage } from '../../shared/api/SocialApiClient.ts'
import { Icon } from '../../shared/components/Icon.tsx'
import { useAuth } from '../auth/AuthProvider.tsx'
import { createImageRefresh } from './image-refresh.ts'
import { readPostImages } from './post-read.ts'

function ImageFrame({ image, revision, number, onFailure }: { image: PublicImage; revision: number; number: number; onFailure(image: PublicImage): void }) {
  const { id, signedUrl, expiresAt } = image
  const [display, setDisplay] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    const probe = new Image()
    probe.referrerPolicy = 'no-referrer'
    const fail = () => { if (current) { setFailed(true); onFailure({ id, signedUrl, expiresAt }) } }
    const load = () => {
      if (document.visibilityState === 'hidden') return
      if (Date.parse(expiresAt) <= Date.now()) { fail(); return }
      probe.onload = async () => {
        try { await probe.decode() } catch { fail(); return }
        if (current) { setDisplay(signedUrl); setFailed(false) }
      }
      probe.onerror = fail
      probe.src = signedUrl
    }
    load()
    const foreground = () => { if (!probe.src) load() }
    document.addEventListener('visibilitychange', foreground)
    return () => { current = false; probe.onload = null; probe.onerror = null; document.removeEventListener('visibilitychange', foreground) }
  }, [id, signedUrl, expiresAt, revision, onFailure])
  return <div className="post-image-frame">
    {display ? <img src={display} alt={`Ảnh đính kèm ${number}`} decoding="async"
      referrerPolicy="no-referrer" draggable={false} onError={() => { setDisplay(null); setFailed(true); onFailure(image) }} />
      : failed ? <p role="status">Ảnh tạm thời chưa hiển thị.</p>
      : <span className="image-placeholder" role="status">Đang tải ảnh…</span>}
  </div>
}

export function PostImages({ postId, images, detailLink = false }: { postId: string; images: PublicImage[]; detailLink?: boolean }) {
  const { scope } = useAuth()
  return images.length ? <MediaCarousel key={`${scope}:${postId}:${images.map(image => image.id).join()}`} postId={postId} images={images} detailLink={detailLink} /> : null
}

function MediaCarousel({ postId, images, detailLink }: { postId: string; images: PublicImage[]; detailLink: boolean }) {
  const { api, controller, scope } = useAuth()
  const cache = useQueryClient()
  const [index, setIndex] = useState(0)
  const [fresh, setFresh] = useState<{ source: PublicImage[]; images: PublicImage[]; revision: number } | null>(null)
  const failedImage = useRef<PublicImage | null>(null)
  const source = useRef(images)
  const latest = useRef(images)
  const refresh = useRef<ReturnType<typeof createImageRefresh> | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const onFailure = useCallback((image: PublicImage) => { failedImage.current = image; void refresh.current?.refresh() }, [])
  useEffect(() => { source.current = images }, [images])
  useEffect(() => {
    const retry = createImageRefresh({
      load: () => readPostImages(cache, api, scope, postId),
      isCurrent: () => controller.getScope() === scope,
      isVisible: () => document.visibilityState !== 'hidden',
      isNeeded: () => latest.current.some(image => Date.parse(image.expiresAt) <= Date.now() ||
        (image.id === failedImage.current?.id && image.signedUrl === failedImage.current.signedUrl)),
      generation: () => source.current,
      accept: next => { failedImage.current = null; setFresh(previous => ({ source: source.current, images: next, revision: (previous?.revision ?? 0) + 1 })) },
      reject: error => controller.reject(error),
    })
    refresh.current = retry
    return () => { refresh.current = null; retry.dispose() }
  }, [api, controller, scope, postId, cache])
  const shown = fresh?.source === images ? fresh.images : images
  useEffect(() => { latest.current = shown }, [shown])
  useEffect(() => {
    const expires = Math.min(...shown.map(image => Date.parse(image.expiresAt)))
    const check = () => {
      if (document.visibilityState !== 'hidden' && (expires <= Date.now() ||
        shown.some(image => image.id === failedImage.current?.id && image.signedUrl === failedImage.current.signedUrl))) void refresh.current?.refresh()
    }
    const timer = setTimeout(check, Math.max(0, Math.min(2147483647, expires - Date.now())))
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    check()
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [shown, fresh?.revision])
  if (!shown.length) return null
  const selected = Math.min(index, shown.length - 1), multiple = shown.length > 1
  const move = (next: number) => setIndex(Math.max(0, Math.min(shown.length - 1, next)))
  const frame = <ImageFrame key={shown[selected].id} image={shown[selected]} revision={fresh?.revision ?? 0} number={selected + 1} onFailure={onFailure} />
  return <div className="post-images" role={multiple ? 'region' : 'group'} aria-label="Ảnh đính kèm bài viết"
    aria-roledescription={multiple ? 'băng chuyền ảnh' : undefined} tabIndex={multiple ? 0 : undefined}
    onKeyDown={event => {
      if (!multiple || event.altKey || event.ctrlKey || event.metaKey) return
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); swiped.current = false
        move(event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : selected + (event.key === 'ArrowRight' ? 1 : -1))
        event.currentTarget.focus()
      }
    }}
    onClickCapture={event => { if (swiped.current) { event.preventDefault(); event.stopPropagation(); swiped.current = false } }}>
    <div className="post-carousel-viewport"
      onPointerDown={event => {
        swiped.current = false
        pointer.current = event.isPrimary && event.pointerType !== 'mouse' && !(event.target as Element).closest('button') ? { x: event.clientX, y: event.clientY } : null
      }}
      onPointerCancel={() => { pointer.current = null }}
      onPointerUp={event => {
        const start = pointer.current
        pointer.current = null
        if (!start || !multiple) return
        const dx = event.clientX - start.x, dy = event.clientY - start.y
        if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.25) {
          swiped.current = true
          move(selected + (dx < 0 ? 1 : -1))
        }
      }}>
      {detailLink ? <Link className="post-image-link" to={`/bai-viet/${postId}`} aria-label={`Mở ảnh ${selected + 1} và chi tiết bài viết`} draggable={false}>{frame}</Link> : frame}
      {multiple && <>
        <span className="carousel-counter" aria-hidden="true">{selected + 1}/{shown.length}</span>
        <button type="button" className="carousel-control carousel-previous" aria-label="Ảnh trước" disabled={selected === 0}
          onClick={event => { event.stopPropagation(); move(selected - 1) }}><Icon name="chevron" /></button>
        <button type="button" className="carousel-control carousel-next" aria-label="Ảnh tiếp theo" disabled={selected === shown.length - 1}
          onClick={event => { event.stopPropagation(); move(selected + 1) }}><Icon name="chevron" /></button>
      </>}
    </div>
    {multiple && <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">Ảnh {selected + 1} trên {shown.length}</span>}
  </div>
}
