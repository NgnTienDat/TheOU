import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { PublicImage } from '../../shared/api/SocialApiClient.ts'
import { useAuth } from '../auth/AuthProvider.tsx'
import { createImageRefresh } from './image-refresh.ts'
import { readPostImages } from './post-read.ts'

function ImageFrame({ image, revision, number, onFailure }: { image: PublicImage; revision: number; number: number; onFailure(image: PublicImage): void }) {
  const { id, signedUrl, expiresAt } = image
  const [display, setDisplay] = useState<{ url: string; width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [broken, setBroken] = useState(false)
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
        if (current) { setDisplay({ url: signedUrl, width: probe.naturalWidth, height: probe.naturalHeight }); setFailed(false); setBroken(false) }
      }
      probe.onerror = fail
      probe.src = signedUrl
    }
    load()
    const foreground = () => { if (!probe.src) load() }
    document.addEventListener('visibilitychange', foreground)
    return () => { current = false; probe.onload = null; probe.onerror = null; document.removeEventListener('visibilitychange', foreground) }
  }, [id, signedUrl, expiresAt, revision, onFailure])
  return <div className="post-image-frame" style={display ? { width: `min(${display.width}px, calc(var(--post-image-max-height) * ${display.width / display.height}))`, aspectRatio: `${display.width} / ${display.height}` } : undefined}>
    {display ? <><img src={display.url} width={display.width} height={display.height} alt={`Ảnh đính kèm ${number}`} decoding="async" style={broken ? { visibility: 'hidden' } : undefined}
      referrerPolicy="no-referrer" draggable={false} onError={() => { setBroken(true); setFailed(true); onFailure({ ...image, signedUrl: display.url }) }} />{broken && <p className="image-failure" role="status">Ảnh tạm thời chưa hiển thị.</p>}</>
      : failed ? <p role="status">Ảnh tạm thời chưa hiển thị.</p>
      : <span className="image-placeholder" role="status">Đang tải ảnh…</span>}
  </div>
}

export function PostImages({ postId, images, detailLink = false }: { postId: string; images: PublicImage[]; detailLink?: boolean }) {
  const { scope } = useAuth()
  return images.length ? <MediaGallery key={`${scope}:${postId}:${images.map(image => image.id).join()}`} postId={postId} images={images} detailLink={detailLink} /> : null
}

function MediaGallery({ postId, images, detailLink }: { postId: string; images: PublicImage[]; detailLink: boolean }) {
  const { api, controller, scope } = useAuth()
  const cache = useQueryClient()
  const [active, setActive] = useState(false)
  const gallery = useRef<HTMLDivElement>(null)
  const inViewport = useRef(false)
  const [fresh, setFresh] = useState<{ source: PublicImage[]; images: PublicImage[]; revision: number } | null>(null)
  const failedImage = useRef<PublicImage | null>(null)
  const source = useRef(images)
  const latest = useRef(images)
  const refresh = useRef<ReturnType<typeof createImageRefresh> | null>(null)
  const pointer = useRef<{ id: number; x: number; y: number; left: number; mouse: boolean; dragged: boolean } | null>(null)
  const dragged = useRef(false)
  const onFailure = useCallback((image: PublicImage) => { failedImage.current = image; void refresh.current?.refresh() }, [])
  useEffect(() => { source.current = images }, [images])
  useEffect(() => {
    const retry = createImageRefresh({
      load: () => readPostImages(cache, api, scope, postId),
      isCurrent: () => controller.getScope() === scope,
      isVisible: () => document.visibilityState !== 'hidden' && inViewport.current,
      isNeeded: () => latest.current.some(image => Date.parse(image.expiresAt) <= Date.now() ||
        (image.id === failedImage.current?.id && image.signedUrl === failedImage.current.signedUrl)),
      generation: () => source.current,
      accept: next => { failedImage.current = null; setFresh(previous => ({ source: source.current, images: next, revision: (previous?.revision ?? 0) + 1 })) },
      reject: error => controller.reject(error),
    })
    refresh.current = retry
    return () => { refresh.current = null; retry.dispose() }
  }, [api, controller, scope, postId, cache])
  useEffect(() => {
    const element = gallery.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => {
      inViewport.current = entry.isIntersecting
      if (entry.isIntersecting) { setActive(true); void refresh.current?.refresh() }
    }, { rootMargin: '200px 0px' })
    observer.observe(element)
    return () => { observer.disconnect(); inViewport.current = false }
  }, [])
  const shown = fresh?.source === images ? fresh.images : images
  useEffect(() => { latest.current = shown }, [shown])
  useEffect(() => {
    if (!active || !shown.length) return
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
  }, [shown, fresh?.revision, active])
  if (!shown.length) return null
  const multiple = shown.length > 1
  return <div ref={gallery} className="post-images" role={multiple ? 'region' : 'group'} aria-label="Ảnh đính kèm bài viết">
    <div className="post-gallery-track" role={multiple ? 'group' : undefined} tabIndex={multiple ? 0 : undefined} aria-label={multiple ? 'Cuộn ảnh bằng phím mũi tên trái, phải, Home hoặc End' : undefined} data-multiple={multiple}
    onKeyDown={event => {
      dragged.current = false
      if (!multiple || event.altKey || event.ctrlKey || event.metaKey) return
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const track = event.currentTarget
        const left = event.key === 'Home' ? 0 : event.key === 'End' ? track.scrollWidth : track.scrollLeft + track.clientWidth * .85 * (event.key === 'ArrowRight' ? 1 : -1)
        track.scrollTo({ left, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
        event.currentTarget.focus()
      }
    }}
    onClickCapture={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false } }}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return
        dragged.current = false
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, mouse: event.pointerType === 'mouse', dragged: false }
      }}
      onPointerMove={event => {
        const start = pointer.current
        if (!start || start.id !== event.pointerId) return
        const dx = event.clientX - start.x, dy = event.clientY - start.y
        if (!start.dragged && Math.hypot(dx, dy) > 6) {
          start.dragged = true; dragged.current = true
          if (start.mouse) { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true' }
        }
        if (start.mouse && start.dragged) { event.preventDefault(); event.currentTarget.scrollLeft = start.left - dx }
      }}
      onPointerUp={event => {
        pointer.current = null
        delete event.currentTarget.dataset.dragging
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={event => { pointer.current = null; dragged.current = true; delete event.currentTarget.dataset.dragging }}
      onLostPointerCapture={event => { pointer.current = null; delete event.currentTarget.dataset.dragging }}
      onPointerLeave={() => { if (pointer.current?.mouse && !pointer.current.dragged) pointer.current = null }}>
      {active ? shown.map((image, index) => {
        const frame = <ImageFrame image={image} revision={fresh?.revision ?? 0} number={index + 1} onFailure={onFailure} />
        return detailLink ? <Link key={image.id} className="post-gallery-item post-image-link" to={`/bai-viet/${postId}`} aria-label={`Mở ảnh ${index + 1} và chi tiết bài viết`} draggable={false}>{frame}</Link> : <div key={image.id} className="post-gallery-item">{frame}</div>
      }) : <span className="image-placeholder" role="status">Ảnh đính kèm sẽ tải khi bạn cuộn đến.</span>}
    </div>
  </div>
}
