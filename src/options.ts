/** `defaults` overlaid with every key of `config` whose value is not `undefined`, frozen. */
export function resolveOptions<T extends object>(
  defaults: Readonly<Required<T>>,
  config: T,
): Readonly<Required<T>> {
  const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
  return Object.freeze(Object.assign({ ...defaults }, given))
}

/**
 * Returns `value`. Throws a `RangeError` that names the option, the allowed range and the value
 * unless `value` is a finite number that passes `ok`.
 */
export function checkOption(
  name: string,
  value: number,
  range: string,
  ok: (v: number) => boolean,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !ok(value)) {
    throw new RangeError(`${name} must be ${range}, got ${String(value)}`)
  }
  return value
}
