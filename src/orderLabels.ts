import { randomUUID } from 'node:crypto'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { type BoxTypeDoc, KIT_WEIGHT_OZ, outside, planShipment, type Pricer } from './boxes.js'
import { askRefund, carrierRefusal, customerAddress, hasShipping, hubLabel, refundable, returnHub, shipFromHub, shippingOf } from './carrier.js'
import { isWriteConflict, errName, audit, inTransaction, KitError, optionsOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { getKitOrder, saveFulfillment, siteOfRecord } from './packing.js'
import { pendingOnOrder, recordedPurchase, rowsForSlot } from './ledger.js'
import { buyReturnLabel, labelsOf } from './returns.js'
import type { KitOrder, LabelShipping, OutboundLabel, ResolvedOptions, SavedBox } from './types.js'

/**
 * Labels at order time. As soon as an order can be packed, its box plan is chosen by label cost and, per box,
 * the outbound label and the prepaid return label are bought together. The plan is saved on the order and
 * packing follows it; the buyer sees the tracking numbers at once.
 *
 * - Once per order: a claim on the order stops two runs buying twice, and a run checks it still holds the
 *   claim before each purchase. A box that already has its labels is skipped, so a retry buys only what's missing.
 * - Each purchase is committed on its own when there's no caller transaction, so a later failure never forgets a
 *   label that was paid for. Nothing is thrown after a purchase: the result and the order say what happened.
 * - Every purchase's record is written before the carrier is asked and settled after, outside any transaction
 *   (`ledger.ts`), so a rollback, the caller's included, never loses a paid label.
 * - An unclear purchase (`MAYBE_BOUGHT`) is recorded as unknown, the run stops, and nothing more is bought for
 *   the order until staff settle it.
 * - Weights are placeholders until the site sets `policy.kitWeightOz`.
 */

const LABELABLE = ['to-pack', 'packed']
const CLAIM_LAPSES_MS = 10 * 60_000

export type OrderLabelsResult = { state: 'made' | 'skipped' | 'busy' | 'failed'; boxes: number; bought: number; error?: string }

class LostClaim extends Error {}
class Unknown extends Error {}

const ordersOf = (o: ResolvedOptions) => o.collections.orders

/** Claims the order for this run: only one run can win, and a run that went quiet for ten minutes loses it. */
async function claim(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, run: string): Promise<boolean> {
  const r = await req.payload.update({
    collection: ordersOf(o),
    where: {
      and: [
        { id: { equals: order.id } },
        { 'kitFulfillment.status': { in: LABELABLE } },
        { or: [{ 'kitFulfillment.labels.state': { not_in: ['making', 'made'] } }, { and: [{ 'kitFulfillment.labels.state': { equals: 'making' } }, { 'kitFulfillment.labels.at': { less_than: new Date(Date.now() - CLAIM_LAPSES_MS).toISOString() } }] }] },
      ],
    },
    data: { kitFulfillment: { ...(order.kitFulfillment ?? {}), labels: { state: 'making', at: new Date().toISOString(), run, error: null } } } as never,
    overrideAccess: true,
    depth: 0,
    req: sysReq(req, audit('labels claimed')),
  })
  return r.docs.length === 1
}

/** Right before each purchase: is the order still this run's? If so, the claim is refreshed. */
async function stillMine(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, run: string) {
  const fresh = (await req.payload.find({ collection: ordersOf(o), where: { and: [{ id: { equals: order.id } }, { 'kitFulfillment.labels.state': { equals: 'making' } }, { 'kitFulfillment.labels.run': { equals: run } }] }, limit: 1, ...READ, req })).docs[0] as unknown as KitOrder | undefined
  if (!fresh) throw new LostClaim()
  await saveFulfillment(req, o, fresh, { labels: { state: 'making', at: new Date().toISOString(), run, error: null } }, 'labels claim kept')
  return fresh
}

const parcelOf = (o: ResolvedOptions, s: LabelShipping) => (t: BoxTypeDoc, kits: number) => s.parcelFor({ outside: outside(t), emptyWeightOz: t.emptyWeightOz }, kits * (o.policy?.kitWeightOz ?? KIT_WEIGHT_OZ))

async function run(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: unknown, byStaff: boolean): Promise<OrderLabelsResult> {
  const first = await inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, orderId)
    const f = order.kitFulfillment ?? {}
    if (!LABELABLE.includes(String(f.status ?? 'to-pack'))) throw new KitError('orderClosed', f.status === 'pre-order' ? 'Pre-orders get their labels when they’re released.' : 'This order has already shipped or was canceled.')
    if (!hasShipping(o)) {
      if (byStaff) shippingOf(o)
      return { done: { state: 'skipped', boxes: 0, bought: 0 } as OrderLabelsResult }
    }
    // An unclear purchase stops everything for this order until staff settle it.
    const unknown = (f.outboundLabels ?? []).some((l) => l.unknown) || (await pendingOnOrder(req.payload, order.id)).length > 0
    if (unknown) return { done: { state: 'failed', boxes: f.plan?.boxes?.length ?? 0, bought: 0, error: 'A label for this order may already have been bought: settle it before buying more.' } as OrderLabelsResult }
    const id = randomUUID()
    if (!(await claim(req, o, order, id))) return { done: { state: f.labels?.state === 'made' ? 'made' : 'busy', boxes: f.plan?.boxes?.length ?? 0, bought: 0 } as OrderLabelsResult }
    return { order, run: id }
  }).catch((error: unknown) => {
    // Another run claimed the order at the same moment: it records its own outcome.
    if (isWriteConflict(error)) return { done: { state: 'busy', boxes: 0, bought: 0 } as OrderLabelsResult }
    throw error
  })
  if ('done' in first) return first.done!
  const id = first.run
  let order = first.order
  const s = shippingOf(o)
  let bought = 0
  let boxes: SavedBox[] = order.kitFulfillment?.plan?.boxes ?? []
  try {
    const where = await inTransaction(req, async (req) => {
      const fromHub = await shipFromHub(req, o, site)
      const from = hubLabel(s, fromHub).to
      const hub = await returnHub(req, o, site)
      const { key } = hubLabel(s, hub)
      const customer = await customerAddress(req, o, s, order)
      return { from, hub, key, customer }
    })
    const returnAt = Boolean(order.kitFulfillment?.returnAt)
    const ref = (box: number | string) => `order-${String(order.id).slice(-8)}-box-${box}`
    if (!boxes.length) {
      boxes = await inTransaction(req, async (req) => {
        const total = (order.kitLines ?? []).reduce((n, l) => n + Number(l.quantity ?? 0), 0)
        const all = (await req.payload.find({ collection: 'box-types', where: scoped(o, site, { active: { equals: true } }), ...READ, req })).docs as unknown as BoxTypeDoc[]
        const parcel = parcelOf(o, s)
        // Box types too big or heavy to mail are left out, when Shipping can say.
        const types = all.map((t) => ({ ...t, id: String(t.id) })).filter((t) => !s.mailability || !parcel(t, t.kitsPerBox) || s.mailability(parcel(t, t.kitsPerBox)!).mailable)
        const price: Pricer = async (_box, p) => {
          const out = await s.quote(req.payload, { from: where.from, to: where.customer, parcel: p, reference: ref('plan') }, req)
          // Kits handed in at an event get no return label, so there's nothing to price for it.
          const back = returnAt ? null : await s.quoteReturn(req.payload, { customer: where.customer, hub: { address: where.hub.address, placeholder: where.hub.placeholder }, parcel: p, reference: ref('plan') }, req)
          return { outboundCents: out.rateCents, returnCents: back?.rateCents ?? 0 }
        }
        const plan = await planShipment(total, types, price, parcel, returnAt ? 0 : total).catch((e: unknown) => {
          throw carrierRefusal(e)
        })
        if (!plan?.boxes.length) throw new KitError('noBoxes', 'No box type fits this order. Add box types with how many kits fit.')
        if (plan.boxes.some((b) => !b.parcel)) throw new KitError('boxSize', 'A box in this order’s plan has no outside size, so it can’t get a label. Add its outside size in the admin.')
        const saved = plan.boxes.map((b) => ({ box: b.box, boxType: b.boxType, name: b.name, kits: b.kits, parcel: b.parcel }))
        await stillMine(req, o, order, id)
        await saveFulfillment(req, o, order, { plan: { boxes: saved, priced: plan.priced, totalCents: plan.totalCents, placeholderWeights: o.policy?.kitWeightOz === undefined, at: new Date().toISOString() } }, 'order box plan')
        return saved
      })
    }
    for (const b of boxes) {
      const parcel = b.parcel!
      // The outbound label: quoted and bought in one step, recorded at once.
      // An unclear answer is recorded in the step and thrown after it, so the record is committed.
      const outboundUnclear = await inTransaction(req, async (req): Promise<string | null> => {
        order = await stillMine(req, o, order, id)
        if ((order.kitFulfillment?.outboundLabels ?? []).some((l) => l.box === b.box)) return null
        const reference = ref(b.box)
        const outbound = [...(order.kitFulfillment?.outboundLabels ?? [])]
        const entry = { box: b.box, boxType: b.boxType, kits: b.kits, weightOz: parcel.weightOz, reference }
        // A purchase whose link was lost to a rollback is linked again, never bought again.
        const kept = (await rowsForSlot(req.payload, { order: order.id, kind: 'outbound', box: b.box }, ['active']))[0]
        if (kept) {
          outbound.push({ ...entry, tracking: kept.tracking, carrier: kept.carrier, service: kept.service, costCents: kept.costCents, labelUrl: kept.labelUrl, shipmentId: kept.shipmentId, mode: kept.mode, at: kept.createdAt })
        } else {
          const quote = await s.quote(req.payload, { from: where.from, to: where.customer, parcel, reference }, req).catch((e: unknown) => {
            throw carrierRefusal(e)
          })
          const made = await recordedPurchase(req.payload, o, { order: order.id, kind: 'outbound', box: b.box, site, reference, placeholderWeight: o.policy?.kitWeightOz === undefined }, () => s.buy(req.payload, quote, req))
          if (made.unknown) {
            outbound.push({ ...entry, unknown: true, at: new Date().toISOString() })
            await saveFulfillment(req, o, order, { outboundLabels: outbound }, 'outbound label unknown')
            return `The carrier’s answer for box ${b.box} was unclear: the label may have been bought. Check the carrier for ${reference} and settle it before buying more.`
          }
          const label = made.label!
          bought++
          outbound.push({ ...entry, tracking: label.tracking, carrier: label.carrier, service: label.service, costCents: label.rateCents, labelUrl: label.labelUrl, shipmentId: label.shipmentId, mode: label.mode, at: new Date().toISOString() })
        }
        await saveFulfillment(req, o, order, { outboundLabels: outbound, trackingNumbers: outbound.filter((l) => l.tracking).map((l) => l.tracking!) }, 'outbound label')
        return null
      })
      if (outboundUnclear) throw new Unknown(outboundUnclear)
      if (returnAt) continue
      const returnUnclear = await inTransaction(req, async (req): Promise<string | null> => {
        order = await stillMine(req, o, order, id)
        // Read as committed: a label bought earlier in this run, or kept from a rolled-back one, counts.
        if ((await labelsOf(req, order.id, ['active', 'buying', 'unknown'])).some((l) => l.kind === 'box' && l.box === b.box)) return null
        const made = await buyReturnLabel(req, o, s, { site, order, hub: where.hub, key: where.key, box: b.box, kind: 'box', source: 'system', parcel })
        if (made.unknown) return `The carrier’s answer for box ${b.box}’s return label was unclear: it may have been bought. Check the carrier for ${made.label.reference} and settle it before buying more.`
        bought++
        return null
      })
      if (returnUnclear) throw new Unknown(returnUnclear)
    }
    await inTransaction(req, (req) => saveFulfillment(req, o, order, { labels: { state: 'made', error: null, at: new Date().toISOString() } }, 'labels made'))
    return { state: 'made', boxes: boxes.length, bought }
  } catch (error) {
    // The order is another run's now: it records its own outcome; this one only stops.
    if (error instanceof LostClaim || isWriteConflict(error)) return { state: 'busy', boxes: boxes.length, bought }
    const known = error instanceof KitError || error instanceof Unknown
    const message = known ? (error as Error).message : 'Something went wrong making the labels.'
    if (!known) req.payload.logger.error({ err: errName(error), order: String(order.id) }, 'Sample Kits: order labels not made')
    // Recorded on its own, so staff see it (labels bought before the failure are already saved).
    await inTransaction(req, (req) => saveFulfillment(req, o, order, { labels: { state: 'failed', error: message.slice(0, 300), at: new Date().toISOString() } }, 'labels failed')).catch(() => undefined)
    // Staff are told by an error only while nothing was bought, so a purchase is never lost to their rollback.
    if (byStaff && !bought && !(error instanceof Unknown)) throw error instanceof KitError ? error : new KitError('carrier', message, { message })
    return { state: 'failed', boxes: boxes.length, bought, error: message }
  }
}

