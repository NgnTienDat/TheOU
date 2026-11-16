import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from '../../shared/response.ts'

export async function updateNickname(client: SupabaseClient, userId: string, nickname: string) {
  // Filter ACTIVE trong chính UPDATE để không đổi profile vừa bị ban sau bước guard.
  const { data, error } = await client.from('profiles').update({ nickname })
    .eq('id', userId).eq('status', 'ACTIVE').select('nickname').maybeSingle()
  if (error) throw new ApiError('INTERNAL_ERROR')
  if (!data) throw new ApiError('FORBIDDEN')
  if (data.nickname !== nickname) throw new ApiError('INTERNAL_ERROR')
  return { nickname: data.nickname as string }
}
