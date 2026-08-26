/**
 * Runtime tests for dsh-notify.
 *
 * Host side: the built plugin runs on a bare Cordis root context with fake
 * `sessions` and (for the rpc row) `connection` services, driven by synthetic
 * session events and synthetic presence reports, asserting which
 * notifications the console backend emits.
 *
 * Client side: the built `window.__ModuleLoader__` bundle registers against a
 * mocked loader, and its `apply` runs against mocked DOM/connection/services,
 * asserting which presence reports leave the page.
 *
 * No LLM, no harness boot, no real sound or desktop notifications.
 *
 * Usage: npm test   (builds lib/ first, then runs this file)
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import * as rpcPlugin from '../lib/rpc.js'
import { Notifier, renderCommand } from '../lib/notify.js'
import { PresenceStore, parsePresenceReport } from '../lib/presence.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/** Boot one plugin instance on a fresh root context with a log capture. */
async function boot(config) {
  const ctx = new Context()
  ctx.provide('sessions', {})
  const messages = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  await ctx.plugin(plugin, config)
  return { ctx, messages }
}

/** Flatten captured logger messages into assertion-friendly lines. */
function lines(messages) {
  return messages.map((message) => message.args
    .map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg))
    .join(' '))
}

/** Only real notification lines (title | message), excluding boot diagnostics. */
function notifications(messages) {
  return lines(messages).filter((line) => line.includes('[dsh-notify]') && line.includes('|'))
}

/** Fire a session/event through the context with a minimal fake session.
 *  Cordis treats the first object argument as the dispatch `this` (the
 *  scope carrier the real SessionStore emits through); the session itself
 *  is then the first listener argument. */
function emit(ctx, event) {
  ctx.emit({}, 'session/event', { id: 'session-test-1' }, event)
}

const TURN_COMPLETED = (turn = 2) => ({
  type: 'turn/end',
  seq: 10,
  time: Date.now(),
  data: { turn, reason: { kind: 'completed' } },
})

// ---------------------------------------------------------------- host: triggers

test('notifies when a turn completes normally', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, TURN_COMPLETED(3))
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('回答完成') && line.includes('第 3 轮已完成')),
    `expected turn-complete notification, got: ${JSON.stringify(output)}`,
  )
})

test('previews the assistant text on turn completion', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'assistant/message',
    seq: 9,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '构建完成，产物在 dist/' }] },
    },
  })
  emit(ctx, TURN_COMPLETED(2))
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('构建完成，产物在 dist/')),
    `expected assistant preview, got: ${JSON.stringify(output)}`,
  )
})

test('does not notify for aborted turns', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'turn/end',
    seq: 10,
    time: Date.now(),
    data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal(notifications(messages).length, 0,
    `expected no notification, got: ${JSON.stringify(lines(messages))}`)
})

test('notifies with the objective when a goal completes', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'goal/change',
    seq: 11,
    time: Date.now(),
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'complete',
      goal: { id: 'g1', revision: 1, objective: '修好单元测试', phase: 'completed', maxGoalRounds: 10 },
      roundsStarted: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('任务完成') && line.includes('修好单元测试')),
    `expected goal-complete notification, got: ${JSON.stringify(output)}`,
  )
})

test('ignores non-complete goal mutations', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'goal/change',
    seq: 11,
    time: Date.now(),
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: { id: 'g1', revision: 1, objective: '做点事', phase: 'active', maxGoalRounds: 10 },
      roundsStarted: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
  assert.equal(notifications(messages).length, 0)
})

test('notifies with question and choices for ask_user_question', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'tool/call',
    seq: 12,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{
          id: 'mode',
          header: '选择模式',
          question: '用哪种模式继续？',
          options: [
            { label: '快速模式（推荐）', description: '更快' },
            { label: '完整模式', description: '更稳' },
          ],
        }],
      }),
    },
  })
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('需要你的回答')
      && line.includes('用哪种模式继续')
      && line.includes('快速模式（推荐）')
      && line.includes('完整模式')),
    `expected question notification, got: ${JSON.stringify(output)}`,
  )
})

test('skips option-less questions when onlyQuestionsWithChoices is set', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0, onlyQuestionsWithChoices: true })
  emit(ctx, {
    type: 'tool/call',
    seq: 12,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q', question: '你的名字是？' }] }),
    },
  })
  assert.equal(notifications(messages).length, 0)
})

