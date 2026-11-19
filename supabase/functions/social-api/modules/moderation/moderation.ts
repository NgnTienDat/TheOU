import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'
import { uuidPattern } from '../posts/post-validation.ts'

export interface HideInput {
  targetType: 'POST' | 'COMMENT'
  targetId: string
  reason: string
}
export function validateHide(payload: Record<string, unknown>): HideInput {
  if (
    Object.keys(payload).sort().join() !== 'reason,targetId,targetType' ||
    typeof payload.targetType !== 'string' || !['POST', 'COMMENT'].includes(payload.targetType) ||
    typeof payload.targetId !== 'string' ||
    !uuidPattern.test(payload.targetId) || typeof payload.reason !== 'string' ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(payload.reason)
  ) throw new ApiError('VALIDATION_ERROR')
  const reason = payload.reason.trim()
  if (!reason || [...reason].length > 500) throw new ApiError('VALIDATION_ERROR')
  return {
    targetType: payload.targetType as HideInput['targetType'],
    targetId: payload.targetId.toLowerCase(),
    reason,
  }
}
export async function adminHideContent(
  client: SupabaseClient,
  userId: string,
  isAdmin: boolean,
  input: HideInput,
  signal: AbortSignal,
) {
  if (!isAdmin) throw new ApiError('FORBIDDEN')
  const { error } = await client.rpc('t11_admin_hide_content', {
    p_admin_id: userId,
    p_target_type: input.targetType,
    p_target_id: input.targetId,
    p_reason: input.reason,
  }).abortSignal(signal)
  if (error) {
    throw new ApiError(
      error.code === '42501'
        ? 'FORBIDDEN'
        : error.code === 'P0002'
        ? 'NOT_FOUND'
        : error.code === '23514'
        ? 'CONFLICT'
        : error.code === '22023'
        ? 'VALIDATION_ERROR'
        : 'INTERNAL_ERROR',
    )
  }
  return { success: true as const }
}
