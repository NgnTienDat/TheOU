import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { demoPosts, landingPosts } from '../src/features/landing/landing-demo.ts'

test('Landing keeps every original synthetic post and NEW/HOT/tag selection', async () => {
  const html = await readFile(new URL('../../docs/fe-templates/TheOU-Landing-Black-White.html', import.meta.url), 'utf8')
  const start = html.indexOf('const demoPosts = [') + 'const demoPosts = '.length
  const original: unknown = runInNewContext(html.slice(start, html.indexOf('];', start) + 1))
  assert.equal(JSON.stringify(demoPosts), JSON.stringify(original))
  assert.deepEqual(landingPosts('all', 'new').map(p => p.hours), [1, 2])
  assert.deepEqual(landingPosts('all', 'hot').map(p => p.votes), [34, 28])
  for (const post of demoPosts) {
    for (const sort of ['new', 'hot']) assert.deepEqual(landingPosts(post.tag, sort), [post])
  }
  assert.equal(landingPosts('all', 'new').length, 2)
  assert.deepEqual(demoPosts.map(p => p.hours), [2, 4, 5, 7, 1], 'Sorting must not mutate the fixture')
})

test('Landing stylesheet preserves the exact approved scoped rules and no demo-app palette', async () => {
  const html = await readFile(new URL('../../docs/fe-templates/TheOU-Landing-Black-White.html', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/features/landing/landing.css', import.meta.url), 'utf8')
  const approved = html.slice(html.indexOf('/* Landing page styles scoped'), html.indexOf('</style>'))
  assert.ok(css.endsWith(approved))
  assert.doesNotMatch(css, /:root|html\[data-theme|\.rail\{|\.thread-box\{/)
})
