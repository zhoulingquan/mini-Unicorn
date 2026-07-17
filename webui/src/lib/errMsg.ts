/**
 * Safely extract a human-readable message from a thrown value.
 *
 * Replaces the repeated `(e as Error).message` pattern across the codebase.
 * Falls back to `String(value)` when the value is not an Error instance.
 */
export function errMsg(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  try {
    return String(value);
  } catch {
    return "Unknown error";
  }
}
