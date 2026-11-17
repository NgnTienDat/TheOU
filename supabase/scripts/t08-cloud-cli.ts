import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ManualAuthError } from './auth-helpers.ts'
import { check } from './t06-cloud-inventory.ts'
import { t04ProjectRef, uuidPattern } from './t04-cloud-recovery.ts'
import {
  type CommentBaseline,
  type CommentInventory,
  commentResumeSnapshotSql,
  commentSnapshotSql,
  validateBaseline,
} from './t08-cloud-inventory.ts'

type Stage = 'RESOLVE' | 'VERSION' | 'PROJECTS' | 'SNAPSHOT'
type CliOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: true
  encoding: 'utf8'
  timeout: number
  maxBuffer: number
}
export type CliExecute = (
  file: string,
  args: string[],
  options: CliOptions,
) => Promise<{ stdout: string; stderr: string }>
const execute: CliExecute = promisify(execFile)
const version = '3.1.0'
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function fail(stage: Stage, code: string, exit?: number): never {
  throw new ManualAuthError(
    `FAIL: T08_CLI; stage=${stage}; code=${code}${
      exit === undefined ? '' : `; exit=${exit}`
    }. Không in stdout/stderr thô.`,
  )
}
async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export async function resolveT08Cli(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  const configured = env.THEOU_SUPABASE_CLI?.trim()
  if (configured) {
    // Không gọi npm .cmd shim qua shell, nhất là khi args chứa SQL nhiều dòng.
    if (/\.(cmd|bat)$/i.test(configured)) fail('RESOLVE', 'CMD_SHIM_UNSUPPORTED_USE_NATIVE_EXE')
    return configured
  }
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  for (const directory of path.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const native = join(directory.replace(/^"|"$/g, ''), platform === 'win32' ? 'supabase.exe' : 'supabase')
    if (await exists(native)) return native
  }
  if (platform === 'win32') {
    const cache = env.npm_config_cache || env.NPM_CONFIG_CACHE ||
      (env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'npm-cache'))
    if (cache) {
      const root = join(cache, '_npx')
      let directories: string[] = []
      try {
        directories = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) =>
          d.name
        ).sort()
      } catch { /* Cache chưa được tạo. */ }
      for (const directory of directories) {
        const packageName = `@supabase/cli-windows-${arch}`
        const packageRoot = join(root, directory, 'node_modules', packageName)
        try {
          const metadata: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
          const native = join(packageRoot, 'bin', 'supabase.exe')
          if (
            object(metadata) && metadata.name === packageName && metadata.version === version &&
            await exists(native)
          ) return native
        } catch { /* Không dùng package khác phiên bản hoặc cache chưa hoàn chỉnh. */ }
      }
    }
  }
  fail('RESOLVE', 'EXECUTABLE_NOT_FOUND')
}

const authCodes = ['DbQueryLoginRequiredError', 'UnauthorizedError', 'Unauthorized']
const permissionCodes = ['ForbiddenError', 'Forbidden', 'InsufficientPrivilegesError', '42501']
const sqlCodes = [
  'DbQueryError',
  'DbQueryExecutionError',
  'PostgresError',
  '42601',
  '42P01',
  '42703',
  '42883',
  '57014',
  '53300',
  '08006',
  'P0001',
]
function structuredError(stdout: unknown, stderr: unknown) {
  for (const text of [stdout, stderr]) {
    if (typeof text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (object(parsed) && object(parsed.error)) return parsed.error
    } catch { /* Không in hoặc phân loại dựa vào message tự do. */ }
  }
  return null
}
function processFailure(stage: Stage, error: unknown): never {
  const value = object(error) ? error : {}
  if (value.code === 'ENOENT') fail(stage, 'EXECUTABLE_NOT_FOUND')
  if (value.code === 'EACCES' || value.code === 'EPERM' || value.code === 'EINVAL') {
    fail(stage, 'SUBPROCESS_START_FAILED')
  }
  if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail(stage, 'OUTPUT_BUFFER_EXCEEDED')
  if (value.code === 'ETIMEDOUT' || value.killed === true && value.signal === 'SIGTERM') {
    fail(stage, 'TIMEOUT')
  }
  const detail = structuredError(value.stdout, value.stderr)
  const code = typeof detail?.code === 'string' ? detail.code : ''
  if (authCodes.includes(code) || detail?.status === 401) fail(stage, 'CLI_AUTHENTICATION_FAILED')
  if (permissionCodes.includes(code) || detail?.status === 403) fail(stage, 'CLI_PERMISSION_DENIED')
  if (stage === 'SNAPSHOT' && sqlCodes.includes(code)) fail(stage, 'SQL_QUERY_FAILED')
  if (
    typeof value.code === 'number' && Number.isSafeInteger(value.code) && value.code >= 0 && value.code <= 255
  ) fail(stage, 'CLI_EXIT_NONZERO', value.code)
  fail(stage, 'SUBPROCESS_FAILED')
}
function parseJson(stage: Stage, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    fail(stage, 'INVALID_JSON_OUTPUT')
  }
}

