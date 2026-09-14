import type { AnyParamValue, ParamSpec, ParamSpecs, ParamValues, SignalSpecs, SignalValues } from './types';

/** Default values for a param spec. */
export function defaultParams<P extends ParamSpecs>(specs: P): ParamValues<P> {
  const out: Record<string, AnyParamValue> = {};
  for (const [name, spec] of Object.entries(specs)) out[name] = spec.default;
  return out as ParamValues<P>;
}

/**
 * Coerce an untrusted value into a valid value for `spec`, or return undefined
 * when it cannot be interpreted. Numbers are clamped and snapped to `step`.
 */
export function coerceParam(spec: ParamSpec, value: unknown): AnyParamValue | undefined {
  switch (spec.kind) {
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      let v = Math.min(spec.max, Math.max(spec.min, n));
      // toFixed strips the float noise of step arithmetic (0.1 * 3 = 0.30000000000000004) before it is persisted.
      if (spec.step && spec.step > 0) v = Number((spec.min + Math.round((v - spec.min) / spec.step) * spec.step).toFixed(10));
      return Math.min(spec.max, Math.max(spec.min, v));
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      return undefined;
    case 'select':
      return typeof value === 'string' && spec.options.includes(value) ? value : undefined;
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
  }
}

/** Merge stored overrides onto defaults, dropping anything that does not validate. */
export function resolveParams<P extends ParamSpecs>(specs: P, overrides: Record<string, unknown> | undefined): ParamValues<P> {
  const values = defaultParams(specs) as Record<string, AnyParamValue>;
  if (overrides) {
    for (const [name, raw] of Object.entries(overrides)) {
      const spec = specs[name];
      if (!spec) continue;
      const v = coerceParam(spec, raw);
      if (v !== undefined) values[name] = v;
    }
  }
  return values as ParamValues<P>;
}

/** Clamp signals into their declared ranges. Returns the names that were out of range. */
export function clampSignals<S extends SignalSpecs>(specs: S, values: SignalValues<S>): { values: SignalValues<S>; violations: string[] } {
  const out: Record<string, number> = {};
  const violations: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const raw = (values as Record<string, number>)[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) { out[name] = spec.min; violations.push(`${name}=${String(raw)}`); continue; }
    if (raw < spec.min || raw > spec.max) violations.push(`${name}=${raw.toFixed(3)}`);
    out[name] = Math.min(spec.max, Math.max(spec.min, raw));
  }
  return { values: out as SignalValues<S>, violations };
}

/** Parse a `#rrggbb` color into linear-ish 0..1 components (no gamma conversion). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
