import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import { resolveT08Cli } from './t08-cloud-cli.ts'
import { type ModerationSnapshot } from './t11-cloud-inventory.ts'
import { canonical } from './t11-cloud-recovery.ts'
import { createT12Cli, runT12Preflight } from './t12-cloud-runner.ts'
import {
  assertNoT12Incidents,
  readT12Evidence,
  t12ReadOnlyIncident,
  t12ReadStore,
  withT12ProjectLock,
} from './t12-evidence.ts'
import {
  parseT12Proof,
  readT12Compatibility,
  readT12Config,
  sha256,
  t12SnapshotSql,
} from './t12-preflight.ts'
import { t04ProjectRef } from './t04-cloud-recovery.ts'

export const t12RecoverySqlHash = '34c5fe098983066591c7b62f9c2424cd8078b0eba7e1c9e70a4efdf408670b65'
export const t12RecoveryCliHash = 'f6adec9cab13b017eea61f75e1c54769eb520e0760453fd8a722877a8c0b30ff'
const historicalSqlHash = 'bc4378522e14a64b7592914b9e99c8043f5b88b15b21ee6bfa3ff03cb9928c52'
const provenance =
  'VALIDATION_FAILURE_INFERRED_FROM_SOURCE_AND_OWNER_DIAGNOSTICS_CF01_MISMATCH; ORIGINAL_HTTP_TRACE_AND_FULL_PROOF_NOT_PERSISTED'
export type RecoveryMode = 'evidence' | 'resolve' | 'followup'
const flags = ['EVIDENCE', 'RESOLVE', 'FOLLOWUP'] as const
const digest = (v: unknown) => sha256(canonical(v))
const directoryName = `t12-recovery/${t12ReadOnlyIncident.runId}/`
const evidenceFiles = ['attempt.json', 'project-ack.json', 'sql-intent.json', 'sql-ack.json', 'evidence.json']

export function readT12RecoveryApproval(mode: RecoveryMode, env: NodeJS.ProcessEnv, linked: string) {
  readT12Config(env, linked, ['--preflight'])
  for (const name of flags) {
    check(
      (env[`THEOU_ALLOW_T12_RECOVERY_${name}`] ?? '') === (name.toLowerCase() === mode ? 'theou-dev' : ''),
      'T12_RECOVERY_SEPARATE_APPROVAL_REQUIRED',
    )
  }
  const reference = env.THEOU_T12_RECOVERY_APPROVAL_REF ?? ''
  check(
    env.THEOU_T12_RECOVERY_OWNER_REVIEW === 'approved' &&
      new RegExp(`^T12-R4-${mode.toUpperCase()}-[A-Z0-9-]{1,48}$`).test(reference),
    'T12_RECOVERY_OWNER_REVIEW_REQUIRED',
  )
  check(/^[a-f0-9]{64}$/.test(env.THEOU_T12_RECOVERY_SOURCE_SHA256 ?? ''), 'T12_RECOVERY_SOURCE_APPROVAL')
  return reference
}

// Pin tất cả scripts để các helpers gián tiếp vẫn nằm trong phạm vi review.
export async function readT12RecoverySources() {
  const directory = new URL('./', import.meta.url), hashes: Record<string, string> = {}
  for (const name of (await readdir(directory)).filter((n) => n.endsWith('.ts')).sort()) {
    hashes[name] = sha256(await readFile(new URL(name, directory)))
  }
  hashes['../package.json'] = sha256(await readFile(new URL('../package.json', directory)))
  check(
    sha256(await readFile(new URL('../.temp/t12-e2e-review/preflight-cli-r1.sql', import.meta.url))) ===
      historicalSqlHash,
    'T12_RECOVERY_HISTORICAL_SQL_DRIFT',
  )
  const sql = `${t12SnapshotSql(await readT12Compatibility())};\n`
  check(sha256(sql) === t12RecoverySqlHash, 'T12_RECOVERY_SQL_SOURCE_DRIFT')
  const artifact = await readFile(new URL('../.temp/t12-e2e-review/preflight-cli-r3-v2.sql', import.meta.url))
  check(
    sha256(artifact) === t12RecoverySqlHash && artifact.toString('utf8') === sql,
    'T12_RECOVERY_SQL_ARTIFACT_DRIFT',
  )
  return { sourceHash: digest(hashes), sql }
}

