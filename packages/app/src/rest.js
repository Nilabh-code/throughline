/** ctx.rest — the engine's lane, shared by the shell and the bots panel. */
export async function rest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(payload.error || `${path} -> ${response.status}`)
  return payload
}
