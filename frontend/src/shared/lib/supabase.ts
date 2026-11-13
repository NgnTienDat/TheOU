import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readSupabaseEnv } from './env'

let client: SupabaseClient | undefined

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const { url, publishableKey } = readSupabaseEnv(import.meta.env)
    client = createClient(url, publishableKey)
  }
  return client
}
