import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { check } from './t06-cloud-inventory.ts'
import {
  type CommentBaseline,
  commentCleanupSql,
  type CommentInventory,
  commentVerificationSql,
  validateBaseline,
  validateCommentInventory,
} from './t08-cloud-inventory.ts'

export const deleteStages = [
  'PREPARE',
  'CROSS_B_RETRY',
  'CROSS_A_PARALLEL_B',
  'RACE_RETRY',
  'OWN_PARALLEL_B',
  'REPLAY_PARALLEL_B',
  'RECOVERY',
  'FINISH',
] as const
export type DeleteStage = typeof deleteStages[number]
export interface DeleteObservation {
  inventory: CommentInventory
  snapshot: CommentBaseline
}
export interface CommentDeleteJournal {
  version: 1
  original: CommentInventory
  originalHash: string
  status: 'PREPARED' | 'RUNNING' | 'FAILED' | 'COMPLETED'
  uncertain: boolean
  events: {
    stage: DeleteStage
    phase: 'INTENT' | 'ACK' | 'VERIFIED' | 'FAILED'
    http?: number
    code?: 'OK' | 'NOT_FOUND'
    observation?: DeleteObservation
  }[]
}
export interface CommentDeleteStore {
  begin(record: CommentInventory): Promise<CommentDeleteJournal>
  save(journal: CommentDeleteJournal): Promise<void>
}
const hash = (record: CommentInventory) => createHash('sha256').update(JSON.stringify(record)).digest('hex')
export function prepareDeleteJournal(record: CommentInventory): CommentDeleteJournal {
  validateCommentInventory(record)
  return {
    version: 1,
    original: structuredClone(record),
    originalHash: hash(record),
    status: 'PREPARED',
    uncertain: false,
    events: [],
  }
}
export function validateDeleteJournal(journal: CommentDeleteJournal) {
  validateCommentInventory(journal.original)
  check(
    journal.version === 1 && hash(journal.original) === journal.originalHash &&
      ['PREPARED', 'RUNNING', 'FAILED', 'COMPLETED'].includes(journal.status) &&
      typeof journal.uncertain === 'boolean' && Array.isArray(journal.events),
    'T08_R2_JOURNAL_SCOPE',
  )
  for (const event of journal.events) {
    check(
      deleteStages.includes(event.stage) && ['INTENT', 'ACK', 'VERIFIED', 'FAILED'].includes(event.phase) &&
        (event.http === undefined || [200, 404].includes(event.http)) &&
        (event.code === undefined || ['OK', 'NOT_FOUND'].includes(event.code)),
      'T08_R2_EVENT_SCOPE',
    )
    if (event.observation) {
      const { inventory, snapshot } = event.observation
      validateCommentInventory(inventory)
      validateBaseline(snapshot)
      const original = structuredClone(inventory)
      for (const f of original.fixtures) {
        check(
          f.state === 'VISIBLE' || ['retry', 'parallel-b'].includes(f.label) && f.state === 'DELETED',
          'T08_R2_OBSERVED_STATE',
        )
        f.state = 'VISIBLE'
      }
      check(hash(original) === journal.originalHash, 'T08_R2_OBSERVATION_SCOPE')
    }
  }
  if (journal.status === 'COMPLETED') {
    const final = journal.events.findLast((e) => e.stage === 'FINISH' && e.phase === 'VERIFIED')?.observation
    check(
      !journal.uncertain && final &&
        final.inventory.fixtures.every((f) =>
          f.state === (['retry', 'parallel-b'].includes(f.label) ? 'DELETED' : 'VISIBLE')
        ),
      'T08_R2_COMPLETION_PROOF',
    )
  }
}

export function fileCommentDeleteStore(
  directory = new URL('../.temp/t08-comments/', import.meta.url),
): CommentDeleteStore {
  let runId: string | undefined
  async function atomic(suffix: string, text: string) {
    const temporary = new URL(`${runId}.${randomUUID()}.tmp`, directory)
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await rename(temporary, new URL(`${runId}.r2.${suffix}`, directory))
  }
  return {
    async begin(record) {
      const journal = prepareDeleteJournal(record)
      await mkdir(directory, { recursive: true })
      // wx ngăn hai process cùng dùng run hoặc tự chạy lại sau một lần dở dang.
      await writeFile(
        new URL(`${record.runId}.r2.json`, directory),
        JSON.stringify(journal, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      )
      runId = record.runId
      return journal
    },
    async save(journal) {
      validateDeleteJournal(journal)
      check(runId === journal.original.runId, 'T08_R2_STORE_RUN_ID')
      const observed = journal.events.filter((e) => e.observation).at(-1)?.observation
      if (observed) await atomic('verify.sql', commentVerificationSql(observed.inventory))
      // Chỉ tạo cleanup để review khi cả API/DB/logout đã hoàn tất, không còn request chưa rõ.
      if (journal.status === 'COMPLETED' && !journal.uncertain && observed) {
        await atomic('verified.json', JSON.stringify(observed.inventory, null, 2) + '\n')
        await atomic('cleanup.sql', commentCleanupSql(observed.inventory))
      }
      await atomic('json', JSON.stringify(journal, null, 2) + '\n')
    },
  }
}
