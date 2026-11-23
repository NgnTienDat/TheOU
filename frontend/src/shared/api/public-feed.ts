import type { ListPostsInput, Page, PostPublic } from './SocialApiClient.ts'
import { parseSocialResponse, SocialApiError } from './social-api.ts'

export function createPublicFeed(url: string, publishableKey: string, fetchRequest: typeof fetch = fetch) {
  return {
    async listPosts(input: ListPostsInput): Promise<Page<PostPublic>> {
      try {
        const response = await fetchRequest(`${url.replace(/\/$/, '')}/functions/v1/public-feed`, {
          method: 'POST', credentials: 'omit', headers: { apikey: publishableKey, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'listPosts', payload: input }), signal: AbortSignal.timeout(15_000),
        })
        const page = parseSocialResponse(await response.json(), response.status, 'listPosts') as Page<PostPublic>
        if (page.items.some((p) => p.isMine || p.hasUpvoted || p.images.length || p.contactUrl !== null ||
          p.displayMode !== 'ANONYMOUS' || p.authorLabel !== 'OUer ẩn danh')) throw new SocialApiError('INTERNAL_ERROR')
        return page
      } catch (error) {
        throw error instanceof SocialApiError ? error : new SocialApiError('INTERNAL_ERROR')
      }
    },
  }
}
