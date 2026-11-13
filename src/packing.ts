import type { PayloadRequest } from 'payload'

import { normalizeKitCode } from './codes.js'
import { errName, afterCommit, audit, SKIP_LABEL_CANCEL, freshReq, idOf, inTransaction, KitError, ONE, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq, topLevelFields } from './internal.js'
import { assertLotsUsable, findKit, issueSecret, recordKitEvent } from './kits.js'
import { ACTIVATABLE, PACKABLE } from './status.js'
import { inPersonText } from './terms.js'
import { assignInTransaction, kittingAfterCommit, kittingOf, releaseUnits, requireSharedTransaction, shipOrderUnits, takeUnitAtPacking, unitsNeeded } from './kitting.js'
import type { KitDoc, KitLine, KitOrder, NoticeDelivery, ResolvedOptions } from './types.js'

/**
 * Packing an order, its slip and shipping it (until Kitting's packing station takes over the screens).
 * Each action is for kit staff, runs in one transaction, and writes a kit event for every kit it touches.
 */

/** The order's buyer, from the orders provider (default: the order's `customer`). */
export const buyerOf = (o: ResolvedOptions, order: KitOrder): string | null => idOf(o.orders?.buyerOf ? o.orders.buyerOf(order) : order.customer)

/** A kit order on this site. The same answer for "no such order", "another site's" and "no kits", so nothing is learned. */
export async function getKitOrder(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: unknown): Promise<KitOrder> {
  const id = idOf(orderId)
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new KitError('noOrder', 'That order wasn’t found.')
  const { docs } = await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { id: { equals: id } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))
  const order = docs[0] as unknown as KitOrder | undefined
  if (!order || !order.kitLines?.length) throw new KitError('noOrder', 'That order wasn’t found.')
  return order
}

/** The site of a record, for the plugin's own work where no person is asking (webhooks, background runs). */
export const siteOfRecord = (o: ResolvedOptions, doc: Record<string, unknown>): string | undefined => (o.scope ? (idOf(doc[o.scope.field]) ?? undefined) : undefined)

export type LineProgress = { index: number; kind: string; quantity: number; packed: number }

/** Each line of a kit order with how many kits are packed for it. */
export async function orderKits(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, order: KitOrder) {
  const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { order: { equals: order.id } }), sort: 'createdAt', showHiddenFields: true, ...READ, req })).docs as unknown as KitDoc[]
  const lines: LineProgress[] = (order.kitLines ?? []).map((l, index) => ({ index, kind: l.kind, quantity: Number(l.quantity) || 0, packed: kits.filter((k) => k.orderLine === index).length }))
  const total = lines.reduce((s, l) => s + l.quantity, 0)
  return { kits, lines, total, packed: kits.length }
}

/** Writes the order's `kitFulfillment`, keeping what's there, as the system. */
export async function saveFulfillment(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, change: Record<string, unknown>, reason: string, extra: Record<string, unknown> = {}) {
  const fresh = (await req.payload.findByID({ collection: o.collections.orders, id: order.id, ...ONE, req })) as unknown as KitOrder
  const kitFulfillment = { ...(fresh.kitFulfillment ?? {}), ...change }
  await req.payload.update({ collection: o.collections.orders, id: order.id, data: { ...extra, kitFulfillment } as never, overrideAccess: true, depth: 0, req: sysReq(req, audit(reason)) })
  return kitFulfillment
}

// ---------------------------------------------------------------- replacements

export type ReplaceReason = 'lost' | 'expired' | 'recalled' | 'failed' | 'damaged'

/** Why a kit was replaced, from its custody trail. */
export async function replacedReason(req: PayloadRequest, kit: string): Promise<ReplaceReason | null> {
  const { docs } = await req.payload.find({ collection: 'kit-events', where: { and: [{ kit: { equals: kit } }, { type: { equals: 'replaced' } }] }, sort: '-at', limit: 1, ...READ, req })
  return ((docs[0] as { details?: { reason?: ReplaceReason } | null } | undefined)?.details?.reason as ReplaceReason | undefined) ?? null
}

