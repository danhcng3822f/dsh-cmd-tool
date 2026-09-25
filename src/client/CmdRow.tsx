/**
 * The `cmd` tool's keyed toolview: the shell row the `bash` and `pwsh` tools
 * get, titled "Cmd".
 *
 * Why this exists at all: the Web client classifies a tool row by a table
 * private to `dsh-client-ui-tool` (`TOOL_VARIANTS` / `TOOL_TITLES`). An
 * unlisted tool falls to the `others` variant, whose title is the literal
 * "Tool call" — and because `GenericToolCard` prefers the terminal view's
 * description over the args-derived summary, the tool's own name never reaches
 * the row either. The designed remedy is the keyed `tool.call.toolview` seat:
 * a registered key REPLACES the generic row.
 *
 * This is a third-party registrant, so it composes the row from platform
 * modules only (`@deepseek-ai/dsh-client-ui-primitives` +
 * `@deepseek-ai/dsh-client-ui-slots`) and never imports `dsh-client-ui-tool`'s
 * internals — the shell's shared module table does not expose them.
 *
 * Styling is inline rather than a CSS module on purpose: the client bundle is
 * built by esbuild into a single closure factory, and a CSS import would emit a
 * sibling stylesheet nothing loads. The row chrome (leading slot, title,
 * chevron, layout) comes from `DisclosureRow`, whose own styles ship with the
 * shell; only the summary fragment and the card margin are ours.
 *
 * @module dsh-cmd-tool/client/CmdRow
 */

import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import {
  DisclosureRow, IconApiOutline14, IconInspectOutline12, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels, TerminalBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { NS } from './locales.ts'

/** This row's props: the toolview runtime share plus its own locale seat. */
type CmdRowProps = ToolCallViewProps & PropsLocale<typeof NS>

/** The four row states the leading slot and aria label distinguish. */
type RowState = 'running' | 'ok' | 'error' | 'stopped'

/**
 * Terminal-card material derived from the call/result view pair, or null when
 * this call declared no terminal intent (a background start, or an error result
 * the tool presented as a generic card).
 */
interface TerminalMaterial {
  description: string | undefined
  card: Omit<TerminalBlockProps, 'labels' | 'maxLines' | 'className'>
}

/**
 * Resolve a view's cwd against the session workspace root. `dsh-client-runtime`
 * owns the canonical helper but is not a shared platform module, so this row
 * carries its own: an absent or empty view cwd IS the workspace, an absolute
 * one stands alone, and anything else is workspace-relative.
 */
function resolveCwd(cwd: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '' || isAbsolute(cwd)) return cwd
  return `${sessionCwd.replace(/[\\/]+$/, '')}\\${cwd}`
}

/** Whether a path is rooted: a Windows drive/UNC form or a leading separator. */
function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|[\\/])/.test(path)
}

/**
 * Derive the terminal card from the frozen call slice, mirroring
 * `terminalCardModel`'s contract: the call side supplies the command and cwd,
 * the result side the output and exit status, and a settled call whose result
 * view is not a terminal card belongs on the generic path.
 */
function terminalMaterial(
  block: ToolCallViewProps['block'],
  sessionCwd: string | undefined,
): TerminalMaterial | null {
  const call = block.callView?.card === 'terminal' ? block.callView : null
  if (!('kind' in block)) {
    if (call === null) return null
    return {
      description: call.description,
      card: { command: call.title, cwd: resolveCwd(call.cwd, sessionCwd), running: true },
    }
  }
  const result = block.resultView?.card === 'terminal' ? block.resultView : null
  if (result === null) return null
  return {
    description: call?.description,
    card: {
      // The result's title replaces the pending one when the tool supplies it.
      command: result.title ?? call?.title ?? '',
      cwd: call === null ? undefined : resolveCwd(call.cwd, sessionCwd),
      output: result.output,
      exitCode: result.exitCode,
      signal: result.signal,
      running: false,
    },
  }
}

/** A non-zero exit or a signal is the card's own failure signal. */
function terminalFailed(card: TerminalMaterial['card']): boolean {
  return card.signal !== undefined || (card.exitCode !== undefined && card.exitCode !== 0)
}