/** Kit staff, from the packing page: make the order's labels, or retry what's missing. */
export async function makeOrderLabels(req: PayloadRequest, input: { order: string }): Promise<OrderLabelsResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  return run(req, o, site, input?.order, true)
}

/**
 * Server only: make an order's labels when it becomes packable (paid, or a pre-order released). Never throws:
 * without Shipping it skips, and a failure is recorded on the order for staff, who retry from the packing page.
 */
export async function labelOrderInBackground(payload: Payload, orderId: string): Promise<OrderLabelsResult | null> {
  try {
    const o = optionsOf(payload)
    const req = await createLocalReq({}, payload)
    const { docs } = await payload.find({ collection: o.collections.orders, where: { id: { equals: orderId } }, limit: 1, ...READ })
    if (!docs[0]) return null
    return await run(req, o, siteOfRecord(o, docs[0] as Record<string, unknown>), orderId, false)
  } catch (error) {
    payload.logger.error({ err: errName(error), order: orderId }, 'Sample Kits: order labels not started')
    return null
  }
}

/** Orders whose labels failed, for the problems page (kit staff). */
export async function ordersWithLabelProblems(req: PayloadRequest) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const { docs } = await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { and: [{ 'kitFulfillment.labels.state': { equals: 'failed' } }, { 'kitFulfillment.status': { in: LABELABLE } }] }), ...READ, req })
  return (docs as unknown as KitOrder[]).map((d) => ({ id: String(d.id), error: d.kitFulfillment?.labels?.error ?? '', at: d.kitFulfillment?.labels?.at ?? null }))
}

