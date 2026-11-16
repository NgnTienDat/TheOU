import { ApiError } from './response.ts'

export async function validateRequest(request: Request): Promise<void> {
  if (
    request.method !== 'POST' ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new ApiError('VALIDATION_ERROR')
  }
  // Giới hạn cả stream để không tin Content-Length do client khai báo.
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('VALIDATION_ERROR')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        await reader.cancel()
        throw new ApiError('VALIDATION_ERROR')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let body: unknown
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ApiError('VALIDATION_ERROR')
  }
  if (
    !isObject(body) || Object.keys(body).length !== 2 || body.action !== 'getMe' ||
    !isObject(body.payload) || Object.keys(body.payload).length !== 0
  ) {
    throw new ApiError('VALIDATION_ERROR')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