/** Terminal display copy from this row's namespace, matching the shell rows. */
function terminalLabels(t: CmdRowProps['t']): TerminalBlockLabels {
  return {
    signal: signal => t('terminal.signal', { signal }),
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('terminal.collapse'),
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    expand: hidden => t('terminal.expandRest', { n: hidden }),
  }
}

/** Leading slot: the state dot replaces the tool icon on a failed or stopped row. */
function leadingFor(state: RowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconApiOutline14 size={14} />
  }
}

/** Visually hidden run-state text: the dot and the icon are both colour-only. */
function stateStatus(state: RowState, t: CmdRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/** Flatten settled result content to display text (text blocks verbatim). */
function resultText(block: ToolCallViewProps['block']): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  for (const content of block.content) {
    parts.push(content.type === 'text' ? content.text : JSON.stringify(content, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

const summaryStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 14,
  lineHeight: '24px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const errorSummaryStyle: CSSProperties = {
  ...summaryStyle,
  color: 'var(--dsw-alias-state-error-primary)',
}

const separatorStyle: CSSProperties = {
  flex: 'none',
  width: 2,
  height: 2,
  borderRadius: 1,
  margin: '0 8px',
  background: 'var(--dsw-alias-label-caption)',
}

const terminalStyle: CSSProperties = {
  margin: '4px 0 4px 4px',
  border: '1px solid var(--dsw-alias-border-l1)',
}

const bodyWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column' }

const inspectStyle: CSSProperties = {
  display: 'inline-flex',
  alignSelf: 'flex-start',
  alignItems: 'center',
  gap: 4,
  margin: '4px 0 2px 4px',
  padding: '2px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
}

const visuallyHiddenStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

const ioStyle: CSSProperties = {
  margin: '4px 0 4px 4px',
  padding: '12px 16px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 12,
  background: 'var(--dsw-alias-markdown-code-block)',
  font: 'var(--dsw-font-markdown-code-block-small)',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 150,
  overflowY: 'auto',
}

/**
 * The `cmd` row: "Cmd · {description}", expanding to the call's terminal card.
 * @param props - the toolview owner payload and this row's locale seat.
 * @returns the row.
 */
export function CmdRow({ block, sessionId, useSessions, inspect, t }: CmdRowProps) {
  const [expanded, setExpanded] = useState(false)
  // The terminal view's cwd resolves against the session workspace root, which
  // the pure derivation cannot know.
  const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd)
  const terminal = terminalMaterial(block, sessionCwd)
  const settled = 'kind' in block
  const base: RowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const state: RowState = base === 'ok' && terminal !== null && terminalFailed(terminal.card) ? 'error' : base
  // The description is the row's readable summary; the generic path falls back
  // to the call title (our background and error cards carry the command there).
  const summary = terminal?.description ?? block.callView?.title ?? ''
  const fallbackBody = terminal === null ? resultText(block) : ''
  const expandable = terminal !== null || fallbackBody !== ''
  const open = expanded && expandable
  const status = stateStatus(state, t)
  const toggle = (): void => { setExpanded(value => !value) }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }
  return (
    <div style={{ position: 'relative', minWidth: 0 }} data-cmd-row data-state={state}>
      {status !== null && <span style={visuallyHiddenStyle}>{status}</span>}
      <DisclosureRow
        icon={leadingFor(state)}
        title={t('row.title')}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggle}
        collapsedContent={summary !== '' && (
          <>
            <span style={separatorStyle} aria-hidden />
            <span style={state === 'error' ? errorSummaryStyle : summaryStyle}>{summary}</span>
          </>
        )}
      >
        <div style={bodyWrapStyle} onKeyDown={toggleFromKeyboard}>
          {terminal !== null && (
            <TerminalBlock
              {...terminal.card}
              maxLines={Infinity}
              labels={terminalLabels(t)}
              className="dsh-cmd-terminal"
            />
          )}
          {terminal === null && fallbackBody !== '' && <pre style={ioStyle}>{fallbackBody}</pre>}
          {inspect !== undefined && (
            <button type="button" style={inspectStyle} onClick={inspect}>
              <IconInspectOutline12 />
              {t('inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