/** For packing: the kit a replacement order replaces, and which attempt the new kit is (a failed sample counts one more). */
async function replacementFor(req: PayloadRequest, replaces: string | null): Promise<{ replacementOf: string; attempt: number } | null> {
  if (!replaces) return null
  const { docs } = await req.payload.find({ collection: 'kits', where: { id: { equals: replaces } }, limit: 1, ...READ, req })
  const old = docs[0] as unknown as { id: string; attempt?: number | null } | undefined
  if (!old) return null
  const why = await replacedReason(req, String(old.id))
  return { replacementOf: String(old.id), attempt: (old.attempt ?? 1) + (why === 'failed' ? 1 : 0) }
}

// ---------------------------------------------------------------- packing

export type PackResult = { code: string; line: number; label: string | null; packed: number; total: number }

/**
 * Scan a kit into an order (kit staff): the lot must be usable (not recalled or expired), the kit free, and the
 * order still short of kits. Kits fill the lines in order; the subject provider says what each is for.
 */
export async function packKit(req: PayloadRequest, input: { order: string; code: string }): Promise<PackResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code. Kit codes are the 8 to 20 digits under the barcode.')
  const site = await siteOf(o, req)
  const outer = req
  return inTransaction(req, async (req) => {
    await requireSharedTransaction(o, req)
    const order = await getKitOrder(req, o, site, input.order)
    const status = order.kitFulfillment?.status ?? 'to-pack'
    if (status === 'shipped' || status === 'cancelled') throw new KitError('orderClosed', 'This order has already shipped or was canceled.')
    if (status === 'pre-order') throw new KitError('preorder', 'This order is a pre-order: release it before packing.')
    const kit = await findKit(req, code, site)
    if (!kit) throw new KitError('unknownKit', `Kit ${code} isn’t in stock here. Receive it into stock first.`, { code })
    if (idOf(kit.order) === String(order.id)) throw new KitError('alreadyInOrder', `Kit ${code} is already in this order.`, { code })
    // The lot first, so a recalled kit says "recalled" rather than "not free".
    await assertLotsUsable(req, [kit])
    if (!PACKABLE.includes(kit.status)) throw new KitError('notFree', `Kit ${code} isn’t free: it’s ${kit.status}.`, { code, status: kit.status })
    const { lines, total, packed } = await orderKits(req, o, site, order)
    const line = lines.find((l) => l.packed < l.quantity)
    if (!line) throw new KitError('orderFull', `This order already has all ${total} kits.`, { total })
    const orderLine = order.kitLines![line.index]! as KitLine
    const pack = (await o.subjects.packFor?.({ line: orderLine, index: line.index, slot: line.packed, kit, order, req })) ?? {}
    const allowed = new Set(topLevelFields(o.subjects.fields).map((f) => f.name))
    if (pack.set && (typeof pack.set !== 'object' || Object.keys(pack.set).some((k) => !allowed.has(k)))) throw new Error('subjects.packFor may only write the subject fields it brought.')
    const replacing = await replacementFor(req, idOf(order.kitFulfillment?.replaces))
    // Claim the kit only if it's still free, so two packers can't put one kit in two orders.
    const claimed = await req.payload.update({
      collection: 'kits',
      where: { and: [{ id: { equals: kit.id } }, { status: { in: [...PACKABLE] } }] },
      data: {
        ...(pack.set ?? {}),
        buyer: buyerOf(o, order),
        order: order.id,
        orderLine: line.index,
        identifierLabel: pack.label ?? null,
        test: orderLine.test ?? o.tests[0]!.value,
        replacementOf: replacing?.replacementOf ?? null,
        attempt: replacing?.attempt ?? 1,
        // Handed in at an event the buyer chose: no return label for it.
        ...(order.kitFulfillment?.returnAt && order.kitFulfillment.returnAtEvent?.starts ? { returnInPerson: inPersonText(order.kitFulfillment.returnAtEvent, o.policy?.storeTimeZone) } : {}),
      } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, { ...audit('kit packed'), [SKIP_LABEL_CANCEL]: true }),
    })
    if (claimed.docs.length !== 1) throw new KitError('notFree', `Kit ${code} isn’t free any more.`, { code, status: 'packed' })
    // Kitting wired: the scanned kit's unit becomes this order's, in this transaction, or packing stops in Kitting's words.
    const unit = await takeUnitAtPacking(req, o, site, String(order.id), code, total)
    const unitNote = unit === 'no-unit' ? { kitting: 'no unit: received before Kitting' } : unit === 'assigned-late' ? { kitting: 'the order had no units reserved; given them at packing' } : {}
    if (unit) kittingAfterCommit(o, outer)
    await recordKitEvent(req, kit, { type: 'packed', source: 'scan', order: String(order.id), details: { line: line.index, ...unitNote } })
    const nowPacked = packed + 1
    if (nowPacked === total) await saveFulfillment(req, o, order, { status: 'packed' }, 'order packed')
    return { code, line: line.index, label: pack.label ?? null, packed: nowPacked, total }
  })
}