test('notifies for option-less questions by default', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'tool/call',
    seq: 12,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q', question: '你的名字是？' }] }),
    },
  })
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('需要你的回答') && line.includes('你的名字是？')),
    `expected question notification, got: ${JSON.stringify(output)}`,
  )
})

test('ignores other tool calls', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'tool/call',
    seq: 12,
    time: Date.now(),
    data: { turn: 2, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  })
  assert.equal(notifications(messages).length, 0)
})

test('notifies when an approval is requested', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'approval/asked',
    seq: 13,
    time: Date.now(),
    data: { id: 'approval-1', toolName: 'bash', reason: 'sandbox write outside the workspace' },
  })
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('需要审批') && line.includes('bash') && line.includes('sandbox write outside the workspace')),
    `expected approval notification, got: ${JSON.stringify(output)}`,
  )
})

test('approval notification falls back to tool name without a reason', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'approval/asked',
    seq: 13,
    time: Date.now(),
    data: { id: 'approval-1', toolName: 'bash' },
  })
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('需要审批') && line.includes('请求执行 bash')),
    `expected tool-name-only approval notification, got: ${JSON.stringify(output)}`,
  )
})

test('onApproval: false skips approval notifications', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0, onApproval: false })
  emit(ctx, {
    type: 'approval/asked',
    seq: 13,
    time: Date.now(),
    data: { id: 'approval-1', toolName: 'bash', reason: 'needs approval' },
  })
  assert.equal(notifications(messages).length, 0)
})

test('debounces repeated notifications of the same kind', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 60_000 })
  emit(ctx, TURN_COMPLETED(2))
  emit(ctx, TURN_COMPLETED(3))
  assert.equal(notifications(messages).length, 1,
    `expected exactly one notification, got: ${JSON.stringify(lines(messages))}`)
})

test('keeps separate debounce buckets per kind', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 60_000 })
  emit(ctx, TURN_COMPLETED(2))
  emit(ctx, {
    type: 'tool/call',
    seq: 13,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      callId: 'call-1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q', question: '继续吗？' }] }),
    },
  })
  assert.equal(notifications(messages).length, 2,
    `expected two notifications (different kinds), got: ${JSON.stringify(lines(messages))}`)
})

test('drops session state when the session is disposed', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, {
    type: 'assistant/message',
    seq: 9,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '旧内容' }] },
    },
  })
  ctx.emit({}, 'session/disposed', { id: 'session-test-1' })
  emit(ctx, TURN_COMPLETED(3))
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('回答完成') && line.includes('第 3 轮已完成')),
    `expected fallback message after dispose, got: ${JSON.stringify(output)}`,
  )
})

// ------------------------------------------------------------ host: presence

test('notifies by default when no client reports presence (empty store)', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, TURN_COMPLETED(2))
  assert.equal(notifications(messages).length, 1)
})

test('suppresses notifications while a visible client attends the session', async () => {
  const ctx = new Context()
  ctx.provide('sessions', {})
  const messages = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  const rpc = { captured: undefined }
  ctx.provide('connection', {
    rpc: {
      handle: (channel, handler, options) => {
        rpc.captured = { channel, handler, options }
      },
    },
  })
  await ctx.plugin(plugin, { backend: 'console', debounceMs: 0, presenceTtlMs: 60_000 })
  await ctx.plugin(rpcPlugin)
  assert.equal(rpc.captured.channel, '/dsh-notify')
  assert.equal(rpc.captured.options.authority, 'loopback')

  // A visible browser tab is displaying this session.
  const result = await rpc.captured.handler('presence', {
    clientId: 'c1', sessionId: 'session-test-1', visible: true,
  })
  assert.deepEqual(result, { ok: true, value: null })
  emit(ctx, TURN_COMPLETED(2))
  assert.equal(notifications(messages).length, 0,
    `attended session must stay silent, got: ${JSON.stringify(lines(messages))}`)

  // The user switches away: same session, hidden page → notify again.
  await rpc.captured.handler('presence', {
    clientId: 'c1', sessionId: 'session-test-1', visible: false,
  })
  emit(ctx, TURN_COMPLETED(3))
  assert.equal(notifications(messages).length, 1,
    `hidden page must notify, got: ${JSON.stringify(lines(messages))}`)
})

