/**
 * JSON-aware string transformation for tool-call arguments.
 *
 * Tool-call `arguments` travel as a raw JSON string. Masking or restoring
 * text inside the SERIALIZED form is wrong twice over: a value containing
 * JSON-special characters (`"`, `\`, newline) is escaped in transit, so a
 * detector sees `\"` and misses the real value entirely — and a restored
 * real value with special characters would need re-escaping by hand. Parsing
 * first and transforming each decoded string value fixes both: detectors see
 * the clean value, and JSON.stringify re-escapes whatever the transform
 * produced. V8 preserves object key order across the round trip.
 *
 * Returns the ORIGINAL string when no transformed value changed — untouched
 * arguments stay byte-identical (number lexemes like `1e2` and duplicate
 * keys are never normalized unless masking actually happened). Returns
 * undefined only when the input is not valid JSON; callers fall back to
 * plain-text transformation over the raw string.
 */
export function transformJsonStrings(
  raw: string,
  transform: (value: string) => string,
): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  let changed = false
  const walked = walk(parsed, (value) => {
    const out = transform(value)
    if (out !== value) changed = true
    return out
  })
  return changed ? JSON.stringify(walked) : raw
}

function walk(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => walk(item, transform))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, transform)
    return out
  }
  return value
}
