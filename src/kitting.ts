import type { Payload, PayloadRequest, Where } from 'payload'

import { addBuiltKit } from './kits.js'
import { afterCommit, carryOn, idOf, KitError, optionsOf, READ, scoped as scopedWhere, withCarried } from './internal.js'
import type { KittingAdapter, ResolvedOptions } from './types.js'

/**
 * Kitting's units (`adapters.kitting`), through the functions the site passes in, the shapes of Kitting's own
 * exports. The kits Kitting builds and the kits this plugin sells stay the same stock:
 * - a built unit becomes an in-stock kit in the build's transaction (`kittingOnBuild` → `addBuiltKit`);
 * - at packing, the scanned kit's unit becomes the order's (`swapUnit`); a kit received before Kitting (no unit)
 *   packs as before, with a note; an order with nothing reserved is given its units then (`assignUnits`);
 * - unpacking gives the unit back (`release`) and tops the order up again; a canceled order gives back everything;
 * - shipping marks the units in the box shipped (`shipUnits`), and gives back any assigned unit whose kit isn't there;
 * - a recall voids the lot's units still ready or assigned (`voidUnit`), and tops up the orders it reopened.
 *
 * Every call joins the action's transaction through its `req`, so a kit's status and its unit never drift apart: if
 * Kitting refuses or fails, the whole action is rolled back, the kit's change included. With Kitting wired, an action
 * that would touch units refuses before writing anything when there's no transaction to share (a database without
 * transactions), rather than leave the two out of step.
 */

type ID = string | number
type Unit = { id: ID; externalId: string; status: string }

export const kittingOf = (o: ResolvedOptions): KittingAdapter | null => o.adapters?.kitting ?? null

/** The order's name on its units: the site's `Order <id>` unless it says otherwise. */
export const unitReference = (k: KittingAdapter, orderId: string) => (k.reference ? k.reference(orderId) : `Order ${orderId}`)

/**
 * With Kitting wired, refuses unless this request is inside a real transaction, before anything is written. Kitting
 * joins the transaction it's given; without one, a refusal halfway would leave a kit and its unit out of step.
 */
export async function requireSharedTransaction(o: ResolvedOptions, req: PayloadRequest) {
  if (!kittingOf(o)) return
  const id = req.transactionID instanceof Promise ? await req.transactionID : req.transactionID
  if (!id) throw new KitError('kittingNeedsTransaction', 'Kitting is wired, but this database has no transactions, so kits and Kitting’s units can’t be kept in step. Nothing was changed.')
}

/** The request Kitting gets: the same transaction and person, a context of its own. */
const kReq = (req: PayloadRequest) => carryOn(req, { payload: req.payload, transactionID: req.transactionID, user: req.user, context: withCarried(req, {}) } as unknown as PayloadRequest)

