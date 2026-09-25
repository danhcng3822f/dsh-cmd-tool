/**
 * Browser half of `dsh-cmd-tool`.
 *
 * Registers the `cmd` keyed toolview so the Web client renders the tool as the
 * shell row it is — "Cmd · {description}" with the call's terminal card —
 * instead of the generic "Tool call" row an unlisted tool name falls back to.
 * See {@link ./CmdRow.tsx} for why the row is composed from platform modules
 * only.
 *
 * @module dsh-cmd-tool/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CmdRow } from './CmdRow.tsx'
import { NS, en, zh } from './locales.ts'

/**
 * Required client services: the keyed-slot registry and the locale registry.
 * The slot itself is DECLARED by `@deepseek-ai/dsh-client-ui-tool`, which the
 * manifest's `dsh.client.inject` list mounts first.
 */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register this row's dictionaries and its keyed toolview.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-cmd-tool: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'cmd', locale: NS },
    CmdRow,
  ))
}