test('still notifies when a visible client attends a different session', async () => {
  const ctx = new Context()
  ctx.provide('sessions', {})
  const messages = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  let handler = undefined
  ctx.provide('connection', {
    rpc: { handle: (_channel, h) => { handler = h } },
  })
  await ctx.plugin(plugin, { backend: 'console', debounceMs: 0, presenceTtlMs: 60_000 })
  await ctx.plugin(rpcPlugin)
  await handler('presence', { clientId: 'c1', sessionId: 'some-other-session', visible: true })
  emit(ctx, TURN_COMPLETED(2))
  assert.equal(notifications(messages).length, 1,
    `another session being viewed must not suppress this one, got: ${JSON.stringify(lines(messages))}`)
})

test('onlyWhenAway: false notifies even while attended', async () => {
  const ctx = new Context()
  ctx.provide('sessions', {})
  const messages = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  let handler = undefined
  ctx.provide('connection', {
    rpc: { handle: (_channel, h) => { handler = h } },
  })
  await ctx.plugin(plugin, { backend: 'console', debounceMs: 0, presenceTtlMs: 60_000, onlyWhenAway: false })
  await ctx.plugin(rpcPlugin)
  await handler('presence', { clientId: 'c1', sessionId: 'session-test-1', visible: true })
  emit(ctx, TURN_COMPLETED(2))
  assert.equal(notifications(messages).length, 1)
})

test('rpc rejects malformed presence payloads with bad-request', async () => {
  const ctx = new Context()
  ctx.provide('sessions', {})
  const messages = []
  ctx.logger.exporter({ export: (message) => messages.push(message) })
  let handler = undefined
  ctx.provide('connection', {
    rpc: { handle: (_channel, h) => { handler = h } },
  })
  await ctx.plugin(plugin, { backend: 'console', debounceMs: 0 })
  await ctx.plugin(rpcPlugin)
  const result = await handler('presence', { clientId: 42, sessionId: null, visible: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
  assert.equal(notifications(messages).length, 0)
})

// ------------------------------------------------------- presence store (unit)

test('PresenceStore expires stale clients', () => {
  let now = 0
  const store = new PresenceStore(1000, () => now)
  store.report({ clientId: 'c1', sessionId: 's1', visible: true })
  now = 500
  assert.equal(store.isAttended('s1'), true)
  now = 1600
  assert.equal(store.isAttended('s1'), false, 'stale report must stop suppressing')
  assert.equal(store.size(), 0)
})

test('PresenceStore ignores hidden and other-session clients', () => {
  const store = new PresenceStore(60_000)
  store.report({ clientId: 'c1', sessionId: 's1', visible: false })
  store.report({ clientId: 'c2', sessionId: 's2', visible: true })
  store.report({ clientId: 'c3', sessionId: null, visible: true })
  assert.equal(store.isAttended('s1'), false)
  assert.equal(store.isAttended('s2'), true)
})

test('parsePresenceReport validates payloads', () => {
  assert.deepEqual(
    parsePresenceReport({ clientId: 'c1', sessionId: 's1', visible: true }),
    { clientId: 'c1', sessionId: 's1', visible: true },
  )
  assert.deepEqual(
    parsePresenceReport({ clientId: 'c1', sessionId: null, visible: false }),
    { clientId: 'c1', sessionId: null, visible: false },
  )
  for (const bad of [
    null,
    {},
    { clientId: '', sessionId: null, visible: true },
    { clientId: 'c1', sessionId: 7, visible: true },
    { clientId: 'c1', sessionId: null, visible: 'yes' },
  ]) {
    assert.throws(() => parsePresenceReport(bad), TypeError)
  }
})

// ------------------------------------------------------------- client (browser)

/** Minimal DOM event-target double. */
function makeTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type)
      if (!list) return
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
  }
}

/** Load the built client bundle against a mocked ModuleLoader and apply it. */
async function applyClient({ visibilityState = 'visible', focused = true, current } = {}) {
  const calls = []
  let captured = undefined
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = factory((specifier) => {
          throw new Error(`unexpected require(${specifier})`)
        })
      },
    },
  }
  await import(`../lib/client.js?apply=${Math.random().toString(36).slice(2)}`)
  assert.ok(captured, 'client bundle must register a factory')
  const documentTarget = makeTarget()
  const windowTarget = makeTarget()
  globalThis.document = {
    visibilityState,
    hasFocus: () => focused,
    addEventListener: documentTarget.addEventListener,
    removeEventListener: documentTarget.removeEventListener,
  }
  globalThis.window.addEventListener = windowTarget.addEventListener
  globalThis.window.removeEventListener = windowTarget.removeEventListener

  let subscribed = undefined
  let disposer = () => {}
  const state = { current }
  const fakeCtx = {
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          calls.push({ channel, endpoint, payload })
          return { ok: true, value: null }
        },
      },
    },
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe: (fn) => { subscribed = fn; return () => {} },
      },
    },
    effect: (cb) => { disposer = cb() ?? (() => {}) },
  }
  captured.apply(fakeCtx)
  return { calls, state, documentTarget, windowTarget, fireList: () => subscribed?.(), cleanup: () => disposer() }
}

