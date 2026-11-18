import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { mediaAssets } from './t10-media-assets.ts'

// Tái sử dụng Playwright đã có ở frontend; chỉ decode bitmap tổng hợp, chặn toàn bộ mạng.
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { chromium } = require('playwright-core')
const browser = await chromium.launch({
  executablePath: process.env.THEOU_BROWSER_PATH ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
try {
  const context = await browser.newContext()
  await context.route('**/*', (route) => route.abort())
  const page = await context.newPage()
  const directory = new URL('../.temp/t10-media-assets/', import.meta.url)
  await mkdir(directory, { recursive: true })
  for (const asset of mediaAssets()) {
    const result = await page.evaluate(async ({ bytes, mime }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: mime })
      const bitmap = await createImageBitmap(blob)
      const dimensions = [bitmap.width, bitmap.height]
      bitmap.close()
      return dimensions
    }, { bytes: [...asset.bytes], mime: asset.mime })
    assert.deepEqual(result, [2, 2])
    await writeFile(new URL(`synthetic-${asset.position}.${asset.extension}`, directory), asset.bytes)
  }
  process.stdout.write('PASS: T10 synthetic PNG/WebP; browser decode 2/2; network blocked.\n')
} finally {
  await browser.close()
}
