export const redactedText = "[REDACTED]";

const maxDepth = 6;
const maxEntries = 50;
const maxStringLength = 512;

/** Normalized key fragments that mark a value as sensitive. */
const deniedKeyParts = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "apikey",
  "credential",
  "privatekey"
] as const;

/** Normalized keys that look sensitive but are safe operational values. */
const safeKeys: ReadonlySet<string> = new Set(["fencingtoken"]);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

export const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (safeKeys.has(normalized)) return false;
  return deniedKeyParts.some((part) => normalized.includes(part));
};

/** Removes credentials embedded in free text (error messages, provider responses). */
export const scrubText = (text: string): string => {
  const scrubbed = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${redactedText}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, redactedText)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${redactedText}@`)
    .replace(
      /\b(authorization|cookie|token|secret|password|api[_-]?key)\b(\s*[=:]\s*)[^\s,;&"']+/gi,
      `$1$2${redactedText}`
    );
  return scrubbed.length > maxStringLength ? `${scrubbed.slice(0, maxStringLength)}...` : scrubbed;
};

export type RedactedError = Readonly<{
  name: string;
  message: string;
  code?: string;
}>;

/** Never includes the stack: stacks can embed argument values. */
export const redactError = (error: Error): RedactedError => {
  const code: unknown = (error as Error & { code?: unknown }).code;
  return Object.freeze({
    name: scrubText(error.name),
    message: scrubText(error.message),
    ...(typeof code === "string" ? { code: scrubText(code) } : {})
  });
};

export const redactValue = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";
  if (value instanceof Error) return redactError(value);
  if (depth >= maxDepth) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.slice(0, maxEntries).map((item) => redactValue(item, depth + 1));
  }
  const entries: readonly (readonly [string, unknown])[] = Object.entries(value);
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, child] of entries) {
    if (key === "__proto__") continue;
    if (count >= maxEntries) {
      output["..."] = "[TRUNCATED]";
      break;
    }
    count += 1;
    output[key] = isSensitiveKey(key) ? redactedText : redactValue(child, depth + 1);
  }
  return output;
};