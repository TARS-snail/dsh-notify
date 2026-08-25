/**
 * `dsh-notify`: send a desktop notification when a DeepSeek Harness session
 * completes a task or asks the user a question that needs an answer.
 *
 * The plugin is a pure observer of the session event log:
 *
 * - `turn/end` with `reason.kind === 'completed'` — the agent finished its
 *   current turn (its response is complete and it is idle again).
 * - `goal/change` with `operation === 'complete'` — a persisted same-session
 *   goal (the agent's long-running task) was completed.
 * - `tool/call` with `name === 'ask_user_question'` — the agent is waiting
 *   for the human to answer a question / make a choice.
 *
 * All three triggers are configurable, debounced, and share one notification
 * backend (`notify-send` on Linux desktops, a custom shell command, or the
 * console). Listener failures are contained so notifications can never break
 * the session.
 *
 * @module dsh-notify
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantMessage, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal' // session event-map augmentation for 'goal/change'
import Schema from '@deepseek-ai/schemastery'
import { Notifier, type NotifyBackend, type NotifyUrgency } from './notify.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'notify'
/** The session store owns the `session/event` firehose this plugin observes. */
export const inject = ['sessions']

export interface Config {
  /**
   * `auto` uses `notify-send` when available and falls back to the console;
   * `command` runs the `command` template through `/bin/sh -c`.
   */
  backend: NotifyBackend
  /** Command template for the `command` backend; `{title}` / `{message}` are substituted. */
  command: string
  /** `notify-send` urgency level. */
  urgency: NotifyUrgency
  /** Display duration in milliseconds for `notify-send`; 0 means "until dismissed". */
  expireMs: number
  /** Prefix prepended to every notification title. */
  titlePrefix: string
  /** Notify when a turn ends normally (the agent finished responding). */
  onTurnComplete: boolean
  /** Notify when a persisted goal completes. */
  onGoalComplete: boolean
  /** Notify when the agent calls `ask_user_question`. */
  onUserQuestion: boolean
  /** When true, only notify for questions that offer selectable options. */
  onlyQuestionsWithChoices: boolean
  /** Maximum characters of assistant preview / objective kept in the message body. */
  previewMaxChars: number
  /** Minimum gap in milliseconds between two notifications of the same kind. */
  debounceMs: number
}

export const Config: Schema<Config> = Schema.object({
  backend: Schema.union(['auto', 'notify-send', 'console', 'command']).default('auto'),
  command: Schema.string().default(''),
  urgency: Schema.union(['low', 'normal', 'critical']).default('normal'),
  expireMs: Schema.number().min(0).default(10000),
  titlePrefix: Schema.string().default('DSH'),
  onTurnComplete: Schema.boolean().default(true),
  onGoalComplete: Schema.boolean().default(true),
  onUserQuestion: Schema.boolean().default(true),
  onlyQuestionsWithChoices: Schema.boolean().default(false),
  previewMaxChars: Schema.number().min(1).default(120),
  debounceMs: Schema.number().min(0).default(1000),
})

/** One parsed question from an `ask_user_question` tool call. */
interface QuestionItem {
  header?: string
  question: string
  options?: string[]
}

/** Per-session bookkeeping: the latest assistant text for turn-complete previews. */
interface SessionState {
  lastAssistantText: string
}

/** Flatten text and reasoning blocks into one plain string. */
function plainText(content: AssistantMessage['content']): string {
  let text = ''
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') text += (block as { text?: string }).text ?? ''
  }
  return text.trim()
}

/** Defensive parse of the `ask_user_question` arguments JSON string. */
function parseQuestions(argumentsJson: string): QuestionItem[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const questions = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return undefined
  const items: QuestionItem[] = []
  for (const entry of questions) {
    if (typeof entry !== 'object' || entry === null) continue
    const question = (entry as { question?: unknown }).question
    if (typeof question !== 'string' || !question.trim()) continue
    const item: QuestionItem = { question }
    const header = (entry as { header?: unknown }).header
    if (typeof header === 'string' && header.trim()) item.header = header
    const options = (entry as { options?: unknown }).options
    if (Array.isArray(options)) {
      const labels = options
        .map((option) => typeof option === 'object' && option !== null
          ? (option as { label?: unknown }).label
          : undefined)
        .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
      if (labels.length > 0) item.options = labels
    }
    items.push(item)
  }
  return items.length > 0 ? items : undefined
}

/** Render parsed questions into one notification body line. */
function renderQuestions(items: QuestionItem[]): string {
  return items.map((item) => {
    const header = item.header ? `${item.header}：` : ''
    const choices = item.options ? `（选项：${item.options.join(' / ')}）` : ''
    return `${header}${item.question}${choices}`
  }).join('；')
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('notify')
  const notifier = new Notifier({
    backend: config.backend,
    command: config.command,
    urgency: config.urgency,
    expireMs: config.expireMs,
    log: (line) => logger.info(line),
  })

  const sessions = new Map<string, SessionState>()
  const lastSentAt = new Map<string, number>()

  logger.info(`[dsh-notify] loaded, backend: ${notifier.backend}`)

  /** Debounced send: at most one notification per kind within `debounceMs`. */
  const send = (kind: string, title: string, message: string) => {
    const now = Date.now()
    const previous = lastSentAt.get(kind)
    if (previous !== undefined && now - previous < config.debounceMs) return
    lastSentAt.set(kind, now)
    notifier.send({ title, message })
  }

  ctx.on('session/disposed', (session) => {
    sessions.delete(session.id)
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // `session/event` fires on the append hot path; a notification problem
    // must never leak into the session, so the whole handler is contained.
    try {
      switch (event.type) {
        case 'assistant/message': {
          const text = plainText(event.data.message.content)
          if (text) sessions.set(session.id, { lastAssistantText: text })
          break
        }
        case 'turn/end': {
          if (!config.onTurnComplete || event.data.reason.kind !== 'completed') break
          const state = sessions.get(session.id)
          const message = state?.lastAssistantText
            ? truncate(state.lastAssistantText, config.previewMaxChars)
            : `第 ${event.data.turn} 轮已完成`
          send('turn', `${config.titlePrefix} · 回答完成`, message)
          break
        }
        case 'goal/change': {
          if (!config.onGoalComplete || event.data.operation !== 'complete') break
          send('goal', `${config.titlePrefix} · 任务完成`, truncate(event.data.goal.objective, config.previewMaxChars))
          break
        }
        case 'tool/call': {
          if (!config.onUserQuestion || event.data.name !== 'ask_user_question') break
          const questions = parseQuestions(event.data.arguments)
          if (!questions) break
          if (config.onlyQuestionsWithChoices && !questions.some((item) => item.options !== undefined)) break
          send('question', `${config.titlePrefix} · 需要你的回答`, truncate(renderQuestions(questions), config.previewMaxChars * 2))
          break
        }
        default:
          break
      }
    } catch (error) {
      logger.warn('notification handler failed:', error)
    }
  })
}
