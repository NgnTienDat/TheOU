import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthenticatedUser } from '../../shared/authentication.ts'
import { ApiError } from '../../shared/response.ts'

export interface Profile {
  nickname: string
  status: 'ACTIVE' | 'BANNED'
}

export async function getOrCreateProfile(client: SupabaseClient, userId: string): Promise<Profile> {
  const read = () => client.from('profiles').select('nickname,status').eq('id', userId).maybeSingle()
  let result = await read()
  if (result.error) throw new ApiError('INTERNAL_ERROR')
  if (!result.data) {
    const suffix = 1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 9000
    // DO NOTHING giữ nguyên profile thắng race, kể cả nickname/status BANNED.
    const { error } = await client.from('profiles').upsert(
      { id: userId, nickname: `OUer-${suffix}` },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    if (error) throw new ApiError('INTERNAL_ERROR')
    result = await read()
  }
  const profile = result.data
  if (
    result.error || !profile || typeof profile.nickname !== 'string' ||
    !['ACTIVE', 'BANNED'].includes(profile.status)
  ) {
    throw new ApiError('INTERNAL_ERROR')
  }
  return { nickname: profile.nickname, status: profile.status }
}

export function getMe(user: AuthenticatedUser, profile: Profile, isAdmin: boolean) {
  // Che toàn bộ local part để không lộ MSSV, kể cả local part chỉ có một ký tự.
  return { nickname: profile.nickname, emailMasked: `***@${user.email.split('@')[1].toLowerCase()}`, isAdmin }
}
