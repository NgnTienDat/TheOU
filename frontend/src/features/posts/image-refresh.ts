import type { PostPublic, PublicImage } from '../../shared/api/SocialApiClient.ts'

// Một ngân sách cho cả gallery; URL mới hoặc đổi slide không mở lại ngân sách.
export function createImageRefresh(options: {
  load(): Promise<PostPublic>
  isCurrent(): boolean
  isVisible?: () => boolean
  isNeeded?: () => boolean
  generation?: () => unknown
  accept(images: PublicImage[]): void
  reject(error: unknown): void
  wait?: () => Promise<void>
}) {
  let attempts = 0, disposed = false, pending: Promise<void> | null = null
  const current = () => !disposed && options.isCurrent()
  const visible = () => options.isVisible?.() ?? true
  const needed = () => options.isNeeded?.() ?? true
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 300)))
  return {
    refresh(): Promise<void> {
      if (pending) return pending
      if (!current() || !visible() || !needed() || attempts >= 3) return Promise.resolve()
      pending = (async () => {
        while (current() && visible() && needed() && attempts < 3) {
          await wait()
          if (!current() || !visible() || !needed()) return
          attempts++
          const generation = options.generation?.()
          try {
            const post = await options.load()
            if (current() && generation === options.generation?.()) options.accept(post.images)
            return
          } catch (error) {
            if (!current()) return
            options.reject(error)
          }
        }
      })().finally(() => { pending = null })
      return pending
    },
    dispose() { disposed = true },
  }
}
