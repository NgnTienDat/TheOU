import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ManualAuthError } from './auth-helpers.ts'
import { type CliExecute, resolveT08Cli } from './t08-cloud-cli.ts'
import { confirmT08Project } from './t08-cloud-runner.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'
import { check } from './t06-cloud-inventory.ts'
import { object } from './t09-cloud-inventory.ts'
import { mediaSnapshotSql, parseMediaSnapshot } from './t10-cloud-inventory.ts'

export async function createT10Cli(env: NodeJS.ProcessEnv, execute: CliExecute = promisify(execFile)) {
  const executable = await resolveT08Cli(env)
  async function command(stage: 'VERSION' | 'PROJECTS' | 'SNAPSHOT', args: string[]) {
    let stdout: string
    try {
      stdout = (await execute(executable, args, {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...env, DO_NOT_TRACK: '1', SUPABASE_NO_UPDATE_NOTIFIER: '1' },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      })).stdout
    } catch (error) {
      const e = object(error) ? error : {}
      let code = e.code === 'ENOENT'
        ? 'EXECUTABLE_NOT_FOUND'
        : ['EPERM', 'EACCES', 'EINVAL'].includes(String(e.code))
        ? 'SUBPROCESS_START_FAILED'
        : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'OUTPUT_BUFFER_EXCEEDED'
        : e.code === 'ETIMEDOUT' || e.killed === true
        ? 'TIMEOUT'
        : 'CLI_EXIT_OR_QUERY_FAILED'
      for (const value of [e.stdout, e.stderr]) {
        if (typeof value !== 'string') continue
        try {
          const body: unknown = JSON.parse(value)
          if (!object(body) || !object(body.error)) continue
          const detail = body.error
          if (
            detail.status === 401 ||
            ['DbQueryLoginRequiredError', 'UnauthorizedError'].includes(String(detail.code))
          ) code = 'AUTHENTICATION_FAILED'
          else if (detail.status === 403 || ['ForbiddenError', '42501'].includes(String(detail.code))) {
            code = 'PERMISSION_DENIED'
          } else if (
            ['42601', '42P01', '42703', '42883', '57014', 'PostgresError', 'DbQueryError'].includes(
              String(detail.code),
            )
          ) code = 'SQL_QUERY_FAILED'
        } catch { /* Không in hoặc phân loại theo raw message. */ }
      }
      throw new ManualAuthError(`FAIL: T10_CLI; stage=${stage}; code=${code}. Không in stdout/stderr.`)
    }
    if (stage === 'VERSION') return stdout.trim()
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new ManualAuthError(`FAIL: T10_CLI; stage=${stage}; code=INVALID_JSON.`)
    }
  }
  check(await command('VERSION', ['--version']) === '3.1.0', 'T10_CLI_VERSION')
  return {
    async project() {
      const value = await command('PROJECTS', ['projects', 'list', '--output-format', 'json'])
      confirmT08Project(Array.isArray(value) ? { projects: value } : value)
    },
    async snapshot() {
      const value = await command('SNAPSHOT', [
        'db',
        'query',
        `--remote=${t04ProjectRef}`,
        '--read-only',
        '--output-format',
        'json',
        mediaSnapshotSql,
      ])
      const rows = Array.isArray(value) ? value : object(value) ? value.rows : null
      check(Array.isArray(rows) && rows.length === 1 && object(rows[0]), 'T10_CLI_SNAPSHOT_SHAPE')
      return parseMediaSnapshot(rows[0].snapshot)
    },
  }
}
