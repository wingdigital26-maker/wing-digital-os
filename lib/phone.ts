// ───────────────────────────────────────────────────────────────────────────
// Phone normalization shared by the public intake surfaces (forms, voice).
//
// RULES (US-first, because every Wing client is in DFW):
//   * strip everything that is not a digit
//   * 10 digits                => +1XXXXXXXXXX  (E.164)
//   * 11 digits starting with 1 => +XXXXXXXXXXX (E.164)
//   * anything else            => kept exactly as the visitor typed it, and
//                                 NOT treated as E.164 (e164 = null). We store
//                                 what we were given rather than inventing a
//                                 number; the engine decides what to do with
//                                 a phone it cannot dial or text.
// NULL means unknown: an empty or whitespace-only value is null, not "".
// ───────────────────────────────────────────────────────────────────────────

export type NormalizedPhone = {
  /** The value to store on the contact: E.164 when we could derive it, else the raw input. */
  value: string | null;
  /** Set only when the number is a real E.164 string we can text or dial. */
  e164: string | null;
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(input: unknown): NormalizedPhone {
  if (typeof input !== "string") return { value: null, e164: null };
  const raw = input.trim();
  if (!raw) return { value: null, e164: null };
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    const e = `+1${digits}`;
    return { value: e, e164: e };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const e = `+${digits}`;
    return { value: e, e164: e };
  }
  // Already E.164 as typed (a +44 number, say): keep it as E.164 too.
  if (E164_RE.test(raw)) return { value: raw, e164: raw };
  return { value: raw.slice(0, 40), e164: null };
}

export function isE164(v: unknown): v is string {
  return typeof v === "string" && E164_RE.test(v);
}
