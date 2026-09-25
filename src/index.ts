/**
 * Package root: the model-facing `cmd` tool.
 *
 * This module exists for one structural reason. `dsh-client-modules` discovers
 * a browser half by walking the host Loader's entries and resolving each
 * entry's `name` as a PACKAGE ROOT — a subpath entry such as
 * `dsh-cmd-tool/tool` never resolves, and its package is then permanently
 * treated as having no client row (`packages/client/modules/src/index.ts`,
 * `resolveMeta`). The `dsh.client` declaration this package carries is
 * therefore only visible while the package is mounted by its bare name, which
 * is also what every other dual-face package does (`dsh-web-search-ext`,
 * `dsh-archived-chats`, `dsh-upload-plugin`).
 *
 * So the tool is the package root and the executor stays a subpath entry: one
 * row mounts the tool by name, another mounts `dsh-cmd-tool/executor`. The
 * re-export keeps the tool's own module the single definition — this file adds
 * no behavior.
 *
 * @module dsh-cmd-tool
 */

export * from './tool.ts'