function snapshotShape(value: unknown): value is CommentBaseline {
  if (
    !object(value) || typeof value.readOnly !== 'string' ||
    !['users', 'profiles', 'roles'].every((k) => Number.isSafeInteger(value[k])) ||
    !['profileHash', 'roleHash'].every((k) =>
      typeof value[k] === 'string' && /^[a-f0-9]{32}$/.test(value[k] as string)
    ) ||
    !Array.isArray(value.profileOwners) || !Array.isArray(value.posts) || !Array.isArray(value.comments)
  ) return false
  const uuid = (x: unknown) => typeof x === 'string' && uuidPattern.test(x)
  const hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x)
  return value.profileOwners.every((p) => object(p) && hash(p.authorHash) && typeof p.status === 'string') &&
    value.posts.every((p) =>
      object(p) && uuid(p.id) && hash(p.authorHash) && hash(p.immutableHash) && hash(p.rowHash) &&
      typeof p.status === 'string' && Number.isSafeInteger(p.commentCount) &&
      Number.isSafeInteger(p.visibleCount)
    ) &&
    value.comments.every((c) =>
      object(c) && uuid(c.id) && uuid(c.postId) && typeof c.status === 'string' &&
      [c.authorHash, c.keyHash, c.bodyHash, c.rowHash].every(hash)
    )
}
export function parseT08Snapshot(result: unknown, requireFixtureScope = false) {
  const rows = Array.isArray(result) ? result : object(result) ? result.rows : null
  if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0]) || !snapshotShape(rows[0].snapshot)) {
    fail('SNAPSHOT', 'SNAPSHOT_SCHEMA_INVALID')
  }
  const value = rows[0].snapshot
  if (requireFixtureScope) {
    if (typeof rows[0].fixtureScopeMatches !== 'boolean') fail('SNAPSHOT', 'SNAPSHOT_SCHEMA_INVALID')
    check(rows[0].fixtureScopeMatches === true, 'DB_FIXTURE_EXACT_SCOPE')
  }
  // Giữ riêng lỗi count/state/baseline thực; không đổi thành lỗi CLI/JSON hoặc bỏ validation.
  validateBaseline(value)
  return value
}

export async function createT08Cli(env: NodeJS.ProcessEnv, request: CliExecute = execute) {
  const cli = await resolveT08Cli(env)
  const options: CliOptions = {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...env, DO_NOT_TRACK: '1', SUPABASE_NO_UPDATE_NOTIFIER: '1' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  }
  async function command(stage: Stage, args: string[]) {
    try {
      return (await request(cli, args, options)).stdout
    } catch (error) {
      processFailure(stage, error)
    }
  }
  const actual = (await command('VERSION', ['--version'])).trim()
  if (actual !== version) fail('VERSION', 'CLI_VERSION_MISMATCH')
  return {
    async projects() {
      const value = parseJson(
        'PROJECTS',
        await command('PROJECTS', ['projects', 'list', '--output-format', 'json']),
      )
      return Array.isArray(value) ? { projects: value } : value
    },
    async snapshot(record?: CommentInventory) {
      return parseT08Snapshot(
        parseJson(
          'SNAPSHOT',
          await command('SNAPSHOT', [
            'db',
            'query',
            `--remote=${t04ProjectRef}`,
            '--read-only',
            '--output-format',
            'json',
            record ? commentResumeSnapshotSql(record) : commentSnapshotSql,
          ]),
        ),
        !!record,
      )
    },
  }
}
