/**
 * Bots — the left-rail dashboard.
 *
 * Create workers, pick several, hand them the same task, and watch them work in
 * parallel. Each bot is its own command (ACP agent or plain CLI), so no agent
 * config is global and one slow bot never blocks a fast one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown } from '@throughline/board-host'
import { rest } from './rest.js'

const EMPTY_FORM = { name: '', kind: 'acp', command: '', args: '', cwd: '.' }

export function Bots() {
  const [bots, setBots] = useState([])
  const [agents, setAgents] = useState([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [task, setTask] = useState('')
  const [picked, setPicked] = useState([])
  const [running, setRunning] = useState({}) // botId -> {text, state, ms, error}
  const [notice, setNotice] = useState('')
  const sourceRef = useRef(null)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const list = await rest('/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 'bots', method: 'bots.list', params: {} } })
      const next = list?.result?.bots || []
      setBots(next)
      setPicked((current) => current.filter((id) => next.some((bot) => bot.id === id)))
    } catch (error) {
      setNotice(`could not list bots: ${error.message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    fetch('/agents')
      .then((r) => r.json())
      .then((data) => setAgents(Array.isArray(data?.agents) ? data.agents : []))
      .catch(() => setAgents([]))
  }, [refresh])

  // One event stream for the whole panel: every bot's output arrives as bot.*.
  useEffect(() => {
    const source = new EventSource('/events')
    sourceRef.current = source
    source.onmessage = (message) => {
      let event
      try {
        event = JSON.parse(message.data)
      } catch {
        return
      }
      if (!event?.type?.startsWith('bot.')) return
      const id = event.bot_id
      setRunning((current) => {
        const previous = current[id] || { text: '', state: 'idle' }
        if (event.type === 'bot.start') return { ...current, [id]: { text: '', state: 'running', at: Date.now() } }
        if (event.type === 'bot.delta') return { ...current, [id]: { ...previous, text: previous.text + event.text } }
        if (event.type === 'bot.complete')
          return { ...current, [id]: { ...previous, state: 'done', ms: event.ms, text: event.text || previous.text } }
        if (event.type === 'bot.error') return { ...current, [id]: { ...previous, state: 'error', error: event.message } }
        return current
      })
    }
    return () => source.close()
  }, [])

  // Tick only while something is in flight, so a finished dashboard is static.
  const live = Object.values(running).some((run) => run.state === 'running' || run.state === 'queued')
  useEffect(() => {
    if (!live) return
    const handle = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(handle)
  }, [live])

  const create = async (event) => {
    event.preventDefault()
    setNotice('')
    try {
      await rest('/rpc', {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 'bots-upsert', method: 'bots.upsert', params: { bot: form } }
      })
      setForm(EMPTY_FORM)
      await refresh()
    } catch (error) {
      setNotice(error.message)
    }
  }

  const remove = async (id) => {
    await rest('/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 'bots-rm', method: 'bots.remove', params: { id } } }).catch(
      (error) => setNotice(error.message)
    )
    await refresh()
  }

  const run = async (event) => {
    event.preventDefault()
    if (!picked.length || !task.trim()) return
    setNotice('')
    setRunning((current) => {
      const next = { ...current }
      for (const id of picked) next[id] = { text: '', state: 'queued' }
      return next
    })
    try {
      const answer = await rest('/rpc', {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 'bots-run', method: 'bots.run', params: { ids: picked, task: task.trim() } }
      })
      if (answer?.error) setNotice(answer.error.message)
    } catch (error) {
      setNotice(error.message)
    }
  }

  const useAgent = (agentId) => {
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) return
    setForm((current) => ({ ...current, name: current.name || agent.label || agent.id, kind: 'acp', command: agent.id }))
  }

  const columns = useMemo(() => picked.filter((id) => bots.some((bot) => bot.id === id)), [picked, bots])

  return (
    <div className="bots">
      <header className="bots-head">
        <h2>Bots</h2>
        <p>
          Each bot is a command. Create one per agent, then hand the same task to several at once — they run in
          parallel and each result streams into its own column.
        </p>
      </header>

      <div className="bots-grid">
        <section className="bots-panel">
          <h3>Your bots</h3>
          {bots.length === 0 ? <p className="bots-empty">No bots yet. Add one below.</p> : null}
          <ul className="bot-list">
            {bots.map((bot) => (
              <li key={bot.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(bot.id)}
                    onChange={(event) =>
                      setPicked((current) => (event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id)))
                    }
                  />
                  <span className={`dot ${bot.running ? 'busy' : ''}`} />
                  <span className="bot-name">{bot.name}</span>
                  <span className="bot-meta">
                    {bot.kind} · {bot.command}
                  </span>
                </label>
                <button type="button" onClick={() => void remove(bot.id)} title="Delete bot">
                  ×
                </button>
              </li>
            ))}
          </ul>

          <form className="bot-form" onSubmit={create}>
            <h4>New bot</h4>
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <div className="row">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="acp">ACP agent</option>
                <option value="cli">CLI command</option>
              </select>
              <select value="" onChange={(e) => useAgent(e.target.value)}>
                <option value="">use a configured agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label || agent.id}
                  </option>
                ))}
              </select>
            </div>
            <input
              placeholder={form.kind === 'acp' ? 'command (e.g. hermes)' : 'command (e.g. pi)'}
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
            <input placeholder="args (space separated)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            <input placeholder="working directory" value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.target.value })} />
            <button type="submit">Add bot</button>
          </form>
          {notice ? <p className="bots-notice">{notice}</p> : null}
        </section>

        <section className="bots-panel">
          <h3>Run a task</h3>
          <form onSubmit={run} className="bot-run">
            <textarea
              rows={3}
              placeholder="What should the bots do? e.g. compare three coffee subscription pricing models"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
            <button type="submit" disabled={!picked.length || !task.trim()}>
              Run on {picked.length || 0} bot{picked.length === 1 ? '' : 's'}
            </button>
          </form>

          <div className="bot-columns">
            {columns.length === 0 ? (
              <p className="bots-empty">Tick one or more bots above, then give them a task — each result lands here as its own column.</p>
            ) : null}
            {columns.map((id) => {
              const bot = bots.find((b) => b.id === id)
              const state = running[id] || { text: '', state: 'idle' }
              return (
                <article key={id} className={`bot-column state-${state.state}`}>
                  <header>
                    <strong>{bot?.name || id}</strong>
                    <span>
                      {state.state === 'done'
                        ? `${(state.ms / 1000).toFixed(1)}s`
                        : state.state === 'running' && state.at
                          ? `running ${Math.round((Date.now() - state.at) / 1000)}s`
                          : state.state}
                    </span>
                  </header>
                  {state.text ? (
                    <Streamdown>{state.text}</Streamdown>
                  ) : (
                    <pre className="bot-wait">{state.state === 'running' ? '…' : ''}</pre>
                  )}
                  {state.error ? (
                    <p className="bot-error">
                      {state.error}
                      {state.text ? ' — partial output above' : ''}
                    </p>
                  ) : null}
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