/**
 * Cancel an unshipped order's outbound labels (kit staff; a cancellation). USPS refunds a label only within 30
 * days and never scanned: past that it's recorded "too-old" without asking. Each label keeps its answer.
 */
export async function refundOutboundLabels(req: PayloadRequest, input: { order: string }): Promise<{ box: number; refund: string }[]> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  shippingOf(o)
  const site = await siteOf(o, req)
  return refundOutboundFor(req, input?.order, site)
}

/** Server only, no access check: the same, for an order the plugin itself canceled (`site` limits it when given). */
export async function refundOutboundFor(req: PayloadRequest, orderId: unknown, site?: string): Promise<{ box: number; refund: string }[]> {
  const o = optionsOf(req.payload)
  const s = shippingOf(o)
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, orderId)
    if (order.kitFulfillment?.status === 'shipped') throw new KitError('orderClosed', 'This order has already shipped.')
    const labels: OutboundLabel[] = [...(order.kitFulfillment?.outboundLabels ?? [])]
    const out: { box: number; refund: string }[] = []
    for (const [i, l] of labels.entries()) {
      if (l.unknown || (l.refund && !l.refund.startsWith('failed'))) continue
      const refund = !l.shipmentId ? 'none' : !refundable(l.at) ? 'too-old' : await askRefund(req, s, l.shipmentId)
      labels[i] = { ...l, refund }
      out.push({ box: l.box, refund })
    }
    if (out.length) await saveFulfillment(req, o, order, { outboundLabels: labels }, 'outbound labels refunded')
    return out
  })
}