export async function verifyT12ReadOnlyIncident(root: URL) {
  const bytes = await readFile(new URL(t12ReadOnlyIncident.path, root))
  check(sha256(bytes) === t12ReadOnlyIncident.hash, 'T12_RECOVERY_INCIDENT_DRIFT')
  const journal = JSON.parse(bytes.toString('utf8'))
  const projectProof = digest({ projectVerified: true })
  check(
    canonical(journal) === canonical({
      version: 1,
      projectRef: t04ProjectRef,
      status: 'UNCERTAIN',
      uncertain: true,
      baseline: null,
      events: [
        { stage: 'PROJECT', phase: 'INTENT', proof: sha256('PROJECT') },
        { stage: 'PROJECT', phase: 'ACK', proof: projectProof },
        { stage: 'PROJECT', phase: 'VERIFIED', proof: projectProof },
        { stage: 'BEFORE', phase: 'INTENT', proof: sha256('BEFORE') },
      ],
    }),
    'T12_RECOVERY_INCIDENT_SEQUENCE',
  )
}

// wx + fsync + readback: mất điện/I/O có thể để lại file chưa hoàn chỉnh; không tự xóa hoặc retry.
export async function createT12RecoveryFile(file: URL, data: unknown) {
  const body = JSON.stringify({ data, checksum: digest(data) }) + '\n'
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  check(await readFile(file, 'utf8') === body, 'T12_RECOVERY_DURABILITY_READBACK')
}

async function readEnvelope(file: URL) {
  const bytes = await readFile(file), value = JSON.parse(bytes.toString('utf8'))
  check(
    canonical(Object.keys(value).sort()) === canonical(['checksum', 'data']) &&
      value.checksum === digest(value.data),
    'T12_RECOVERY_RECEIPT_CHECKSUM',
  )
  return { data: value.data, hash: sha256(bytes) }
}

function exactKeys(value: object, names: string[]) {
  check(canonical(Object.keys(value).sort()) === canonical(names.sort()), 'T12_RECOVERY_ARTIFACT_SCHEMA')
}

interface RecoveryDependencies {
  root: URL
  sources(): Promise<{ sourceHash: string; sql: string }>
  expected(): Promise<ModerationSnapshot>
  cli(sql: string): Promise<{ project(): Promise<void>; snapshot(): Promise<unknown> }>
  now(): number
  write(file: URL, data: unknown): Promise<void>
}

export function t12RecoveryDependencies(env: NodeJS.ProcessEnv): RecoveryDependencies {
  return {
    root: new URL('../.temp/', import.meta.url),
    sources: readT12RecoverySources,
    expected: readT12Evidence,
    now: Date.now,
    write: createT12RecoveryFile,
    async cli(sql) {
      const executable = await resolveT08Cli(env)
      check(sha256(await readFile(executable)) === t12RecoveryCliHash, 'T12_RECOVERY_NATIVE_CLI_DRIFT')
      return await createT12Cli({ ...env, THEOU_SUPABASE_CLI: executable }, sql)
    },
  }
}

