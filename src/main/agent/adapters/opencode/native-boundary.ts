export type NativeBoundaryKind = 'created' | 'turn-start' | 'idle' | 'error';

export type NativeBoundary = {
  readonly kind: NativeBoundaryKind;
  readonly nativeSessionId: string | null;
  readonly occurredAt: number;
};

type JsonRecord = { readonly [key: string]: unknown };

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNativeBoundaryKind(value: unknown): value is NativeBoundaryKind {
  return value === 'created'
    || value === 'turn-start'
    || value === 'idle'
    || value === 'error';
}

export function parseOpenCodeNativeBoundary(line: string): NativeBoundary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isJsonRecord(parsed)) return null;
  const candidate = parsed.privateNativeBoundary;
  if (!isJsonRecord(candidate)) return null;
  const { kind, nativeSessionId, occurredAt } = candidate;
  if (!isNativeBoundaryKind(kind)) return null;
  if (nativeSessionId !== null && typeof nativeSessionId !== 'string') return null;
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
  return { kind, nativeSessionId, occurredAt };
}
