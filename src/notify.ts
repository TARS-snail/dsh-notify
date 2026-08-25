/**
 * Notification backends for `dsh-notify`: desktop notifications through
 * `notify-send`, an arbitrary user command, or plain console logging.
 *
 * The notifier is deliberately self-contained: it never touches the harness
 * runtime, so the notification path cannot break the session hot path even
 * when spawning fails.
 *
 * @module dsh-notify/notify
 */
import { spawn, spawnSync } from 'node:child_process'

export type NotifyBackend = 'auto' | 'notify-send' | 'console' | 'command'
export type NotifyUrgency = 'low' | 'normal' | 'critical'

/** One outgoing notification. */
export interface Notification {
  title: string
  message: string
}

/** Configuration shared by the Notifier and the plugin's `Config` schema. */
export interface NotifierOptions {
  backend: NotifyBackend
  /**
   * Custom command template for the `command` backend, run through
   * `/bin/sh -c`. The placeholders `{title}` and `{message}` are substituted
   * verbatim — quoting is the command author's responsibility.
   */
  command: string
  urgency: NotifyUrgency
  /** `notify-send` display duration in milliseconds; 0 means "until dismissed". */
  expireMs: number
  /** Sink for console-backend output and diagnostics. */
  log: (line: string) => void
}

const NOTIFY_SEND_BIN = 'notify-send'

/** Whether a command is resolvable through the login shell's PATH. */
function commandAvailable(bin: string): boolean {
  if (process.platform === 'win32') return false
  try {
    const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], {
      stdio: 'ignore',
    })
    return result.status === 0
  } catch {
    return false
  }
}

/** Substitute the `{title}` / `{message}` placeholders in a command template. */
export function renderCommand(template: string, notification: Notification): string {
  return template.split('{title}').join(notification.title)
    .split('{message}').join(notification.message)
}

/** Spawn a fire-and-forget notification process; failures only reach the log. */
function spawnDetached(command: string, args: string[], log: (line: string) => void): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.on('error', (error) => {
      log(`[dsh-notify] failed to spawn ${command}: ${String(error?.message ?? error)}`)
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4096) stderr = stderr.slice(-4096)
    })
    child.on('close', (code) => {
      if (code !== 0) log(`[dsh-notify] ${command} exited ${code}: ${stderr.trim().split(/\r?\n/).pop() ?? ''}`)
    })
    child.unref()
  } catch (error) {
    log(`[dsh-notify] failed to spawn ${command}: ${String(error)}`)
  }
}

/**
 * Deliver notifications through the configured backend.
 *
 * `auto` prefers `notify-send` and degrades to console output when the binary
 * is missing (e.g. a headless server), so the plugin is always installable.
 */
export class Notifier {
  /** Effective backend after `auto` resolution. */
  readonly backend: Exclude<NotifyBackend, 'auto'>
  readonly command: string
  readonly urgency: NotifyUrgency
  readonly expireMs: number
  private readonly log: (line: string) => void
  private readonly notifySendAvailable: boolean

  constructor(options: NotifierOptions) {
    this.command = options.command
    this.urgency = options.urgency
    this.expireMs = options.expireMs
    this.log = options.log
    this.notifySendAvailable = commandAvailable(NOTIFY_SEND_BIN)
    if (options.backend === 'auto') {
      if (this.notifySendAvailable) {
        this.backend = 'notify-send'
      } else {
        this.log('[dsh-notify] notify-send not found — falling back to console notifications')
        this.backend = 'console'
      }
    } else {
      this.backend = options.backend
    }
  }

  send(notification: Notification): void {
    switch (this.backend) {
      case 'console':
        this.log(`[dsh-notify] ${notification.title} | ${notification.message}`)
        return
      case 'notify-send':
        if (!this.notifySendAvailable) {
          this.log(`[dsh-notify] notify-send unavailable — ${notification.title} | ${notification.message}`)
          return
        }
        spawnDetached(NOTIFY_SEND_BIN, [
          '--app-name', 'DeepSeek Harness',
          '--urgency', this.urgency,
          '--expire-time', String(Math.max(0, Math.floor(this.expireMs))),
          notification.title,
          notification.message,
        ], this.log)
        return
      case 'command': {
        const template = this.command.trim()
        if (!template) {
          this.log('[dsh-notify] backend "command" needs a non-empty command template — notification dropped')
          return
        }
        spawnDetached('sh', ['-c', renderCommand(template, notification)], this.log)
        return
      }
    }
  }
}
