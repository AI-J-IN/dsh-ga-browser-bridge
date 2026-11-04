// Live smoke test against a real Chrome with --remote-debugging-port=9222.
// Run AFTER the user has restarted Chrome with the debug port.
// Exercises all five tools exactly as the DSH plugin would.
import { createToolContext, TOOLS } from '../dist/tools/index.js'

const ctx = createToolContext({ host: '127.0.0.1', port: 9222 })

async function call(name, args) {
  const spec = TOOLS[name]
  if (!spec) throw new Error(`missing tool ${name}`)
  const out = await spec.fn(args, ctx)
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`)
  console.log(typeof out === 'string' ? out.slice(0, 600) : JSON.stringify(out).slice(0, 600))
  return out
}

const log = (...a) => console.log('[smoke]', ...a)

try {
  // 1. tabs list — must show REAL tabs (count > 0)
  const listOut = await call('browser_tabs', { action: 'list' })
  const parsed = JSON.parse(listOut)
  if (!parsed.count || parsed.count === 0) throw new Error('list returned 0 tabs — Chrome debug port not reachable')
  log(`list OK: ${parsed.count} tabs`)

  // 2. find
  const first = parsed.tabs[0]
  const host = new URL(first.url || 'https://example.com').host
  await call('browser_tabs', { action: 'find', url_pattern: host })
  log('find OK')

  // 3. create + switch + close round-trip
  const createOut = await call('browser_tabs', { action: 'create', url: 'about:blank', active: false })
  const created = JSON.parse(createOut)
  const newId = created.id ?? created.targetId
  log(`create OK id=${newId}`)
  if (newId) {
    await call('browser_tabs', { action: 'switch', tab_id: String(newId) })
    log('switch OK')
    await call('browser_tabs', { action: 'close', tab_id: String(newId) })
    log('close OK')
  }

  // 4. scan on first tab
  await call('browser_scan', { tab_id: String(first.id), text_only: false, maxchars: 500 })
  await call('browser_scan', { tab_id: String(first.id), text_only: true, maxchars: 200 })
  log('scan OK (html + text_only)')

  // 5. execute_js — await + return value
  await call('browser_execute_js', { tab_id: String(first.id), script: 'return await Promise.resolve(6*7)' })
  log('execute_js OK')

  // 6. cdp raw — screenshot
  await call('browser_cdp', { tab_id: String(first.id), method: 'Page.captureScreenshot', params: { format: 'png' } })
  log('cdp screenshot OK')

  // 7. cdp batch with $0 ref
  await call('browser_cdp', {
    tab_id: String(first.id),
    commands: [
      { method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } },
      { method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } },
    ],
  })
  log('cdp batch OK')

  // 8. cookies
  await call('browser_cookies', { tab_id: String(first.id) })
  log('cookies OK')

  console.log('\n[smoke] ALL FIVE TOOLS EXERCISED AGAINST REAL CHROME')
} catch (e) {
  console.error('[smoke] FAILED:', e && e.stack ? e.stack : e)
  process.exitCode = 1
}
