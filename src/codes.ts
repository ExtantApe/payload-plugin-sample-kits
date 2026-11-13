import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * Kit codes and activation secrets.
 *
 * A kit's code is the number preprinted on the tube's barcode (often 12 digits, e.g. 275864000115);
 * its first digits are the lot number. Codes are predictable, so a code alone never activates a
 * kit: activation also needs the kit's one-time secret, printed on the order slip and stored only as
 * a hash.
 */

/** What a scanner or a person typed, as a kit code; null if it can't be one. Spaces and dashes are fine. */
export function normalizeKitCode(input: string | null | undefined): string | null {
  const raw = String(input ?? '').trim()
  // Activation links carry the code (…/my-tests/activate?kit=CODE#…); a scan of one still finds the kit.
  const fromLink = /[?&]kit=(\d[\d\s-]*)/.exec(raw)?.[1]
  const digits = (fromLink ?? raw).replace(/[\s-]/g, '')
  return /^\d{8,20}$/.test(digits) ? digits : null
}

/** A lot number: the code prefix, digits only. */
export function normalizeLotNumber(input: string | null | undefined): string | null {
  const digits = String(input ?? '').replace(/[\s-]/g, '')
  return /^\d{3,12}$/.test(digits) ? digits : null
}

/** The lot whose number starts the code; the longest match wins when lot numbers nest. */
export function lotForCode<T extends { lotNumber: string }>(code: string, lots: T[]): T | null {
  return lots.filter((l) => code.startsWith(l.lotNumber) && code.length > l.lotNumber.length).sort((a, b) => b.lotNumber.length - a.lotNumber.length)[0] ?? null
}

/**
 * Codes for a run of preprinted serials in one lot: lot 275864, serials 115..118, width 6 →
 * 275864000115 … 275864000118. Width is the number of serial digits after the lot number.
 */
export function codesInRange(lotNumber: string, from: number, to: number, width: number): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error('Check the first and last serial numbers.')
  if (!Number.isInteger(width) || width < 1 || width > 12) throw new Error('Check the number of serial digits.')
  if (String(to).length > width) throw new Error(`The last serial has more than ${width} digits.`)
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(`${lotNumber}${String(n).padStart(width, '0')}`)
  return out
}

/**
 * Tracking numbers as typed: one per line or separated by commas. Spaces inside a number are kept
 * together (USPS prints them in groups: 9400 1000 …), so splitting on spaces would break them.
 */
export function parseTracking(input: string | null | undefined): string[] {
  return String(input ?? '')
    .split(/[\n,;]+/)
    .map((t) => t.replace(/\s/g, '').toUpperCase())
    .filter(Boolean)
}

/** No 0/O, 1/I/L or U: easy to read off paper and to type. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const SECRET_LENGTH = 10

/**
 * A new secret, as printed: `ABCDE-FGHJK`. It always has a letter in it, so no kit code (all digits)
 * can ever be a secret.
 */
export function newSecret(): string {
  for (;;) {
    let s = ''
    for (let i = 0; i < SECRET_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
    if (/[A-Z]/.test(s)) return `${s.slice(0, 5)}-${s.slice(5)}`
  }
}

/**
 * A secret as typed, in its stored form; null if it can't be one. New secrets always hold a letter, but slips the
 * site printed before the move may be all digits (about 2 in a million), and they still work: what never works is
 * the kit's own code given as its secret, which `secretMatches` refuses.
 */
export function normalizeSecret(input: string | null | undefined): string | null {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (raw.length !== SECRET_LENGTH || [...raw].some((c) => !ALPHABET.includes(c))) return null
  return raw
}

/**
 * The secret's hash is bound to the kit code, so a secret from one slip can't open another kit, and
 * peppered with the site's Payload secret, so a copy of the database alone can't test guesses.
 */
export const hashSecret = (pepper: string, code: string, normalizedSecret: string) =>
  createHash('sha256').update(`${pepper}|kit|${code}|${normalizedSecret}`).digest('hex')

/** Constant-time check of a typed secret against the stored hash. Anything malformed is false. */
export function secretMatches(pepper: string, code: string, secret: string, storedHash: string | null | undefined): boolean {
  const normalized = normalizeSecret(secret)
  // The owner's rule (2026-11-10): a code given as its own secret never activates, whatever is stored.
  if (normalized && normalized === normalizeKitCode(code)) return false
  if (!normalized || typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/.test(storedHash)) return false
  return timingSafeEqual(Buffer.from(hashSecret(pepper, code, normalized), 'hex'), Buffer.from(storedHash, 'hex'))
}

/** The link in the order slip's QR code. The secret is in the fragment, which browsers never send to a server. */
export const activationLink = (origin: string, code: string, secret: string, path = '/my-tests/activate') =>
  `${origin.replace(/\/$/, '')}${path}?kit=${code}#s=${secret}`
