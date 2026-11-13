import type { PayloadRequest } from 'payload'

import { busy, isWriteConflict, KitError, optionsOf } from '../internal.js'
import type { ResolvedOptions } from '../types.js'

/** A refusal or failure a page can show: `code` for the site's own handling, `message` in plain words with what to do next. */
export type ServerError = { code: string; message: string }

/** What every server function answers. Always plain JSON: no class instances, dates or functions. */
export type ServerResult<T> = { ok: true; data: T } | { ok: false; error: ServerError }

/** Shown when something unexpected went wrong. The details go to the server's log (the error's name only), never to the page. */
export const GENERIC_MESSAGE = 'Something went wrong on our side. Please try again in a minute. If it keeps happening, contact us and say what you were doing.'

/**
 * Plainer words, with what to do next, for the refusals a page meets most. Other codes keep the action's own message.
 * `noOrder` and `kitNotFound` are the same for "doesn't exist" and "isn't yours", so nothing is learned from them.
 */
export const PLAIN_ERRORS: Record<string, string> = {
  signIn: 'Sign in to continue. If you’re signed in already, your session may have ended: sign in again.',
  notStaff: 'This page is for kit staff. If you should have access, ask a site admin to add you.',
  notLab: 'This page is for the labs we work with. If you work at one, ask us to add you to its portal.',
  noSite: 'We couldn’t tell which site this is. Reload the page; if it keeps happening, contact us.',
  noOrder: 'We couldn’t find that order on your account. Check the link, or sign in with the account that placed it.',
  notYourKit: 'We couldn’t find that kit on your account. Check the number under the barcode, or sign in with the account that ordered or activated it.',
}

/** Fills `{name}` placeholders. */
export const fill = (text: string, vars: Record<string, string | number> = {}) => text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all))

/**
 * Plugin text, through the site's `i18n.t` when it gives one (keys `sampleKits.<key>`), else the English here.
 * A translation that's missing (empty, or the key echoed back) falls back to English.
 */
export function say(o: Pick<ResolvedOptions, 'i18n'>, key: string, english: string, vars: Record<string, string | number> = {}): string {
  const full = `sampleKits.${key}`
  try {
    const out = o.i18n?.t?.(full, vars)
    if (typeof out === 'string' && out && out !== full) return out
  } catch {
    // A translator that throws is treated as missing.
  }
  return fill(english, vars)
}

/** Plain JSON at the boundary, so nothing a page can't serialize (a Date, an ObjectId, a Buffer) slips through. */
export const plain = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T))

/**
 * Runs a page's work and answers a `ServerResult`. A `KitError` becomes its code and plain message (translated by
 * `sampleKits.errors.<code>` when the site gives `i18n.t`); anything else is logged by name only and answered with
 * the general message, so no stack, query or record reaches the page.
 */
export async function serve<T>(req: PayloadRequest, fn: (o: ResolvedOptions) => Promise<T>): Promise<ServerResult<T>> {
  let o: ResolvedOptions
  try {
    o = optionsOf(req.payload)
  } catch {
    return { ok: false, error: { code: 'notInstalled', message: GENERIC_MESSAGE } }
  }
  try {
    return { ok: true, data: plain(await fn(o)) }
  } catch (error) {
    if (error instanceof KitError || (error as { name?: unknown } | null)?.name === 'KitError') {
      const e = error as KitError
      return { ok: false, error: { code: e.code, message: say(o, `errors.${e.code}`, PLAIN_ERRORS[e.code] ?? e.message, e.vars ?? {}) } }
    }
    // Lost a race to another request: plain words, not the general error.
    if (isWriteConflict(error)) {
      const e = busy()
      return { ok: false, error: { code: e.code, message: say(o, `errors.${e.code}`, e.message) } }
    }
    req.payload.logger.error({ name: (error as { name?: unknown } | null)?.name ?? typeof error }, 'Sample Kits: a page’s server function failed')
    return { ok: false, error: { code: 'generic', message: say(o, 'errors.generic', GENERIC_MESSAGE) } }
  }
}

/** Short text input: trimmed, at most `max` characters. */
export const text = (v: unknown, max = 200): string => String(v ?? '').trim().slice(0, max)
