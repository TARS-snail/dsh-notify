/**
 * `dsh-notify/rpc`: the transport half of presence tracking. Registers one
 * logical RPC channel (`/dsh-notify`) on the web Connection service and feeds
 * validated browser reports into the `presence` store provided by the main
 * `dsh-notify` plugin.
 *
 * Keeping this in a separate plugin row lets the bundle work in profiles
 * without the Connection service (headless, tui): the row simply parks until
 * `connection` appears, while notifications keep working with an empty
 * presence store (always "away" → always notify).
 *
 * @module dsh-notify/rpc
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection' // Context.connection augmentation
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { parsePresenceReport, type PresenceStore } from './presence.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'notify-rpc'
/** Connection provides the transport; presence comes from the main plugin. */
export const inject = ['connection', 'presence']

export const CHANNEL = '/dsh-notify'
export const PRESENCE_ENDPOINT = 'presence'

export function apply(ctx: Context): void {
  const presence: PresenceStore = ctx.presence

  const handler = async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    if (endpoint !== PRESENCE_ENDPOINT) {
      return {
        ok: false,
        error: { code: 'bad-request', message: `unknown endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } },
      }
    }
    try {
      presence.report(parsePresenceReport(payload))
      return { ok: true, value: null }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `invalid presence report: ${String(error)}`,
          details: { issues: [] },
        },
      }
    }
  }

  // Loopback authority: only the browser on this machine may report presence.
  ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' })
}