test('client reports presence immediately on apply', async () => {
  const { calls, cleanup } = await applyClient({ current: 'session-7' })
  try {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].channel, '/dsh-notify')
    assert.equal(calls[0].endpoint, 'presence')
    assert.equal(calls[0].payload.sessionId, 'session-7')
    assert.equal(calls[0].payload.visible, true)
    assert.equal(typeof calls[0].payload.clientId, 'string')
  } finally {
    cleanup()
  }
})

test('client reports visible:false when the tab hides', async () => {
  const { calls, documentTarget, cleanup } = await applyClient({ current: 'session-7' })
  try {
    globalThis.document.visibilityState = 'hidden'
    documentTarget.fire('visibilitychange')
    await new Promise((resolve) => setTimeout(resolve, 1200)) // let the throttled report land
    assert.equal(calls.at(-1).payload.visible, false)
  } finally {
    cleanup()
  }
})

test('client reports visible:false when the window blurs', async () => {
  const { calls, windowTarget, cleanup } = await applyClient({ current: 'session-7', focused: true })
  try {
    globalThis.document.hasFocus = () => false
    windowTarget.fire('blur')
    await new Promise((resolve) => setTimeout(resolve, 1200)) // let the throttled report land
    assert.equal(calls.at(-1).payload.visible, false)
  } finally {
    cleanup()
  }
})

test('client reports the new selection when it changes', async () => {
  const { calls, state, fireList, cleanup } = await applyClient({ current: 'session-a' })
  try {
    state.current = 'session-b'
    fireList()
    await new Promise((resolve) => setTimeout(resolve, 1200)) // let the throttled report land
    assert.equal(calls.at(-1).payload.sessionId, 'session-b')
  } finally {
    cleanup()
  }
})

test('client reports visible:false on pagehide even while visible', async () => {
  const { calls, windowTarget, cleanup } = await applyClient({ current: 'session-7' })
  try {
    windowTarget.fire('pagehide')
    assert.equal(calls.at(-1).payload.visible, false)
  } finally {
    cleanup()
  }
})

test('client heartbeats even when state is unchanged', async () => {
  const { mock } = await import('node:test')
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'], now: 0 })
  const { calls, cleanup } = await applyClient({ current: 'session-7' })
  try {
    const before = calls.length
    mock.timers.tick(16_000) // past the 15s heartbeat
    assert.ok(calls.length > before,
      `expected a heartbeat refresh with unchanged state, got ${calls.length} calls`)
  } finally {
    cleanup()
    mock.timers.reset()
  }
})

// ---------------------------------------------------------------- notifier (unit)

test('renderCommand substitutes both placeholders', () => {
  assert.equal(
    renderCommand('notify-send "{title}" "{message}"', { title: 'a"b', message: 'line1\nline2' }),
    'notify-send "a"b" "line1\nline2"',
  )
})

test('Notifier console backend writes through the log sink', () => {
  const output = []
  const notifier = new Notifier({
    backend: 'console',
    command: '',
    urgency: 'normal',
    expireMs: 0,
    playSound: true,
    log: (line) => output.push(line),
  })
  notifier.send({ title: 'T', message: 'M' })
  assert.deepEqual(output, ['[dsh-notify] T | M'])
})

test('Notifier command backend renders the template', () => {
  const output = []
  const notifier = new Notifier({
    backend: 'command',
    command: 'true "{title}"',
    urgency: 'normal',
    expireMs: 0,
    playSound: false,
    log: (line) => output.push(line),
  })
  notifier.send({ title: 'T', message: 'M' })
  assert.equal(output.length, 0, `spawn errors should not reach the log for a valid command: ${output}`)
})

// ---- runner ----
let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    console.error(String(error?.stack ?? error))
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} tests failed`)
  process.exitCode = 1
} else {
  console.log(`\nall ${tests.length} tests passed`)
}