const codeOf = (error: unknown) => {
  const c = (error as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

/** Kitting's refusal, in its own words, as a kit refusal. Anything without a code (a crash) is passed on as it is. */
function refusal(error: unknown): unknown {
  if (error instanceof KitError) return error
  const code = codeOf(error)
  if (!code) return error
  const message = error instanceof Error ? error.message : String(error)
  return new KitError('kitting', `Kitting: ${message}`, { kittingCode: code, message })
}

const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (error) {
    throw refusal(error)
  }
}

const scopeArg = (site: string | undefined) => (site === undefined ? {} : { scope: site })

function unitWhere(o: ResolvedOptions, k: KittingAdapter, site: string | undefined, where: Where): Where {
  const field = k.scopeField ?? o.scope?.field
  return field && site !== undefined ? { and: [{ [field]: { equals: site } }, where] } : where
}

async function findUnits(req: PayloadRequest, o: ResolvedOptions, k: KittingAdapter, site: string | undefined, where: Where): Promise<Unit[]> {
  return (await req.payload.find({ collection: (k.units ?? 'assembled-units') as never, where: unitWhere(o, k, site, where) as never, ...READ, req })).docs as unknown as Unit[]
}

/** After the commit: Kitting's held stock emails. */
function alertsAfterCommit(o: ResolvedOptions, outer: PayloadRequest) {
  const k = kittingOf(o)
  if (!k?.sendPendingAlerts) return
  const send = k.sendPendingAlerts
  afterCommit(outer, () => send(outer.payload))
}

/** Give an order `count` units (ready first, a build request for the rest), in the transaction. */
export async function assignInTransaction(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: string, count: number) {
  const k = kittingOf(o)
  if (!k || count <= 0) return
  await call(() => k.assignUnits(req.payload, k.recipe, count, { reference: unitReference(k, orderId), ...scopeArg(site), req: kReq(req) }))
}

/** How many units an order should hold: one per kit it needs, less the kits packed in it that have no unit. */
export async function unitsNeeded(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: string, total: number): Promise<number> {
  const k = kittingOf(o)
  if (!k) return 0
  const scoped = scopedWhere(o, site, { order: { equals: orderId } })
  const packed = ((await req.payload.find({ collection: 'kits', where: scoped, ...READ, req })).docs as unknown as { code: string }[]).map((x) => x.code)
  if (!packed.length) return total
  const withUnits = (await findUnits(req, o, k, site, { externalId: { in: packed } })).length
  return Math.max(0, total - (packed.length - withUnits))
}

/**
 * At packing: the scanned kit's unit becomes the order's. `'no-unit'` for a kit received before Kitting, and
 * `'assigned-late'` when the order held nothing and was given its units now. Anything else Kitting refuses (a unit
 * kept for another order, shipped or voided) refuses the packing, in Kitting's words.
 */
export async function takeUnitAtPacking(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: string, code: string, total: number): Promise<'taken' | 'no-unit' | 'assigned-late' | null> {
  const k = kittingOf(o)
  if (!k) return null
  const swap = () => k.swapUnit(req.payload, { reference: unitReference(k, orderId), take: { externalId: code }, ...scopeArg(site), req: kReq(req) })
  try {
    await swap()
    return 'taken'
  } catch (error) {
    const c = codeOf(error)
    if (c === 'unitNotFound') return 'no-unit'
    if (c !== 'nothingReserved') throw refusal(error)
  }
  await assignInTransaction(req, o, site, orderId, total)
  await call(swap)
  return 'assigned-late'
}

/** Unpacking one kit (with `code`), or a canceled order (without): its units go back to ready. A kit with no unit is fine. */
export async function releaseUnits(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: string, code?: string) {
  const k = kittingOf(o)
  if (!k) return
  try {
    await k.release(req.payload, { reference: unitReference(k, orderId), ...(code ? { unit: { externalId: code } } : {}), ...scopeArg(site), req: kReq(req) })
  } catch (error) {
    if (codeOf(error) === 'unitNotFound') return
    throw refusal(error)
  }
}

/**
 * Shipped: the units of the kits in the box are marked shipped; an assigned unit whose kit isn't there (a kit
 * received before Kitting was packed in its place) goes back to ready.
 */
export async function shipOrderUnits(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: string): Promise<{ shipped: number; released: number } | null> {
  const k = kittingOf(o)
  if (!k) return null
  const units = await findUnits(req, o, k, site, { and: [{ assignedTo: { equals: unitReference(k, orderId) } }, { status: { equals: 'assigned' } }] })
  if (!units.length) return { shipped: 0, released: 0 }
  const scoped = scopedWhere(o, site, { order: { equals: orderId } })
  const packed = new Set(((await req.payload.find({ collection: 'kits', where: scoped, ...READ, req })).docs as unknown as { code: string }[]).map((x) => x.code))
  const inBox = units.filter((u) => packed.has(u.externalId))
  for (const u of units.filter((x) => !packed.has(x.externalId))) await call(() => k.release(req.payload, { reference: unitReference(k, orderId), unit: { id: u.id }, ...scopeArg(site), req: kReq(req) }))
  if (inBox.length) await call(() => k.shipUnits(req.payload, inBox.map((u) => u.id), { req: kReq(req) }))
  return { shipped: inBox.length, released: units.length - inBox.length }
}

/** A recall: the lot's units still ready or assigned are voided, so Kitting never counts or gives them out again. */
export async function voidRecalled(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, codes: string[], note: string): Promise<number> {
  const k = kittingOf(o)
  if (!k || !codes.length) return 0
  const units = await findUnits(req, o, k, site, { and: [{ externalId: { in: codes } }, { status: { in: ['ready', 'assigned'] } }] })
  for (const u of units) await call(() => k.voidUnit(req.payload, u.id, { reason: 'other', note: `Lot recalled: ${note}`.slice(0, 200), req: kReq(req) }))
  return units.length
}

/** After an action that touched units, Kitting's held emails go out once it commits. */
export const kittingAfterCommit = (o: ResolvedOptions, outer: PayloadRequest) => alertsAfterCommit(o, outer)

/**
 * Server only: an order became packable (paid, all-credit, or a pre-order released), so give it its units. Never
 * throws and never fails the order (packing assigns them late if this didn't run); a failure is logged by its name.
 */
export async function assignKitUnits(payload: Payload, orderId: string): Promise<void> {
  const o = optionsOf(payload)
  const k = kittingOf(o)
  if (!k) return
  try {
    const order = (await payload.findByID({ collection: o.collections.orders as never, id: orderId, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Record<string, unknown> & {
      kitLines?: { quantity?: number | null }[] | null
      kitFulfillment?: { status?: string | null } | null
    } | null
    if (!order || !['to-pack', 'packed'].includes(String(order.kitFulfillment?.status ?? 'to-pack'))) return
    const site = o.scope ? (idOf(order[o.scope.field]) ?? undefined) : undefined
    const total = (order.kitLines ?? []).reduce((n, l) => n + Number(l.quantity ?? 0), 0)
    if (total > 0) await k.assignUnits(payload, k.recipe, total, { reference: unitReference(k, orderId), ...scopeArg(site) })
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name, code: codeOf(error) }, order: orderId }, 'Sample Kits: Kitting units not assigned to the order')
  }
}

/**
 * For Kitting's `units.onBuild`: each built unit of this recipe becomes an in-stock kit, in the build's transaction,
 * through `addBuiltKit` (so the build needs kit staff on its `req`). A code already in stock, a code with no lot, a
 * unit from another site, or no person: the whole build is refused, so no unit exists without its kit.
 */
export function kittingOnBuild({ recipeKey }: { recipeKey: string }) {
  return async ({ payload, req, unit, recipe }: { payload: Payload; req: Partial<PayloadRequest>; unit: { externalId: string; scope?: ID | null }; recipe: { key: string } }) => {
    if (recipe.key !== recipeKey) return
    const r = req as PayloadRequest
    r.payload ??= payload
    const o = optionsOf(payload)
    if (o.scope) {
      const site = await o.scope.of(r)
      if (unit.scope === null || unit.scope === undefined || site === null || site === undefined || String(site) !== String(unit.scope)) throw new KitError('wrongSite', 'This build is for another site’s kits.')
    }
    const out = await addBuiltKit(r, unit.externalId)
    if (!out.added) throw new KitError('alreadyInStock', `Kit ${out.code} is already in stock.`, { code: out.code })
  }
}