/** What packing writes on a kit, cleared when it leaves an order. */
export const unpackedFields = (o: ResolvedOptions) =>
  Object.fromEntries(['buyer', 'order', 'orderLine', 'identifierLabel', 'secretHash', 'secretIssuedAt', 'replacementOf', 'returnInPerson', ...topLevelFields(o.subjects.fields).map((f) => f.name)].map((k) => [k, null]))

/** Take a kit back out of an order before it ships (kit staff). */
export async function unpackKit(req: PayloadRequest, input: { order: string; code: string }): Promise<{ code: string }> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code.')
  const site = await siteOf(o, req)
  const outer = req
  return inTransaction(req, async (req) => {
    await requireSharedTransaction(o, req)
    const order = await getKitOrder(req, o, site, input.order)
    if (order.kitFulfillment?.status === 'shipped') throw new KitError('orderClosed', 'This order has already shipped.')
    const kit = await findKit(req, code, site)
    if (!kit || idOf(kit.order) !== String(order.id) || kit.status !== 'packed') throw new KitError('notInOrder', `Kit ${code} isn’t packed in this order.`, { code })
    await recordKitEvent(req, kit, { type: 'unpacked', source: 'scan', order: String(order.id), set: { ...unpackedFields(o), attempt: 1 } })
    if (kittingOf(o)) {
      // Its unit goes back, and the order is topped up again, so it still holds one unit per kit it needs.
      await releaseUnits(req, o, site, String(order.id), code)
      const total = (order.kitLines ?? []).reduce((n, l) => n + Number(l.quantity ?? 0), 0)
      await assignInTransaction(req, o, site, String(order.id), await unitsNeeded(req, o, site, String(order.id), total))
      kittingAfterCommit(o, outer)
    }
    await saveFulfillment(req, o, order, { status: 'to-pack' }, 'kit unpacked')
    return { code }
  })
}

export type SlipKit = { code: string; secret: string; link: string | null; label: string | null }

/**
 * The order slip (kit staff): a new one-time activation secret per kit, through `issueSecret`, returned once
 * and stored only as a hash. Making the slip again replaces every secret, so an older printout stops working.
 */
export async function makeSlip(req: PayloadRequest, input: { order: string }): Promise<SlipKit[]> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input?.order)
    const { kits, total } = await orderKits(req, o, site, order)
    if (kits.length < total) throw new KitError('notPacked', `Pack all ${total} kits before making the slip (${kits.length} so far).`, { total, packed: kits.length })
    if (kits.some((k) => !ACTIVATABLE.includes(k.status))) throw new KitError('slipTooLate', 'Some kits in this order are already activated, so a new slip can’t be made.')
    await assertLotsUsable(req, kits)
    const out: SlipKit[] = []
    for (const kit of kits) {
      const issued = await issueSecret(req, { code: kit.code })
      out.push({ ...issued, label: kit.identifierLabel ?? null })
    }
    await saveFulfillment(req, o, order, { slipMadeAt: new Date().toISOString() }, 'slip made')
    return out
  })
}