export async function runT12Recovery(
  mode: RecoveryMode,
  env: NodeJS.ProcessEnv,
  linked: string,
  deps: RecoveryDependencies,
) {
  const approvalRef = readT12RecoveryApproval(mode, env, linked)
  return await withT12ProjectLock(async () => {
    const sources = await deps.sources(), expected = await deps.expected()
    check(sources.sourceHash === env.THEOU_T12_RECOVERY_SOURCE_SHA256, 'T12_RECOVERY_REVIEWED_SOURCE_DRIFT')
    check(sha256(sources.sql) === t12RecoverySqlHash, 'T12_RECOVERY_SQL_SOURCE_DRIFT')
    check(
      expected.business.counts.roles === 0 && expected.business.counts.moderation === 2,
      'T12_RECOVERY_RETAINED_STATE',
    )
    const plan = {
      version: 1,
      projectRef: t04ProjectRef,
      incidentId: t12ReadOnlyIncident.runId,
      incidentHash: t12ReadOnlyIncident.hash,
      sourceHash: sources.sourceHash,
      sqlHash: t12RecoverySqlHash,
      historicalReviewedSqlHash: historicalSqlHash,
      nativeCliHash: t12RecoveryCliHash,
      expectedHash: digest(expected),
    }
    const directory = new URL(directoryName, deps.root), pins = new Map<string, string>()
    const followup = { runId: undefined as string | undefined }
    const timestamp = () => new Date(deps.now()).toISOString()
    const fresh = (at: unknown) => {
      const time = typeof at === 'string' ? Date.parse(at) : NaN
      check(
        Number.isFinite(time) && deps.now() >= time && deps.now() - time <= 30 * 60_000,
        'T12_RECOVERY_EVIDENCE_EXPIRED',
      )
    }
    const load = async (name: string) => {
      const entry = await readEnvelope(new URL(name, directory))
      pins.set(name, entry.hash)
      return entry
    }
    const write = async (name: string, data: unknown) => {
      await deps.write(new URL(name, directory), data)
      const entry = await load(name)
      check(canonical(entry.data) === canonical(data), 'T12_RECOVERY_WRITE_DRIFT')
      return entry.hash
    }
    const verifyIncident = async () => {
      readT12RecoveryApproval(mode, env, linked)
      await verifyT12ReadOnlyIncident(deps.root)
    }
    const review = async () => {
      await verifyIncident()
      check((await deps.sources()).sourceHash === plan.sourceHash, 'T12_RECOVERY_REVIEWED_SOURCE_DRIFT')
      check(digest(await deps.expected()) === plan.expectedHash, 'T12_RECOVERY_RETAINED_DRIFT')
      const runs = await readdir(new URL('t12-e2e/', deps.root), { withFileTypes: true })
      check(
        runs.every((r) =>
          r.isDirectory() && !r.isSymbolicLink() &&
          [t12ReadOnlyIncident.runId, followup.runId].includes(r.name)
        ),
        'T12_RECOVERY_EXTRA_INCIDENT',
      )
      const originalFiles = await readdir(new URL(`t12-e2e/${t12ReadOnlyIncident.runId}/`, deps.root))
      check(
        canonical(originalFiles.sort()) === canonical(['preflight.journal.json']),
        'T12_RECOVERY_EXTRA_INCIDENT_FILE',
      )
      if (pins.size) {
        const names = await readdir(directory)
        check(
          canonical(names.sort()) === canonical([...pins.keys()].sort()),
          'T12_RECOVERY_EXTRA_OR_MISSING_FILE',
        )
        for (const [name, hash] of pins) {
          check(sha256(await readFile(new URL(name, directory))) === hash, 'T12_RECOVERY_ARTIFACT_DRIFT')
        }
      }
      await assertNoT12Incidents(
        deps.root,
        true,
        followup.runId ? `t12-e2e/${followup.runId}/preflight.journal.json` : undefined,
        verifyIncident,
      )
    }
    await verifyIncident()
    if (mode !== 'evidence') {
      const names = await readdir(directory)
      check(
        canonical(names.sort()) === canonical([
          ...evidenceFiles,
          ...(mode === 'followup' ? ['resolution-intent.json', 'resolution.json'] : []),
        ].sort()),
        'T12_RECOVERY_INCOMPLETE_OR_CONSUMED',
      )
      for (const name of names) await load(name)
    }
    await review()
    if (mode === 'evidence') {
      await mkdir(new URL('t12-recovery/', deps.root), { recursive: true })
      // Một lần thử: thư mục rỗng còn lại sau crash cũng chặn execution tiếp theo.
      await mkdir(directory)
      const attemptHash = await write('attempt.json', { plan, approvalRef, at: timestamp() })
      const cli = await deps.cli(sources.sql)
      await review()
      await cli.project()
      await write('project-ack.json', { attemptHash, projectVerified: true })
      await write('sql-intent.json', { attemptHash, sqlHash: plan.sqlHash })
      await review()
      const proof = await cli.snapshot()
      await write('sql-ack.json', { attemptHash, proofHash: digest(proof) })
      const snapshot = parseT12Proof(proof, expected)
      check(snapshot.business.counts.moderation === 2, 'T12_RECOVERY_AUDIT_COUNT')
      await review()
      const hash = await write('evidence.json', {
        plan,
        approvalRef,
        at: timestamp(),
        proofHash: digest(proof),
        snapshotHash: digest(snapshot),
        readOnly: true,
        roleCount: 0,
        auditCount: 2,
      })
      await review()
      return { stage: 'FRESH_READ_ONLY_EVIDENCE_READY', artifactHash: hash }
    }
    const attempt = await load('attempt.json'), evidence = await load('evidence.json')
    exactKeys(attempt.data, ['plan', 'approvalRef', 'at'])
    exactKeys(evidence.data, [
      'plan',
      'approvalRef',
      'at',
      'proofHash',
      'snapshotHash',
      'readOnly',
      'roleCount',
      'auditCount',
    ])
    check(
      canonical(attempt.data.plan) === canonical(plan) && canonical(evidence.data.plan) === canonical(plan),
      'T12_RECOVERY_PLAN_DRIFT',
    )
    check(
      /^T12-R4-EVIDENCE-[A-Z0-9-]{1,48}$/.test(attempt.data.approvalRef) &&
        evidence.data.approvalRef === attempt.data.approvalRef,
      'T12_RECOVERY_EVIDENCE_APPROVAL',
    )
    fresh(attempt.data.at)
    fresh(evidence.data.at)
    check(
      evidence.data.readOnly === true && evidence.data.roleCount === 0 && evidence.data.auditCount === 2 &&
        evidence.data.snapshotHash === plan.expectedHash && evidence.data.proofHash === digest({
            snapshot: expected,
            compatibility: true,
            existingAuthEligible: true,
          }),
      'T12_RECOVERY_FULL_EVIDENCE_REQUIRED',
    )
    for (
      const [name, data] of [
        ['project-ack.json', { attemptHash: attempt.hash, projectVerified: true }],
        ['sql-intent.json', { attemptHash: attempt.hash, sqlHash: plan.sqlHash }],
        ['sql-ack.json', { attemptHash: attempt.hash, proofHash: evidence.data.proofHash }],
      ] as const
    ) check(canonical((await load(name)).data) === canonical(data), 'T12_RECOVERY_EVIDENCE_CHAIN')
    if (mode === 'resolve') {
      check(env.THEOU_T12_RECOVERY_EVIDENCE_SHA256 === evidence.hash, 'T12_RECOVERY_EVIDENCE_HASH_APPROVAL')
      const resolutionIntentHash = await write('resolution-intent.json', {
        plan,
        evidenceHash: evidence.hash,
        approvalRef,
        at: timestamp(),
      })
      const hash = await write('resolution.json', {
        plan,
        evidenceHash: evidence.hash,
        resolutionIntentHash,
        approvalRef,
        at: timestamp(),
        provenance,
      })
      await review()
      return { stage: 'INCIDENT_RESOLUTION_RECORDED_NO_WRITE_PERMISSION', artifactHash: hash }
    }
    const resolutionIntent = await load('resolution-intent.json')
    exactKeys(resolutionIntent.data, ['plan', 'evidenceHash', 'approvalRef', 'at'])
    const receipt = await load('resolution.json')
    exactKeys(receipt.data, [
      'plan',
      'evidenceHash',
      'resolutionIntentHash',
      'approvalRef',
      'at',
      'provenance',
    ])
    check(
      receipt.hash === env.THEOU_T12_RECOVERY_RECEIPT_SHA256 &&
        canonical(receipt.data.plan) === canonical(plan) && receipt.data.evidenceHash === evidence.hash &&
        /^T12-R4-RESOLVE-[A-Z0-9-]{1,48}$/.test(receipt.data.approvalRef) &&
        receipt.data.provenance === provenance,
      'T12_RECOVERY_RESOLUTION_APPROVAL_OR_DRIFT',
    )
    check(
      receipt.data.resolutionIntentHash === resolutionIntent.hash &&
        canonical(resolutionIntent.data.plan) === canonical(plan) &&
        resolutionIntent.data.evidenceHash === evidence.hash &&
        resolutionIntent.data.approvalRef === receipt.data.approvalRef,
      'T12_RECOVERY_RESOLUTION_INTENT_DRIFT',
    )
    fresh(resolutionIntent.data.at)
    fresh(receipt.data.at)
    followup.runId = randomUUID().replaceAll('-', '')
    await write('consumption.json', {
      plan,
      receiptHash: receipt.hash,
      approvalRef,
      at: timestamp(),
      runId: followup.runId,
    })
    // Claim fsync trước mọi network activity; không reset sau thất bại.
    await review()
    const cli = await deps.cli(sources.sql)
    await runT12Preflight(
      expected,
      cli,
      t12ReadStore(new URL(`t12-e2e/${followup.runId}/`, deps.root)),
      review,
      () => {},
    )
    return {
      stage: 'RECOVERY_PREFLIGHT_COMPLETE_SQL_ONLY_NO_WRITE_PERMISSION',
      runId: followup.runId,
      artifactHash: receipt.hash,
    }
  }, deps.root)
}
