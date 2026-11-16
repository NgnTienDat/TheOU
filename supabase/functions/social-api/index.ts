import { createSocialApiHandler } from './handler.ts'
import { createSupabaseClients, readAllowedOrigins } from './shared/clients.ts'
import { failure } from './shared/response.ts'

const readEnv = (name: string) => Deno.env.get(name)
const clients = createSupabaseClients(readEnv)

Deno.serve(async (request: Request) => {
  try {
    return await createSocialApiHandler({ ...clients, allowedOrigins: readAllowedOrigins(readEnv) })(request)
  } catch (error) {
    return failure(error, crypto.randomUUID(), new Headers({ 'cache-control': 'no-store' }))
  }
})
