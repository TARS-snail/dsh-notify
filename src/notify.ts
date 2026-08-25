/**
 * Notification backends for `dsh-notify`: desktop notifications through
 * `notify-send`, an arbitrary user command, or plain console logging, plus
 * the system's default notification sound.
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
  /** Play the system's default notification sound alongside real notifications. */
  playSound: boolean
  /** Sink for console-backend output and diagnostics. */
  log: (line: string) => void
}

const NOTIFY_SEND_BIN = 'notify-send'
/** Freedesktop sound-theme file played when no theme-aware player exists. */
const DEFAULT_SOUND_FILE = '/usr/share/sounds/freedesktop/stereo/message.oga'

/** One resolved sound player: the command plus its fixed arguments. */
interface SoundPlayer {
  command: string
  args: string[]
}

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

/** Pick the first available sound player; undefined when none exists. */
function resolveSoundPlayer(): SoundPlayer | undefined {
  if (process.platform === 'win32') return undefined
  if (commandAvailable('canberra-gtk-play')) {
    // libcanberra plays the sound-theme sound by id — the true "system default".
    return { command: 'canberra-gtk-play', args: ['-i', 'message'] }
  }
  for (const command of ['pw-play', 'paplay']) {
    if (commandAvailable(command)) return { command, args: [DEFAULT_SOUND_FILE] }
  }
  return undefined
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
 * Sound accompanies desktop deliveries (`notify-send` / `command`) only —
 * console output is a logging fallback, not a user-facing popup.
 */
export class Notifier {
  /** Effective backend after `auto` resolution. */
  readonly backend: Exclude<NotifyBackend, 'auto'>
  readonly command: string
  readonly urgency: NotifyUrgency
  readonly expireMs: number
  private readonly playSound: boolean
  private readonly log: (line: string) => void
  private readonly notifySendAvailable: boolean
  private readonly soundPlayer: SoundPlayer | undefined
  private soundMissingLogged = false

  constructor(options: NotifierOptions) {
    this.command = options.command
    this.urgency = options.urgency
    this.expireMs = options.expireMs
    this.playSound = options.playSound
    this.log = options.log
    this.notifySendAvailable = commandAvailable(NOTIFY_SEND_BIN)
    this.soundPlayer = resolveSoundPlayer()
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
        this.play()
        return
      case 'command': {
        const template = this.command.trim()
        if (!template) {
          this.log('[dsh-notify] backend "command" needs a non-empty command template — notification dropped')
          return
        }
        spawnDetached('sh', ['-c', renderCommand(template, notification)], this.log)
        this.play()
        return
      }
    }
  }

  /** Play the system default notification sound once per sent notification. */
  private play(): void {
    if (!this.playSound) return
    const player = this.soundPlayer
    if (player === undefined) {
      if (!this.soundMissingLogged) {
        this.log('[dsh-notify] no sound player found (tried canberra-gtk-play / pw-play / paplay) — notifications stay silent')
        this.soundMissingLogged = true
      }
      return
    }
    spawnDetached(player.command, player.args, this.log)
  }
}
