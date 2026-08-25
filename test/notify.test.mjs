/**
 * Runtime tests for dsh-notify.
 *
 * Runs the built plugin (lib/) on a bare Cordis root context with a fake
 * `sessions` service and drives it with synthetic session events, asserting
 * which notifications the console backend emits. A capturing logger exporter
 * takes the place of the harness's log target. No LLM, no harness boot.
 *
 * Usage: npm test   (builds lib/ first, then runs this file)
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { Notifier, renderCommand } from '../lib/notify.js'

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

/** Fire a session/event through the context with a minimal fake session.
 *  Cordis treats the first object argument as the dispatch `this` (the
 *  scope carrier the real SessionStore emits through); the session itself
 *  is then the first listener argument. */
/** Only real notification lines (title | message), excluding boot diagnostics. */
function notifications(messages) {
  return lines(messages).filter((line) => line.includes('[dsh-notify]') && line.includes('|'))
}

function emit(ctx, event) {
  ctx.emit({}, 'session/event', { id: 'session-test-1' }, event)
}

const TURN_COMPLETED = (turn = 2) => ({
  type: 'turn/end',
  seq: 10,
  time: Date.now(),
  data: { turn, reason: { kind: 'completed' } },
})

test('notifies when a turn completes normally', async () => {
  const { ctx, messages } = await boot({ backend: 'console', debounceMs: 0 })
  emit(ctx, TURN_COMPLETED(3))
  const output = notifications(messages)
  assert.ok(
    output.some((line) => line.includes('[dsh-notify]') && line.includes('回答完成') && line.includes('第 3 轮已完成')),
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
