import { useMutationState, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthProvider.tsx'
import { SocialApiError } from '../../shared/api/social-api.ts'
import type { PostPublic } from '../../shared/api/SocialApiClient.ts'
import { runUpvote, upvoteKey, type UpvoteInput } from './vote-mutation.ts'

export function useToggleUpvote(post: PostPublic) {
  const cache = useQueryClient()
  const { api, scope, controller } = useAuth()
  const latest = useMutationState({ filters: { mutationKey: upvoteKey(scope, post.id), exact: true }, select: mutation => ({
    status: mutation.state.status, input: mutation.state.variables as UpvoteInput | undefined,
    error: mutation.state.error instanceof SocialApiError ? mutation.state.error.message : '',
  }) }).at(-1)
  const submit = (desiredState: boolean) => runUpvote(cache, api, scope, { postId: post.id, desiredState },
    () => controller.getScope() === scope, controller.reject)
  return {
    hasUpvoted: latest?.status === 'pending' && latest.input ? latest.input.desiredState : post.hasUpvoted,
    upvoteCount: latest?.status === 'pending' && latest.input
      ? Math.max(0, post.upvoteCount + Number(latest.input.desiredState) - Number(post.hasUpvoted)) : post.upvoteCount,
    pending: latest?.status === 'pending', error: latest?.error ?? '',
    toggle: () => submit(!post.hasUpvoted),
    retry: () => { if (latest?.input) return submit(latest.input.desiredState) },
  }
}
