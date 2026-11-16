import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../modules/profile/get-me.ts'
import { ApiError } from './response.ts'

export async function authorizeAccount(
  client: SupabaseClient,
  userId: string,
  profile: Profile,
): Promise<boolean> {
  if (profile.status !== 'ACTIVE') throw new ApiError('FORBIDDEN')
  const { data, error } = await client.from('user_roles').select('role')
    .eq('user_id', userId).eq('role', 'ADMIN').maybeSingle()
  if (error) throw new ApiError('INTERNAL_ERROR')
  return data?.role === 'ADMIN'
}