const TRACKING = /^[A-Z0-9]{8,40}$/

/**
 * Mark an order shipped (kit staff). Every kit must be packed, its lot usable, and the slip made. Tracking
 * numbers typed in replace those of labels bought at order time. After the commit, the buyer is told through
 * `notify`, and the order records how that went; shipping stands either way.
 */
export async function markShipped(req: PayloadRequest, input: { order: string; tracking?: string[] }): Promise<{ kits: number; tracking: string[] }> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const tracking = (input?.tracking ?? []).map((t) => String(t).replace(/\s/g, '').toUpperCase()).filter((t) => TRACKING.test(t)).slice(0, 20)
  const site = await siteOf(o, req)
  const outer = req
  return inTransaction(req, async (req) => {
    await requireSharedTransaction(o, req)
    const order = await getKitOrder(req, o, site, input?.order)
    if (order.kitFulfillment?.status === 'shipped') throw new KitError('orderClosed', 'This order has already shipped.')
    if (order.kitFulfillment?.status === 'cancelled') throw new KitError('orderClosed', 'This order was canceled.')
    const { kits, total } = await orderKits(req, o, site, order)
    if (kits.length < total) throw new KitError('notPacked', `Pack all ${total} kits first (${kits.length} so far).`, { total, packed: kits.length })
    // Fail closed: nothing from a recalled or expired lot ships, however it got here.
    await assertLotsUsable(req, kits)
    const notPacked = kits.find((k) => k.status !== 'packed')
    if (notPacked) throw new KitError('notFree', `Kit ${notPacked.code} isn’t free: it’s ${notPacked.status}.`, { code: notPacked.code, status: notPacked.status })
    if (kits.some((k) => !k.secretIssuedAt)) throw new KitError('noSlip', 'Make and print the order slip first: it has the activation secrets.')
    if (!tracking.length) tracking.push(...(order.kitFulfillment?.trackingNumbers ?? []))
    for (const kit of kits) await recordKitEvent(req, kit, { type: 'shipped', order: String(order.id), details: tracking.length ? { tracking } : undefined })
    if (await shipOrderUnits(req, o, site, String(order.id))) kittingAfterCommit(o, outer)
    await saveFulfillment(req, o, order, { status: 'shipped', shippedAt: new Date().toISOString(), trackingNumbers: tracking }, 'order shipped')
    await o.orders?.onShipped?.({ order, req })
    const buyer = buyerOf(o, order)
    afterCommit(outer, () => tellShipped(outer, o, order, buyer, kits.length, tracking))
    return { kits: kits.length, tracking }
  })
}

const DELIVERIES: NoticeDelivery[] = ['sent', 'not-sent-side-effects-off', 'not-sent-test-addresses', 'no-address', 'failed']

/** After the commit: the shipped notice, and a record on the order of how it went. */
async function tellShipped(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, buyer: string | null, kits: number, tracking: string[]) {
  if (!o.notify) return
  let delivery: NoticeDelivery
  try {
    const answer = await o.notify({ kind: 'kits-shipped', to: { user: buyer, order: String(order.id) }, data: { order: String(order.id), kits, tracking }, req })
    delivery = answer && DELIVERIES.includes(answer) ? answer : 'sent'
  } catch (error) {
    req.payload.logger.warn({ err: errName(error) }, 'Sample Kits: the shipped notice failed')
    delivery = 'failed'
  }
  await inTransaction(freshReq(req), (r) => saveFulfillment(r, o, order, { shippedEmail: { delivery, at: new Date().toISOString() } }, `shipped notice ${delivery}`))
}

export type { KitLine }