export type BoxUse = { boxType: string; name: string; orders: number; labBatches: number; total: number }

/** Which boxes get used, to guide stocking (kit staff): boxes in recent order plans and lab batches, most used first. */
export async function boxUsage(req: PayloadRequest, input: { days?: number } = {}): Promise<BoxUse[]> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const since = new Date(Date.now() - (input.days ?? 90) * 86_400_000).toISOString()
  const use = new Map<string, BoxUse>()
  const add = (b: { boxType?: unknown; name?: unknown }, kind: 'orders' | 'labBatches') => {
    const key = String(b.boxType ?? '')
    if (!key) return
    const u = use.get(key) ?? { boxType: key, name: String(b.name ?? key), orders: 0, labBatches: 0, total: 0 }
    u[kind]++
    u.total++
    use.set(key, u)
  }
  const orders = (await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { and: [{ 'kitFulfillment.plan': { exists: true } }, { createdAt: { greater_than_equal: since } }] }), ...READ, req })).docs as unknown as KitOrder[]
  for (const d of orders) if (d.kitFulfillment?.status !== 'cancelled') for (const b of d.kitFulfillment?.plan?.boxes ?? []) add(b, 'orders')
  const batches = (await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { shippedAt: { greater_than_equal: since } }), ...READ, req })).docs as unknown as { plan?: { boxes?: { boxType?: string; name?: string }[] } | null }[]
  for (const lb of batches) for (const b of lb.plan?.boxes ?? []) add(b, 'labBatches')
  return [...use.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

