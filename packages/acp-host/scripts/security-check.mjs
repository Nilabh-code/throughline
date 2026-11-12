/**
 * The break-in attempts from the audit, as assertions.
 *
 * Every case here killed or owned the engine at some point. Run it against a
 * live engine:  node scripts/security-check.mjs http://127.0.0.1:8791
 */
const base = process.argv[2] || 'http://127.0.0.1:8791'
const results = []

const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: response.status, json, text }
}

// 1. A null body used to be a one-request engine kill.
{
  const r = await post('/rpc', 'null')
  check('null body is rejected, not fatal', r.status === 400, `status ${r.status}`)
  const alive = await fetch(`${base}/health`).then((x) => x.status).catch(() => 0)
  check('engine survives it', alive === 200, `health ${alive}`)
}

// 2. DNS rebinding: Origin and Host agree, so only a Host allowlist catches it.
{
  const r = await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'bots.list', params: {} }, {
    Host: 'rebind.test:9999',
    Origin: 'http://rebind.test:9999'
  })
  check('rebound Host is refused', r.status === 403, `status ${r.status}`)
}

// 3. A foreign Origin (any page the user visits) must not reach an agent.
{
  const r = await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'bots.list', params: {} }, {
    Origin: 'https://evil.example'
  })
  check('cross-origin POST refused', r.status === 403, `status ${r.status}`)
}

// 4. A cross-origin EventSource used to read every board and bot event.
{
  const response = await fetch(`${base}/events`, { headers: { Origin: 'https://evil.example' } }).catch(() => null)
  check('cross-origin event stream refused', !response || response.status === 403, `status ${response?.status ?? 'blocked'}`)
}

// 5. Oversize bodies answer 413 instead of resetting the socket.
{
  const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'bots.list', params: { pad: 'x'.repeat(9 * 1024 * 1024) } })
  const r = await post('/rpc', big)
  check('oversize body is 413', r.status === 413, `status ${r.status}`)
}

// 6. The board read lane must answer JSON, not the app shell.
{
  const response = await fetch(`${base}/boards`)
  const type = response.headers.get('content-type') || ''
  check('/boards returns JSON', type.includes('application/json'), type)
}

// 7. A bot command that does not exist is an error event, not a crash.
{
  await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'bots.upsert', params: { bot: { name: 'ghost', kind: 'cli', command: 'C:/nope/agent.exe' } } })
  await post('/rpc', { jsonrpc: '2.0', id: 2, method: 'bots.run', params: { ids: ['ghost'], task: 'hi' } })
  await new Promise((r) => setTimeout(r, 2500))
  const alive = await fetch(`${base}/health`).then((x) => x.status).catch(() => 0)
  check('missing bot binary does not kill the engine', alive === 200, `health ${alive}`)
  await post('/rpc', { jsonrpc: '2.0', id: 3, method: 'bots.remove', params: { id: 'ghost' } })
}

// 8. Duplicate ids fan out once, and a busy bot is reported as skipped.
{
  const created = await post('/rpc', {
    jsonrpc: '2.0',
    id: 4,
    method: 'bots.upsert',
    params: { bot: { name: 'slowpoke', kind: 'cli', command: 'node', args: ['-e', 'setTimeout(()=>{},1e9)'] } }
  })
  if (created.json?.result) {
    const first = await post('/rpc', { jsonrpc: '2.0', id: 5, method: 'bots.run', params: { ids: ['slowpoke', 'slowpoke'], task: 'x' } })
    const started = first.json?.result?.started || []
    check('duplicate ids start one run', started.length === 1, `started ${JSON.stringify(started)}`)
    const second = await post('/rpc', { jsonrpc: '2.0', id: 6, method: 'bots.run', params: { ids: ['slowpoke'], task: 'y' } })
    check('a busy bot is skipped, not doubled', (second.json?.result?.skipped || []).includes('slowpoke'), JSON.stringify(second.json?.result))
    await post('/rpc', { jsonrpc: '2.0', id: 7, method: 'bots.remove', params: { id: 'slowpoke' } })
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
