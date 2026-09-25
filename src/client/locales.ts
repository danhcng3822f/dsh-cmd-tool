/**
 * Locale namespace for the `cmd` tool's keyed row.
 *
 * A third-party toolview owns its own copy rather than borrowing the
 * conversation namespace, whose dictionary is not importable from outside
 * `dsh-client-ui-tool`. The terminal strings are copied verbatim from that
 * dictionary so the card this row draws reads identically to the `bash` and
 * `pwsh` rows beside it — `TerminalBlock`'s own built-in defaults are Chinese,
 * so omitting `labels` would silently mix languages into an English UI.
 *
 * @module dsh-cmd-tool/client/locales
 */

/** This row's locale namespace. */
export const NS = 'cmd-tool'

/** English dictionary. */
export const en = {
  'row.title': 'Cmd',
  'row.running': 'Running',
  'row.failed': 'Failed',
  'row.stopped': 'Stopped',
  'terminal.signal': 'signal {signal}',
  'terminal.exitCode': 'exit code {code}',
  'terminal.running': 'Running',
  'terminal.failed': 'Failed',
  'terminal.done': 'Done',
  'terminal.noOutput': 'No output',
  'terminal.collapseAria': 'Collapse output',
  'terminal.collapse': 'Collapse',
  'terminal.expandAria': 'Expand the remaining {n} output lines',
  'terminal.expandRest': '… {n} more lines',
  'copy': 'Copy',
  'copied': 'Copied',
  'inspect': 'Inspect',
} as const

/** One translatable key of this namespace. */
export type CmdKey = keyof typeof en

/** Chinese dictionary, matching the conversation namespace's wording. */
export const zh: Record<CmdKey, string> = {
  'row.title': 'Cmd',
  'row.running': '运行中',
  'row.failed': '失败',
  'row.stopped': '已停止',
  'terminal.signal': '信号 {signal}',
  'terminal.exitCode': '退出码 {code}',
  'terminal.running': '运行中',
  'terminal.failed': '失败',
  'terminal.done': '已完成',
  'terminal.noOutput': '无输出',
  'terminal.collapseAria': '收起输出',
  'terminal.collapse': '收起',
  'terminal.expandAria': '展开其余 {n} 行输出',
  'terminal.expandRest': '… 其余 {n} 行',
  'copy': '复制',
  'copied': '复制成功',
  'inspect': 'Inspect',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The `cmd` tool row's copy. */
    'cmd-tool': CmdKey
  }
}
