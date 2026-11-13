import { commitTransaction, initTransaction, killTransaction, type Payload, type PayloadRequest, type TypedUser, type Where } from 'payload'

import type { AccessCheck, ResolvedOptions } from './types.js'

/** A refusal people should see. `code` picks the translated message; `vars` fill it in. */
export class KitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(message)
    this.name = 'KitError'
  }
}

export const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v || v === 0 ? String(v) : null)

export function optionsOf(payload: Payload): ResolvedOptions {
  const options = (payload.config.custom as { sampleKits?: ResolvedOptions } | undefined)?.sampleKits
  if (!options) throw new Error('Sample Kits isn’t installed in this Payload config: add sampleKits() to its plugins.')
  return options
}

/** Only an answer of exactly `true` passes; anything else, a thrown error included, is no. */
export async function passes(check: AccessCheck | undefined, req: PayloadRequest): Promise<boolean> {
  if (typeof check !== 'function') return false
  try {
    return (await check(req)) === true
  } catch {
    return false
  }
}

export const isMaintainer = (o: ResolvedOptions, req: PayloadRequest) => passes(o.access.maintainer, req)
export const isAdmin = async (o: ResolvedOptions, req: PayloadRequest) => (await passes(o.access.admin, req)) || isMaintainer(o, req)
export const isStaff = async (o: ResolvedOptions, req: PayloadRequest) => (await passes(o.access.staff, req)) || isAdmin(o, req)

/** The signed-in person, if they're from the site's users collection. */
export const personOf = (o: ResolvedOptions, req: PayloadRequest): TypedUser | null => {
  const user = req.user as (TypedUser & { collection?: string }) | null | undefined
  return user && user.collection === o.collections.users ? user : null
}

export const isWhere = (v: unknown): v is Where => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0

/**
 * The plugin's own writes: as the system (no person, so a site's per-person hooks don't refuse the
 * plugin's bookkeeping), in the caller's transaction. A fresh request each time, so the context it
 * carries never leaks back into the caller's request.
 */
export const sysReq = (req: PayloadRequest, context: Record<string, unknown> = {}) =>
  carryOn(req, { payload: req.payload, transactionID: req.transactionID, context: withCarried(req, context) } as unknown as PayloadRequest)

/** A request of its own, with no transaction, for the plugin's writes after a commit. */
export const freshReq = (req: PayloadRequest) => carryOn(req, { payload: req.payload, context: withCarried(req, {}) } as unknown as PayloadRequest)

/**
 * The plugin's own context keys, the ones its hooks read or it keeps its work in. A caller's context (the seed's
 * `context`) never sets them: they're dropped before it's carried, and the plugin's own values are always laid over it.
 */
export const PLUGIN_CONTEXT_KEYS: readonly string[] = ['sampleKitsEventWrite', 'skipLabelCancel', 'sampleKitsAfterCommit', 'audit']
/** The keys that switch a guard or hold the plugin's work: never taken from a caller, even where the plugin sets none. */
export const GUARD_CONTEXT_KEYS: readonly string[] = ['sampleKitsEventWrite', 'skipLabelCancel', 'sampleKitsAfterCommit']

/**
 * A caller's context carried onto the plugin's own requests (the seed's `context`): kept here, off the request, so no
 * request can claim one by setting a key, and passed on to every request the plugin makes from a carrying one.
 */
const CARRIED = new WeakMap<object, Readonly<Record<string, unknown>>>()

/** A caller's context, made safe to carry: a copy, without the plugin's guard keys. */
export const carriable = (context: Record<string, unknown>): Readonly<Record<string, unknown>> =>
  Object.freeze(Object.fromEntries(Object.entries(context).filter(([k]) => !GUARD_CONTEXT_KEYS.includes(k))))

/** Marks `req` as carrying `context` (already made carriable), so the plugin's writes from it carry it too. */
export function carry<T extends object>(req: T, context: Readonly<Record<string, unknown>>): T {
  CARRIED.set(req, context)
  return req
}
export const carryOn = (from: PayloadRequest, to: PayloadRequest) => {
  const c = from && CARRIED.get(from)
  if (c) CARRIED.set(to, c)
  return to
}
/** The audit keys a carried context sets over the plugin's: a seed run is a script, whatever action it goes through. */
const CALLER_AUDIT_KEYS = ['origin', 'system'] as const
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * A carried context with the plugin's own laid over it: the plugin's keys win, except inside `audit`, which is merged
 * field by field: the caller's keys the plugin doesn't use, the plugin's (its reason and the rest) over them, then the
 * caller's `origin` and `system` over those.
 */
export const mergeCarried = (carried: Readonly<Record<string, unknown>>, own: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...carried, ...own }
  const theirs = carried.audit
  if (isObject(theirs) && isObject(own.audit)) {
    const audit: Record<string, unknown> = { ...theirs, ...own.audit }
    for (const k of CALLER_AUDIT_KEYS) if (k in theirs) audit[k] = theirs[k]
    out.audit = audit
  }
  return out
}

/** The carried context, if `req` has one, merged with the plugin's own (`mergeCarried`); otherwise the plugin's alone. */
export const withCarried = (req: PayloadRequest | null | undefined, own: Record<string, unknown>): Record<string, unknown> => {
  const c = req ? CARRIED.get(req) : undefined
  return c ? mergeCarried(c, own) : own
}

export const audit = (reason: string) => ({ audit: { origin: 'web', system: 'kits', reason } })

/** Reads inside a transaction run one query at a time (Mongo refuses parallel operations on one session). */
export const READ = { overrideAccess: true, depth: 0, joins: false, pagination: false } as const
export const ONE = { overrideAccess: true, depth: 0, joins: false } as const

