import { check } from './t06-cloud-inventory.ts'
import { publicPost } from './t06-cloud-runner.ts'
import { keys } from './t09-cloud-inventory.ts'
import type { ModerationSnapshot } from './t11-cloud-inventory.ts'
import type { PostPublic } from '../functions/social-api/modules/posts/post-mapper.ts'

interface FeedRequest {
  sort: 'NEW' | 'HOT'
  tag: null
  cursor: string | null
  limit: number
}
interface FeedResponse {
  data: unknown
  status: number
  code: string | null
  serverTime?: number | null
}
const day = 86_400_000
function utc(value: unknown) {
  check(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'T11_FEED_SQL_TIMESTAMP',
  )
  const [seconds, fraction = ''] = value.replace(/(?:Z|\+00:00)$/, '').split('.')
  return seconds + '.' + fraction.padEnd(6, '0') + 'Z'
}
export async function verifyT11Feed(
  snapshot: ModerationSnapshot,
  actor: { label: 'A' | 'B'; hash: string },
  request: (payload: FeedRequest) => Promise<FeedResponse>,
  report: (line: string) => void,
  limit = 20,
) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'T11_FEED_LIMIT')
  const published = snapshot.business.posts.filter((p) => p.status === 'PUBLISHED')
  const dates = new Map(
    published.map((p) => [p.id, utc(snapshot.postProofs.find((x) => x.id === p.id)?.publishedAt)]),
  )
  for (const sort of ['NEW', 'HOT'] as const) {
    const items: PostPublic[] = [], cursors = new Set<string>(), started = Date.now()
    let cursor: string | null = null,
      page = 0,
      lo = started,
      hi = started,
      firstFinished = started,
      clock = 'local',
      shape = 'unknown',
      http = 0,
      code = 'UNKNOWN',
      pageCount = -1,
      hasMore = false
    const diagnostic = (reason: string, expected: number | null) => {
      report(
        `${
          reason === 'OK' ? 'PASS' : reason === 'PAGE_OK' ? 'INFO' : 'FAIL'
        }: T11_FEED; actor=${actor.label}; sort=${sort}; tag=null; limit=${limit}; page=${page}; shape=${shape}; keys=${
          shape === 'page' ? 'items,nextCursor' : 'unknown'
        }; published=${published.length}; expected=${
          expected === null ? 'unknown' : expected
        }; actual=${items.length}; pageCount=${pageCount}; hasMore=${hasMore}; http=${http}; code=${code}; clock=${clock}; reason=${reason}.`,
      )
    }
    const require: (condition: unknown, reason: string, expected?: number | null) => asserts condition = (
      condition,
      reason,
      expected = sort === 'NEW' ? published.length : null,
    ) => {
      if (!condition) {
        diagnostic(reason, expected)
        check(false, 'T11_FEED_' + reason)
      }
    }
    do {
      const result = await request({ sort, tag: null, cursor, limit }), finished = Date.now()
      http = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
        ? result.status
        : 0
      code = result.code === null ? 'OK' : [
          'INTERNAL_ERROR',
          'VALIDATION_ERROR',
          'UNAUTHENTICATED',
          'FORBIDDEN',
          'NOT_FOUND',
          'CONFLICT',
          'UPLOAD_ERROR',
        ]
          .includes(result.code)
        ? result.code
        : 'UNKNOWN'
      page++
      if (page === 1) {
        firstFinished = finished
        if (typeof result.serverTime === 'number' && Number.isFinite(result.serverTime)) {
          // HTTP Date có độ phân giải giây; bài ở vùng biên sẽ FAIL, không đoán membership.
          lo = result.serverTime - (finished - started) - 1000
          hi = result.serverTime + 1000
          clock = 'http_date'
        } else {
          lo = started
          hi = finished
        }
      }
      require(result.status === 200 && result.code === null, 'HTTP')
      const data = result.data
      shape = keys(data, ['items', 'nextCursor']) ? 'page' : 'invalid_page'
      require(
        keys(data, ['items', 'nextCursor']) && Array.isArray(data.items) &&
          (data.nextCursor === null ||
            typeof data.nextCursor === 'string' && data.nextCursor.length > 0 &&
              data.nextCursor.length <= 1024),
        'PAGE',
      )
      pageCount = data.items.length
      hasMore = data.nextCursor !== null
      require(pageCount <= limit && (pageCount > 0 || !hasMore), 'PAGE_SIZE')
      for (const item of data.items) {
        let p: PostPublic
        try {
          p = publicPost(item)
        } catch {
          diagnostic('DTO', sort === 'NEW' ? published.length : null)
          check(false, 'T11_FEED_DTO')
        }
        const row = published.find((x) => x.id === p.id)
        require(
          row && utc(p.publishedAt) === dates.get(p.id) && p.commentCount === row.commentCount &&
            p.upvoteCount === row.upvoteCount && p.hasUpvoted === snapshot.business.votes.some((v) =>
                v.postId === p.id && v.userHash === actor.hash
              ) &&
            p.isMine === (row.authorHash === actor.hash),
          'VISIBILITY_PRIVACY',
        )
        require(!items.some((x) => x.id === p.id), 'DUPLICATE')
        items.push(p)
      }
      require(page <= published.length + 1, 'PAGE_BOUND')
      if (data.nextCursor !== null) {
        require(!cursors.has(data.nextCursor), 'CURSOR_LOOP')
        cursors.add(data.nextCursor)
      }
      diagnostic('PAGE_OK', sort === 'NEW' ? published.length : null)
      cursor = data.nextCursor
    } while (cursor !== null)
    hi += Date.now() - firstFinished
    if (sort === 'HOT') {
      require(
        !published.some((p) => {
          const t = Date.parse(dates.get(p.id)!)
          return t >= lo - day && t < hi - day
        }),
        'HOT_BOUNDARY_REVIEW',
      )
    }
    const expected = published.filter((p) => sort === 'NEW' || Date.parse(dates.get(p.id)!) >= hi - day)
    expected.sort((a, b) =>
      sort === 'HOT' && a.upvoteCount !== b.upvoteCount
        ? b.upvoteCount - a.upvoteCount
        : dates.get(b.id)!.localeCompare(dates.get(a.id)!) || b.id.localeCompare(a.id)
    )
    require(items.length === expected.length, 'COUNT', expected.length)
    require(items.every((p, index) => p.id === expected[index].id), 'IDS_OR_ORDER', expected.length)
    diagnostic('OK', expected.length)
  }
}
