import { createPublicFeedHandler } from './handler.ts'
import { createSupabaseClients, readAllowedOrigins } from '../social-api/shared/clients.ts'
import { failure } from '../social-api/shared/response.ts'

const readEnv = (name: string) => Deno.env.get(name)
const clients = createSupabaseClients(readEnv)
Deno.serve(async (request: Request) => {
  try {
    return await createPublicFeedHandler({
      createAdminClient: clients.createAdminClient,
      allowedOrigins: readAllowedOrigins(readEnv),
      readApprovedIds: () => readEnv('THEOU_PUBLIC_FEED_POST_IDS') ?? '',
      readCursorSecret: () => readEnv('THEOU_PUBLIC_FEED_CURSOR_SECRET') ?? '',
    })(request)
  } catch (error) {
    return failure(error, crypto.randomUUID(), new Headers({ 'cache-control': 'no-store' }))
  }
})