/**
 * Runs `fn` in the caller's transaction, or in a new one when there isn't one. A new one is committed
 * when `fn` returns and rolled back when it throws; a caller's is left to the caller.
 */
export async function inTransaction<T>(req: PayloadRequest, fn: (req: PayloadRequest) => Promise<T>): Promise<T> {
  const owns = await initTransaction(req)
  try {
    const result = await fn(req)
    if (owns) {
      await commitTransaction(req)
      await runAfterCommit(req)
    }
    return result
  } catch (error) {
    if (owns) {
      await killTransaction(req)
      pendingOf(req).length = 0
    }
    throw error
  }
}

/** Set on a kit save that cancels its labels itself (or needs none cancelled), so the kit's hook doesn't run. */
export const SKIP_LABEL_CANCEL = 'skipLabelCancel'

/** Where work waiting for the commit is kept, on the request's context. */
export const AFTER_COMMIT_KEY = 'sampleKitsAfterCommit'
type Pending = (() => Promise<unknown>)[]
const pendingOf = (req: PayloadRequest): Pending => {
  req.context ??= {}
  const list = req.context[AFTER_COMMIT_KEY]
  if (Array.isArray(list)) return list as Pending
  const fresh: Pending = []
  req.context[AFTER_COMMIT_KEY] = fresh
  return fresh
}

/**
 * Runs `task` once the transaction commits: notices, and records of how they went. When the action
 * started the transaction, it runs them itself; when the caller did, the caller calls `runAfterCommit(req)`
 * after its own commit.
 */
export function afterCommit(req: PayloadRequest, task: () => Promise<unknown>) {
  pendingOf(req).push(task)
}

/** Runs the work waiting for the commit, once each. A task that throws is logged and never stops the rest. */
export async function runAfterCommit(req: PayloadRequest): Promise<void> {
  const list = pendingOf(req)
  while (list.length) {
    const task = list.shift()!
    try {
      await task()
    } catch (error) {
      req.payload.logger.error({ err: errName(error) }, 'Sample Kits: work after the commit failed')
    }
  }
}

/** What a log line keeps of an error: its name only, never its message, stack or the records it carries. */
export const errName = (error: unknown): { name: string } => ({ name: String((error as { name?: unknown } | null)?.name ?? typeof error).slice(0, 100) })

/**
 * Lost a race to another request: MongoDB's write conflict inside a transaction (code 112, or labeled transient).
 * The loser gets `busy` with plain words, never the general error.
 */
export function isWriteConflict(error: unknown): boolean {
  const e = error as { code?: unknown; codeName?: unknown; errorLabels?: unknown; errorLabelSet?: unknown; cause?: unknown; message?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (e.code === 112 || e.codeName === 'WriteConflict') return true
  const labels = Array.isArray(e.errorLabels) ? e.errorLabels : e.errorLabelSet instanceof Set ? [...e.errorLabelSet] : []
  if (labels.includes('TransientTransactionError')) return true
  if (/WriteConflict|Write conflict/i.test(String(e.message ?? ''))) return true
  return e.cause !== undefined && e.cause !== error ? isWriteConflict(e.cause) : false
}

export const busy = () => new KitError('busy', 'Someone else just did this; refresh and check.')

/** Shipping's error code, read by value (the plugin never imports Shipping's error class). */
export function carrierCode(error: unknown): string | null {
  const e = error as { name?: unknown; code?: unknown } | null
  return e && typeof e === 'object' && e.name === 'CarrierError' && typeof e.code === 'string' ? e.code : null
}
export const carrierStatus = (error: unknown): number => Number((error as { status?: unknown } | null)?.status) || 0
/** Shipping's address refusal: an error carrying the list of problems. */
export const addressProblemsOf = (error: unknown): string[] | null => {
  const p = (error as { problems?: unknown } | null)?.problems
  return Array.isArray(p) ? p.map(String) : null
}

/** The site this request is for (scope), or undefined on a single-site install. Refuses when there's none. */
export async function siteOf(o: ResolvedOptions, req: PayloadRequest): Promise<string | undefined> {
  if (!o.scope) return undefined
  const site = await o.scope.of(req)
  if (site === null || site === undefined || site === '') throw new KitError('noSite', 'This site couldn’t be told from the request.')
  return String(site)
}

/** `where`, limited to the site when there's a scope. */
export const scoped = (o: ResolvedOptions, site: string | undefined, where: Where): Where =>
  o.scope && site !== undefined ? { and: [{ [o.scope.field]: { equals: site } }, where] } : where

export async function requireStaff(o: ResolvedOptions, req: PayloadRequest) {
  if (!(await isStaff(o, req))) throw new KitError('notStaff', 'Only kit staff can do that.')
}

/**
 * Set in the context of the plugin's own write of a kit's status, by `recordKitEvent` only. A value no
 * one else holds, so no other write can pass for it.
 */
export const EVENT_WRITE = Symbol('sample-kits: status written by a kit event')
export const EVENT_WRITE_KEY = 'sampleKitsEventWrite'

type AnyField = { name?: string; type?: string; fields?: unknown[]; tabs?: unknown[] }

/** The top-level data fields of a field list, looking through rows, collapsibles and unnamed tabs. */
export function topLevelFields<T = { name: string; type: string }>(fields: readonly unknown[]): T[] {
  const out: T[] = []
  for (const f of fields as AnyField[]) {
    if (f.type === 'tabs') for (const tab of (f.tabs ?? []) as AnyField[]) tab.name ? out.push(tab as T) : out.push(...topLevelFields<T>(tab.fields ?? []))
    else if (!f.name && f.fields) out.push(...topLevelFields<T>(f.fields))
    else if (f.name) out.push(f as T)
  }
  return out
}
