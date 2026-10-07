import { resolveOptions } from './options.js'

/** The SDK's warning for a `canUseTool` that bare MCP names in `allowedTools` shadow. */
export const SHADOWED_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

/** The `process` key that marks the filter as installed, shared by every copy of the package. */
const INSTALLED = Symbol.for('agent-sdk-watchdog.sdkWarningFilter')

export interface WarningFilterOptions {
  /** The warning codes to swallow. */
  codes?: readonly string[]
  /** Called with the first warning of each code, and the code. A throw here is dropped. */
  onFirst?: (warning: string | Error, code: string) => void
}

export const WARNING_FILTER_DEFAULTS: Readonly<Required<WarningFilterOptions>> = Object.freeze({
  codes: Object.freeze([SHADOWED_CODE]),
  onFirst: () => {},
})

/**
 * Swallow the warnings whose code is in `codes` and call `onFirst` with the first one of each
 * code, once per process. Every other warning goes to Node untouched. This wraps
 * `process.emitWarning`, because a `'warning'` listener cannot stop Node's own print. Handles
 * both signatures, `(warning, { code })` and `(warning, type, code, ctor)`.
 *
 * Returns `true` when this call installed the filter. A later call changes nothing and returns
 * `false`: its options never apply.
 */
export function installSdkWarningFilter(options: WarningFilterOptions = {}): boolean {
  const { codes, onFirst } = resolveOptions(WARNING_FILTER_DEFAULTS, options)
  const proc = process as NodeJS.Process & { [INSTALLED]?: true }
  if (proc[INSTALLED]) return false
  proc[INSTALLED] = true
  const original = process.emitWarning.bind(process)
  const swallowed = new Set(codes)
  const seen = new Set<string>()
  const filtered = (
    warning: string | Error,
    typeOrOptions?: string | { code?: string } | ((...args: never[]) => unknown),
    code?: string | ((...args: never[]) => unknown),
    ctor?: (...args: never[]) => unknown,
  ): void => {
    const found =
      typeof typeOrOptions === 'object' && typeOrOptions !== null
        ? typeOrOptions.code
        : typeof code === 'string'
          ? code
          : undefined
    if (found !== undefined && swallowed.has(found)) {
      if (!seen.has(found)) {
        seen.add(found)
        try {
          onFirst(warning, found)
        } catch {
          // dropped: this runs inside the caller's `emitWarning`, often the SDK's own
        }
      }
      return
    }
    ;(original as (...args: unknown[]) => void)(warning, typeOrOptions, code, ctor)
  }
  process.emitWarning = filtered as typeof process.emitWarning
  return true
}
