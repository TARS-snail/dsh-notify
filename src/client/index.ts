/**
 * `dsh-notify` client half: reports user presence to the host so the host
 * only notifies when the user is NOT currently looking at the session.
 *
 * "In the session" means: the page is the browser's current tab
 * (`document.visibilityState === 'visible'`) AND the window has focus.
 * Switching to another tab, another application, or minimizing the window
 * all count as away — the user asked for notifications in every one of
 * those states.
 *
 * Reports carry the currently selected session (`ctx.sessions.list.current`)
 * plus visibility, are throttled, change-triggered, and heartbeated, so the
 * host can expire a vanished tab instead of being muted by it forever.
 *
 * This file must stay import-free: the client bundle ships as a lazy CJS
 * factory and its purity gate rejects unresolvable requests.
 *
 * @module dsh-notify/client
 */

export const name = 'notify-client'
export const inject = ['connection', 'sessions']

interface RpcLike {
  call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
}

interface SessionsListLike {
  getSnapshot(): { current?: string | null }
  subscribe(listener: () => void): () => void
}

interface ClientContext {
  connection: { rpc: RpcLike }
  sessions: { list: SessionsListLike }
  /** Cordis effect: the returned disposer runs on unload. */
  effect(callback: () => (() => void) | void): void
}

/** Heartbeat cadence: keeps the host-side presence entry fresh. */
const HEARTBEAT_MS = 15000
/** Minimum gap between network reports; the trailing state still gets sent. */
const THROTTLE_MS = 1000

/** Fallback id for browsers without `crypto.randomUUID` (non-secure contexts). */
function mintClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function apply(ctx: ClientContext): void {
  // The client half only ever runs in the web shell; still, never assume.
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  const clientId = mintClientId()
  let lastSignature: string | null = null
  let lastSentAt = 0
  let trailing: ReturnType<typeof setTimeout> | undefined

  const isVisible = () => document.visibilityState === 'visible' && document.hasFocus()

  const snapshot = () => {
    const current = ctx.sessions.list.getSnapshot().current
    return {
      clientId,
      sessionId: current === undefined || current === null ? null : String(current),
      visible: isVisible(),
    }
  }

  const send = (force = false) => {
    const payload = snapshot()
    const signature = `${payload.sessionId}|${payload.visible}`
    // Change-driven reports skip duplicate state; heartbeats force a refresh
    // so the host-side TTL keeps counting an idle-but-attending tab as alive.
    if (!force && signature === lastSignature) return
    lastSignature = signature
    void ctx.connection.rpc.call('/dsh-notify', 'presence', payload).catch(() => {
      // Transport failures are fine: the host expires stale entries on its own.
    })
  }

  /** Throttled report; the final state is always delivered via `trailing`. */
  const report = () => {
    const now = Date.now()
    if (now - lastSentAt >= THROTTLE_MS) {
      lastSentAt = now
      send()
      return
    }
    if (trailing !== undefined) clearTimeout(trailing)
    trailing = setTimeout(() => {
      trailing = undefined
      lastSentAt = Date.now()
      send()
    }, THROTTLE_MS - (now - lastSentAt))
  }

  /** Last-chance report on page teardown: mark this tab gone, bypass throttle. */
  const reportHidden = () => {
    lastSignature = null
    lastSentAt = 0
    if (trailing !== undefined) {
      clearTimeout(trailing)
      trailing = undefined
    }
    // force visible:false even though visibilityState may still read 'visible'.
    const current = ctx.sessions.list.getSnapshot().current
    void ctx.connection.rpc.call('/dsh-notify', 'presence', {
      clientId,
      sessionId: current === undefined || current === null ? null : String(current),
      visible: false,
    }).catch(() => {})
  }

  document.addEventListener('visibilitychange', report)
  window.addEventListener('pageshow', report)
  window.addEventListener('pagehide', reportHidden)
  window.addEventListener('blur', report)
  window.addEventListener('focus', report)

  const unsubscribe = ctx.sessions.list.subscribe(report)
  const heartbeat = setInterval(() => send(true), HEARTBEAT_MS)

  // Fire the first report immediately so the host knows we exist.
  report()

  ctx.effect(() => () => {
    if (trailing !== undefined) clearTimeout(trailing)
    clearInterval(heartbeat)
    unsubscribe()
    document.removeEventListener('visibilitychange', report)
    window.removeEventListener('pageshow', report)
    window.removeEventListener('pagehide', reportHidden)
    window.removeEventListener('blur', report)
    window.removeEventListener('focus', report)
  })
}
