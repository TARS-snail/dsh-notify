/**
 * User-presence state for `dsh-notify`: which browser clients are currently
 * displaying which session, and whether the page is visible to the user.
 *
 * The browser half reports `{ clientId, sessionId, visible }` over the
 * `/dsh-notify` RPC channel; this host-side store keeps the latest report per
 * client and expires entries that stopped reporting (a tab that crashed or
 * lost its connection must never suppress notifications forever).
 *
 * Pure logic, no harness imports — unit-testable in isolation.
 *
 * @module dsh-notify/presence
 */
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Presence store provided by the main `dsh-notify` plugin. */
    presence: PresenceStore
  }
}

/** One presence report arriving from a browser client. */
export interface PresenceReport {
  /** Per-page random id minted by the client half. */
  clientId: string
  /** The session the page is currently displaying, or null when none is selected. */
  sessionId: string | null
  /** `document.visibilityState === 'visible'` at report time. */
  visible: boolean
}

interface ClientEntry {
  sessionId: string | null
  visible: boolean
  updatedAt: number
}

const CLIENT_ID_MAX_LENGTH = 128
const SESSION_ID_MAX_LENGTH = 256

/** Validate one wire payload; throws a descriptive TypeError on malformed input. */
export function parsePresenceReport(payload: unknown): PresenceReport {
  if (typeof payload !== 'object' || payload === null) throw new TypeError('payload must be an object')
  const { clientId, sessionId, visible } = payload as Record<string, unknown>
  if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > CLIENT_ID_MAX_LENGTH) {
    throw new TypeError('clientId must be a non-empty string (max 128 chars)')
  }
  if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > SESSION_ID_MAX_LENGTH)) {
    throw new TypeError('sessionId must be a non-empty string or null')
  }
  if (typeof visible !== 'boolean') throw new TypeError('visible must be a boolean')
  return { clientId, sessionId, visible }
}

/**
 * Latest-presence-per-client store with TTL-based pruning.
 *
 * A session is "attended" when at least one client reports it as the
 * currently displayed session AND that client's page is visible. Heartbeat
 * reports keep entries fresh; entries older than `ttlMs` are dropped on the
 * next read, so a vanished tab degrades to "away" instead of muting forever.
 */
export class PresenceStore {
  private readonly clients = new Map<string, ClientEntry>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Upsert one validated report. */
  report(report: PresenceReport): void {
    this.clients.set(report.clientId, {
      sessionId: report.sessionId,
      visible: report.visible,
      updatedAt: this.now(),
    })
  }

  /** Whether any live client currently displays `sessionId` on a visible page. */
  isAttended(sessionId: string): boolean {
    const cutoff = this.now() - this.ttlMs
    for (const [clientId, entry] of this.clients) {
      if (entry.updatedAt < cutoff) {
        this.clients.delete(clientId)
        continue
      }
      if (entry.visible && entry.sessionId === sessionId) return true
    }
    return false
  }

  /** Number of live client entries (diagnostics/tests). */
  size(): number {
    this.isAttended('\u0000never') // prune pass
    return this.clients.size
  }
}
