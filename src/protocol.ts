/**
 * The one fact shared by the `cmd` tool and the executor that runs it.
 *
 * The tool cannot hand `cmd.exe` a command line: `cmd.exe` re-parses its own
 * command line with rules that are incompatible with the CRT quoting Node and
 * the Windows ACL runner both apply, so quotes reach it mangled. The tool
 * therefore writes the command to a temporary `.cmd` file and sends this
 * marker plus the file path as the `command`; the executor strips the marker
 * and runs `cmd.exe /d /c <path>`, letting `cmd.exe` read the text verbatim
 * from disk.
 *
 * The marker is an internal protocol between the two entries of this package.
 * It must never reach the model: the tool supplies its own job label, call
 * card, and rendered output from the user's real command text.
 *
 * @module dsh-cmd-tool/protocol
 */

/** Prefix marking a `ctx.shell` command as "run this script file with cmd.exe". */
export const CMD_SCRIPT_MARKER = 'dsh-cmd-script:'

/**
 * Wrap a written script's path as the `command` the executor dispatches on.
 * @param scriptPath - absolute path of the temporary `.cmd` file.
 * @returns the marked command string.
 */
export function markScriptCommand(scriptPath: string): string {
  return CMD_SCRIPT_MARKER + scriptPath
}

/**
 * Recover the script path from a marked command.
 * @param command - a `ctx.shell` command string.
 * @returns the script path, or `undefined` when this is an ordinary command
 *   that must keep the executor's inherited dialect.
 */
export function scriptPathOf(command: string): string | undefined {
  return command.startsWith(CMD_SCRIPT_MARKER) ? command.slice(CMD_SCRIPT_MARKER.length) : undefined
}
