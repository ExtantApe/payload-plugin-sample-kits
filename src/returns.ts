import type { PayloadRequest } from 'payload'

import { planBoxes } from './boxes.js'
import { askRefund, carrierRefusal, customerAddress, hubFor, hubLabel, type HubDoc, refundable, refundState, type RefundState, returnHub, shippingOf } from './carrier.js'
import { normalizeKitCode } from './codes.js'
import { audit, SKIP_LABEL_CANCEL, carrierCode, idOf, inTransaction, isAdmin, KitError, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { findKit, recordKitEvent } from './kits.js'
import { committedRows, type LedgerRow, PENDING, recordedPurchase, rowsForSlot, settleRow, unknownStop } from './ledger.js'
import { getKitOrder, orderKits, saveFulfillment, siteOfRecord } from './packing.js'
import { recordedRefund } from './refunds.js'
import type { KitOrder, LabelShipping, Parcel, ResolvedOptions } from './types.js'

/**
 * Prepaid return labels: one per outbound box, and an extra for a kit a keeper wants to send back early.
 * Labels are charged when they're bought, so each is a `return-labels` record with its cost and date:
 * - made to the hub's current address; when the address changes, labels of unshipped orders are listed for a
 *   reprint, which asks for the old one's refund (USPS: within 30 days, never scanned);
 * - the keeper's "Get your return label" gives the current one again at no cost;
 * - kits handed in person free their labels, which are refunded while USPS still allows it;
 * - a purchase whose outcome is unclear (Shipping's `MAYBE_BOUGHT`) is recorded as `unknown`, and nothing is
 *   bought again for that box or kit until staff settle it (`settleUnknownLabel`).
 *
 * Each purchase is committed on its own when the caller has no transaction, so a later failure never loses
 * a label that was paid for. Nothing is thrown after money has moved: the result says what happened.
 */

export type LabelDoc = {
  id: string | number
  order: unknown
  box?: number | null
  kind: 'box' | 'extra' | 'outbound'
  status: 'buying' | 'active' | 'replaced' | 'cancelled' | 'unknown' | 'not-bought'
  kits?: unknown[] | null
  tracking?: string | null
  costCents?: number | null
  labelUrl?: string | null
  shipmentId?: string | null
  hub?: unknown
  addressKey?: string | null
  mode?: string | null
  refund?: string | null
  reference?: string | null
  createdAt: string
  [field: string]: unknown
}

const returnParcel = (o: ResolvedOptions): Parcel => ({ weightOz: o.policy?.returnWeightOz ?? 8 })

/** Kits that go back by post. One handed in person needs no label. */
export const returnsByMail = <K extends Record<string, unknown>>(kits: K[]) => kits.filter((k) => !(typeof k.returnInPerson === 'string' && k.returnInPerson.trim()))

/** How many outbound boxes the order goes in: the plan its labels were made from, else the packing plan (at least one). */
export async function boxCount(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, kits: number, saved?: unknown): Promise<number> {
  const planned = (saved as { boxes?: unknown[] } | null | undefined)?.boxes?.length
  if (planned) return planned
  const types = (await req.payload.find({ collection: 'box-types', where: scoped(o, site, { active: { equals: true } }), ...READ, req })).docs as unknown as { id: string; name: string; kitsPerBox: number; emptyWeightOz?: number | null }[]
  const plan = planBoxes(kits, types.map((b) => ({ id: String(b.id), name: String(b.name), kitsPerBox: Number(b.kitsPerBox), emptyWeightOz: b.emptyWeightOz ?? null })))
  return Math.max(1, plan?.boxes.length ?? 1)
}

/** An order's return labels in these states, by box, as committed (the rows are written outside transactions). */
export const labelsOf = async (req: PayloadRequest, order: unknown, statuses: LabelDoc['status'][] = ['active']) =>
  (await committedRows(req.payload, { and: [{ order: { equals: idOf(order) } }, { status: { in: statuses } }, { kind: { in: ['box', 'extra'] } }] })) as unknown as LabelDoc[]

export type Bought = { label: LabelDoc; unknown: boolean }

/**
 * Buys one return label. Its record is written and settled outside the caller's transaction (`ledger.ts`), so
 * a paid label survives any rollback; the kits' trail is written in the caller's transaction. A clear refusal
 * throws (nothing was bought); an unclear answer comes back as `unknown`, never thrown. Refused while a label
 * for the same box (or, for an extra, the same kit) is `buying` or `unknown`.
 */
export async function buyReturnLabel(
  req: PayloadRequest,
  o: ResolvedOptions,
  s: LabelShipping,
  ctx: { site: string | undefined; order: KitOrder; hub: HubDoc; key: string; box: number | null; kind: 'box' | 'extra'; kits?: string[]; source: 'admin' | 'customer' | 'system'; parcel?: Parcel },
): Promise<Bought> {
  const customer = await customerAddress(req, o, s, ctx.order)
  const reference = `order-${String(ctx.order.id).slice(-8)}-${ctx.kind}-${ctx.box ?? ctx.kits?.[0]?.slice(-6)}`
  const covered = ctx.kits?.length ? ctx.kits : (await orderKits(req, o, ctx.site, ctx.order)).kits.map((k) => String(k.id))
  const kitStub = (id: string) => ({ id, ...(o.scope ? { [o.scope.field]: ctx.site } : {}) })
  const slot = { order: ctx.order.id, kind: ctx.kind, box: ctx.kind === 'box' ? ctx.box : null, kit: ctx.kind === 'extra' ? (ctx.kits?.[0] ?? null) : null }
  const made = await recordedPurchase(req.payload, o, { ...slot, site: ctx.site, kits: ctx.kits, hub: ctx.hub.id, addressKey: ctx.key, reference, placeholderWeight: !ctx.parcel }, () =>
    s.buyReturn(req.payload, { customer, hub: { address: ctx.hub.address, placeholder: ctx.hub.placeholder }, parcel: ctx.parcel ?? returnParcel(o), carrier: 'USPS', reference }, req),
  )
  const label = made.row as unknown as LabelDoc
  if (made.unknown) {
    for (const id of covered)
      await recordKitEvent(req, kitStub(id), { type: 'note', source: ctx.source === 'customer' ? 'customer' : 'system', order: String(ctx.order.id), note: `A return label may have been bought (the carrier’s answer was unclear). Check the carrier for ${reference} before buying again.`, details: { returnLabel: String(label.id), reference, unknown: true } })
    return { label, unknown: true }
  }
  for (const id of covered)
    await recordKitEvent(req, kitStub(id), { type: 'label-printed', source: ctx.source, order: String(ctx.order.id), hub: String(ctx.hub.id), details: { returnLabel: String(label.id), tracking: made.label!.tracking, kind: ctx.kind, box: ctx.box } })
  return { label, unknown: false }
}

// ---------------------------------------------------------------- one per box

export type OrderLabels = { made: number; current: number; unknown: number; labels: { box: number | null; kind: string; tracking: string; labelUrl: string }[]; error?: string }

/**
 * One return label per outbound box (kit staff), to the hub's current address. Boxes that already have one keep
 * it, so nothing is bought twice; a label for an old address must be reprinted first.
 */
export async function makeOrderReturnLabels(req: PayloadRequest, input: { order: string; hub?: string }): Promise<OrderLabels> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const s = shippingOf(o)
  const site = await siteOf(o, req)
  const prep = await inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input?.order)
    const status = order.kitFulfillment?.status
    if (status === 'shipped' || status === 'cancelled') throw new KitError('orderClosed', 'This order has already shipped or was canceled.')
    const { kits, total } = await orderKits(req, o, site, order)
    if (kits.length < total) throw new KitError('notPacked', `Pack all ${total} kits first (${kits.length} so far).`, { total, packed: kits.length })
    const hub = await hubFor(req, o, site, input.hub)
    const { key } = hubLabel(s, hub)
    const existing = (await labelsOf(req, order.id, ['active', 'buying', 'unknown'])).filter((l) => l.kind === 'box')
    if (existing.some((l) => l.status === 'active' && l.addressKey !== key)) throw new KitError('staleLabel', 'Some of this order’s return labels are for the hub’s old address. Reprint them first.')
    const byMail = returnsByMail(kits).length
    const boxes = byMail ? await boxCount(req, o, site, byMail, order.kitFulfillment?.plan) : 0
    return { order, hub, key, existing, boxes }
  })
  const { order, hub, key, existing, boxes } = prep
  let made = 0
  let error: string | undefined
  for (let box = 1; box <= boxes && !error; box++) {
    if (existing.some((l) => l.box === box)) continue
    try {
      const b = await inTransaction(req, (req) => buyReturnLabel(req, o, s, { site, order, hub, key, box, kind: 'box', source: 'admin' }))
      existing.push(b.label)
      if (b.unknown) error = unknownStop().message
      else made++
    } catch (e) {
      // Nothing bought in this run yet: refuse as usual. After a purchase, report instead, so it stays recorded.
      if (!made) throw e
      error = e instanceof KitError ? e.message : 'Something went wrong buying the labels.'
    }
  }
  const unknown = existing.filter((l) => l.status === 'unknown' || l.status === 'buying').length
  return {
    made,
    current: existing.length - made - unknown,
    unknown,
    labels: existing.filter((l) => l.status === 'active').map((l) => ({ box: l.box ?? null, kind: l.kind, tracking: l.tracking ?? '', labelUrl: l.labelUrl ?? '' })),
    ...(error || unknown ? { error: error ?? unknownStop().message } : {}),
  }
}

/** Active labels of unshipped orders that point at an older address of their hub (kit staff). */
export async function staleReturnLabels(req: PayloadRequest) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const s = shippingOf(o)
  const site = await siteOf(o, req)
  const labels = (await req.payload.find({ collection: 'return-labels', where: scoped(o, site, { and: [{ status: { equals: 'active' } }, { kind: { not_equals: 'outbound' } }] }), sort: 'createdAt', ...READ, req })).docs as unknown as LabelDoc[]
  const keys = new Map<string, string | null>()
  const out: { id: string; order: string; box: number | null; tracking: string; createdAt: string; refundable: boolean }[] = []
  for (const l of labels) {
    const h = idOf(l.hub) ?? ''
    if (!keys.has(h)) {
      const hub = await hubFor(req, o, site, h || null).catch(() => null)
      let k: string | null = null
      try {
        k = hub ? hubLabel(s, hub).key : null
      } catch {
        k = null
      }
      keys.set(h, k)
    }
    const key = keys.get(h)
    if (!key || l.addressKey === key) continue
    const { docs } = await req.payload.find({ collection: o.collections.orders, where: { id: { equals: idOf(l.order) } }, limit: 1, ...READ, req })
    const order = docs[0] as unknown as KitOrder | undefined
    if (order && order.kitFulfillment?.status !== 'shipped') out.push({ id: String(l.id), order: idOf(l.order)!, box: l.box ?? null, tracking: l.tracking ?? '', createdAt: l.createdAt, refundable: refundable(l.createdAt) })
  }
  return out
}

/** Retires a label: asks for its refund while USPS still allows it ("too-old" after), and marks it replaced. */
async function retire(req: PayloadRequest, s: LabelShipping, label: LabelDoc) {
  const refund = !label.shipmentId ? 'none' : refundable(label.createdAt) ? await askRefund(req, s, label.shipmentId) : 'too-old'
  await settleRow(req.payload, label.id, { status: 'replaced', refund })
  return refund
}

/**
 * Reprint a label of an unshipped order for the hub's current address (kit staff). The new label is bought
 * first: if that fails, the old one stays active and nothing is refunded. Then the old one is refunded.
 */
export async function reprintReturnLabel(req: PayloadRequest, input: { label: string; hub?: string }) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const s = shippingOf(o)
  const site = await siteOf(o, req)
  const { label, order, hub, key } = await inTransaction(req, async (req) => {
    const { docs } = await req.payload.find({ collection: 'return-labels', where: scoped(o, site, { id: { equals: idOf(input?.label) ?? '' } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))
    const label = docs[0] as unknown as LabelDoc | undefined
    if (!label || label.status !== 'active' || label.kind === 'outbound') throw new KitError('noLabel', 'That return label isn’t here, or was already replaced.')
    const order = await getKitOrder(req, o, site, label.order)
    if (order.kitFulfillment?.status === 'shipped') throw new KitError('notPackedNow', 'This order has shipped; the keeper can get a new label from their kits page.')
    const hub = await hubFor(req, o, site, input.hub ?? idOf(label.hub))
    const { key } = hubLabel(s, hub)
    if (label.addressKey === key) throw new KitError('labelCurrent', 'This label already has the hub’s current address.')
    return { label, order, hub, key }
  })
  const made = await inTransaction(req, (req) => buyReturnLabel(req, o, s, { site, order, hub, key, box: label.box ?? null, kind: label.kind as 'box' | 'extra', kits: (label.kits ?? []).map((k) => idOf(k)!), source: 'admin' }))
  if (made.unknown) return { result: 'unknown' as const, refund: null, tracking: '', labelUrl: '' }
  const refund = await inTransaction(req, (req) => retire(req, s, label))
  return { result: 'made' as const, refund, tracking: made.label.tracking ?? '', labelUrl: made.label.labelUrl ?? '' }
}


/**
 * The keeper's "Get your return label" for a kit they bought or activated: the order's current box label again
 * at no cost, or a new one if none points at the hub's current address (the old one is then retired). With
 * `extra`, one label of its own for this kit; asking again gives the same one.
 */
export async function customerReturnLabel(req: PayloadRequest, input: { code: string; extra?: boolean }) {
  const o = optionsOf(req.payload)
  const user = personOf(o, req)
  if (!user) throw new KitError('signIn', 'Sign in to do that.')
  const s = shippingOf(o)
  const site = await siteOf(o, req)
  const code = normalizeKitCode(input?.code)
  const prep = await inTransaction(req, async (req) => {
    const kit = code ? await findKit(req, code, site) : null
    if (!kit || (String(user.id) !== idOf(kit.buyer) && String(user.id) !== idOf(kit.activatedBy))) throw new KitError('notYourKit', 'That kit isn’t one you’ve activated.')
    if (!returnsByMail([kit]).length) throw new KitError('returnInPerson', `Kit ${kit.code} is being handed in at ${kit.returnInPerson}, so it doesn’t need a return label.`, { code: kit.code, event: String(kit.returnInPerson) })
    if (!['shipped', 'delivered', 'activated', 'sampled'].includes(kit.status)) throw new KitError('noReturnLabel', `Kit ${kit.code} is ${kit.status}, so it doesn’t need a return label now.`, { code: kit.code, status: kit.status })
    if (!idOf(kit.order)) throw new KitError('notSold', `Kit ${kit.code} wasn’t sold, so there’s no label for it.`, { code: kit.code })
    const order = await getKitOrder(req, o, site, kit.order)
    const hub = await returnHub(req, o, site)
    const { key } = hubLabel(s, hub)
    const all = await labelsOf(req, order.id, ['active', 'buying', 'unknown'])
    const mine = input.extra ? all.filter((l) => l.kind === 'extra' && (l.kits ?? []).some((k) => idOf(k) === String(kit.id))) : all.filter((l) => l.kind === 'box')
    return { kit, order, hub, key, mine }
  })
  const { kit, order, hub, key, mine } = prep
  const current = mine.find((l) => l.status === 'active' && l.addressKey === key)
  if (current) return { result: 'current' as const, labelUrl: current.labelUrl ?? '', tracking: current.tracking ?? '' }
  // A `buying` or `unknown` label for this box or kit is refused by the record keeper, before the carrier is asked.
  const stale = mine.find((l) => l.status === 'active')
  const made = await inTransaction(req, (req) => buyReturnLabel(req, o, s, { site, order, hub, key, ...(input.extra ? { box: null, kind: 'extra' as const, kits: [String(kit.id)] } : { box: stale?.box ?? 1, kind: 'box' as const }), source: 'customer' }))
  if (made.unknown) return { result: 'unknown' as const, labelUrl: '', tracking: '' }
  if (stale) await inTransaction(req, (req) => retire(req, s, stale))
  return { result: 'made' as const, labelUrl: made.label.labelUrl ?? '', tracking: made.label.tracking ?? '' }
}

/** Return-label spend with production labels, for reporting (kit staff). Lost: retired without its money back. */
export async function returnLabelSpend(req: PayloadRequest) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const labels = (await req.payload.find({ collection: 'return-labels', where: scoped(o, site, { and: [{ mode: { equals: 'production' } }, { kind: { not_equals: 'outbound' } }] }), ...READ, req })).docs as unknown as LabelDoc[]
  return labels.reduce(
    (t, l) => {
      t.labels++
      t.cents += l.costCents ?? 0
      if (l.status !== 'active' && l.refund !== 'submitted' && l.refund !== 'refunded') t.lostCents += l.costCents ?? 0
      return t
    },
    { labels: 0, cents: 0, lostCents: 0 },
  )
}

/** A label already refused or too late stays as it is; a failure can be tried again. */
const settled = (l: LabelDoc) => ['refused', 'too-late'].includes(refundState(l.refund) ?? '')

/**
 * Ask for one unused label's refund. Past USPS's 30 days nothing is asked and it's recorded as too late. A
 * refusal keeps the label usable and records the carrier's words; only a requested refund retires it.
 */
async function cancelLabel(req: PayloadRequest, s: LabelShipping, label: LabelDoc): Promise<RefundState> {
  const save = (data: Record<string, unknown>) => settleRow(req.payload, label.id, data)
  if (!refundable(label.createdAt)) {
    await save({ refund: 'too-old' })
    return 'too-late'
  }
  const answer = label.shipmentId ? await askRefund(req, s, label.shipmentId) : 'not_applicable'
  const state = refundState(answer)!
  await save(state === 'refused' || state === 'failed' ? { refund: answer } : { status: 'cancelled', refund: answer })
  return state
}

export type CanceledLabel = { label: string; tracking: string; box: number | null; kind: string; result: RefundState }

/**
 * Server only: the return labels an order no longer needs once some kits come back in person. Box labels are
 * interchangeable, so it keeps as many as the kits going back by post need and asks for the rest to be
 * refunded, the last boxes first; an extra label goes when its kit comes back in person.
 */
export async function cancelUnneededReturnLabels(req: PayloadRequest, orderId: string): Promise<CanceledLabel[]> {
  const o = optionsOf(req.payload)
  const s = shippingOf(o)
  const { docs } = await req.payload.find({ collection: o.collections.orders, where: { id: { equals: orderId } }, limit: 1, ...READ, req })
  const found = docs[0] as unknown as KitOrder | undefined
  if (!found) return []
  const site = siteOfRecord(o, found)
  const order = await getKitOrder(req, o, site, orderId)
  const { kits } = await orderKits(req, o, site, order)
  const byMail = returnsByMail(kits)
  const needed = byMail.length ? await boxCount(req, o, site, byMail.length) : 0
  const active = await labelsOf(req, orderId)
  const boxes = active.filter((l) => l.kind === 'box').sort((a, b) => (b.box ?? 0) - (a.box ?? 0))
  const spare = Math.max(0, boxes.length - needed)
  const inPerson = new Set(kits.filter((k) => !returnsByMail([k]).length).map((k) => String(k.id)))
  const toCancel = [
    ...boxes.filter((l) => !settled(l)).slice(0, spare),
    ...active.filter((l) => l.kind === 'extra' && !settled(l) && (l.kits ?? []).length > 0 && (l.kits ?? []).every((k) => inPerson.has(idOf(k)!))),
  ]
  const actor = personOf(o, req)
  const out: CanceledLabel[] = []
  for (const l of toCancel) {
    const result = await cancelLabel(req, s, l)
    out.push({ label: String(l.id), tracking: l.tracking ?? '', box: l.box ?? null, kind: l.kind, result })
    for (const k of kits.filter((k) => inPerson.has(String(k.id))))
      await recordKitEvent(req, k, { type: 'note', actor, source: actor ? 'admin' : 'system', order: orderId, note: `Return label ${l.tracking ?? ''} not needed (returned in person): refund ${result}.`, details: { returnLabel: String(l.id), refund: result } })
  }
  return out
}

/** Kit staff: mark the chosen kits (or all) as coming back in person, then cancel the labels that frees. */
export async function cancelReturnLabels(req: PayloadRequest, input: { order: string; kits: string[] | 'all'; where: string }) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  shippingOf(o)
  const site = await siteOf(o, req)
  const where = String(input?.where ?? '').trim().slice(0, 200)
  if (!where) throw new KitError('returnWhere', 'Say where the kits come back: the event or the hub.')
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input.order)
    const { kits } = await orderKits(req, o, site, order)
    const chosen = input.kits === 'all' ? kits : kits.filter((k) => Array.isArray(input.kits) && (input.kits.includes(String(k.id)) || input.kits.includes(k.code)))
    if (!chosen.length) throw new KitError('chooseKits', 'Tick the kits that come back in person.')
    for (const k of chosen)
      if (!(typeof k.returnInPerson === 'string' && k.returnInPerson.trim()))
        await req.payload.update({ collection: 'kits', id: k.id, data: { returnInPerson: where } as never, overrideAccess: true, depth: 0, req: sysReq(req, { ...audit('returns in person'), [SKIP_LABEL_CANCEL]: true }) })
    return cancelUnneededReturnLabels(req, String(order.id))
  })
}

export { SKIP_LABEL_CANCEL }

/** Server only: the carrier's later answer to a refund asked for. "requested" becomes refunded or refused. */
export async function applyRefundEvent(req: PayloadRequest, ev: { tracking: string; status: string }): Promise<'updated' | 'unknown-label' | 'unchanged'> {
  const o = optionsOf(req.payload)
  return inTransaction(req, async (req) => {
    const label = (await req.payload.find({ collection: 'return-labels', where: { and: [{ tracking: { equals: ev.tracking } }, { kind: { not_equals: 'outbound' } }] }, limit: 1, ...READ, req })).docs[0] as unknown as LabelDoc | undefined
    if (label) {
      if (label.refund !== 'submitted' || ev.status === 'submitted') return 'unchanged'
      await settleRow(req.payload, label.id, { refund: ev.status })
      return 'updated'
    }
    const order = (await req.payload.find({ collection: o.collections.orders, where: { 'kitFulfillment.outboundLabels.tracking': { equals: ev.tracking } }, limit: 1, ...READ, req })).docs[0] as unknown as KitOrder | undefined
    const labels = order?.kitFulfillment?.outboundLabels ?? []
    const i = labels.findIndex((l) => l.tracking === ev.tracking)
    if (!order || i < 0) return 'unknown-label'
    if (labels[i]!.refund !== 'submitted' || ev.status === 'submitted') return 'unchanged'
    await saveFulfillment(req, o, order, { outboundLabels: labels.map((l, j) => (j === i ? { ...l, refund: ev.status } : l)) }, 'label refund answered')
    return 'updated'
  })
}

// ---------------------------------------------------------------- labels whose purchase is unknown

export type FoundLabel = { tracking: string; shipmentId: string; labelUrl?: string; costCents?: number; carrier?: string; service?: string; mode?: string }

/**
 * Kit staff, after checking the carrier for the label's reference: either it was bought (`found`, and it
 * becomes an ordinary label), or it wasn't (`found` null, and another may be bought). A return label is
 * named by `label`; an outbound label by `order` and `box`.
 */
export async function settleUnknownLabel(req: PayloadRequest, input: { label?: string; order?: string; box?: number; found: FoundLabel | null }) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const found = input?.found ?? null
  if (found && (!/^[A-Z0-9]{8,40}$/i.test(String(found.tracking ?? '')) || !String(found.shipmentId ?? '').trim())) throw new KitError('labelDetails', 'Give the label’s tracking number and the carrier’s shipment id, as the carrier shows them.')
  const fields = found ? { tracking: found.tracking.toUpperCase(), shipmentId: found.shipmentId.trim(), labelUrl: found.labelUrl ?? null, costCents: Number.isInteger(found.costCents) ? found.costCents : null, carrier: found.carrier ?? null, service: found.service ?? null, mode: found.mode ?? null } : {}
  return inTransaction(req, async (req) => {
    // The row: named, or the outbound one for the order's box. Read as committed, since it's written outside transactions.
    let row: LedgerRow | undefined
    let orderId: unknown
    if (input.label) {
      row = (await committedRows(req.payload, scoped(o, site, { and: [{ id: { equals: idOf(input.label) ?? '' } }, { status: { in: [...PENDING] } }] })).catch(() => []))[0]
      if (!row) throw new KitError('noLabel', 'That label isn’t waiting to be settled.')
      orderId = row.order
    } else {
      orderId = input.order
    }
    const order = await getKitOrder(req, o, site, orderId)
    if (!input.label) row = (await rowsForSlot(req.payload, { order: order.id, kind: 'outbound', box: input.box }, PENDING))[0]
    const labels = order.kitFulfillment?.outboundLabels ?? []
    const box = row ? row.box : input.box
    const i = labels.findIndex((l) => l.box === box && l.unknown)
    if (!row && i < 0) throw new KitError('noLabel', 'That label isn’t waiting to be settled.')
    // The record first, outside the transaction, like every write to it.
    if (row) await settleRow(req.payload, row.id, found ? { ...fields, status: 'active' } : { status: 'not-bought' })
    if (!row || row.kind === 'outbound') {
      const entry = { box: box!, ...fields, unknown: false, reference: row?.reference ?? labels[i]?.reference ?? null, at: new Date().toISOString() }
      const kept = labels.filter((_, j) => j !== i)
      const next = found ? [...kept, i >= 0 ? { ...labels[i], ...entry } : entry].sort((a, b) => a.box - b.box) : kept
      await saveFulfillment(req, o, order, { outboundLabels: next, trackingNumbers: next.filter((l) => l.tracking).map((l) => l.tracking!) }, 'unknown label settled')
    }
    return { result: found ? ('bought' as const) : ('not-bought' as const) }
  })
}

// ---------------------------------------------------------------- refund shipping

/** What "refund shipping" offers: the shipping paid, its return part, and whether it's done. */
export async function shippingRefundOffer(req: PayloadRequest, o: ResolvedOptions, order: KitOrder) {
  const paidRaw = o.orders?.shippingPaidCents ? await o.orders.shippingPaidCents({ order, req }) : Math.min(Number((order.totals as { shipping?: unknown } | undefined)?.shipping) || 0, Number(order.amount) || 0)
  const paid = Math.max(0, Math.floor(Number(paidRaw) || 0))
  const suggested = Math.min(Number(order.kitFulfillment?.returnShippingCents) || 0, paid)
  const done = order.kitFulfillment?.shippingRefund?.status ? order.kitFulfillment.shippingRefund : null
  return { paidCents: paid, suggestedCents: suggested || null, done }
}

/**
 * Give an order's shipping back as goodwill, for kits handed back in person (site admins): once per order,
 * never more than the shipping paid, with a reason, through `payments.refund` with a fixed key, so a retry
 * can't refund twice. If the payment provider throws, nothing is recorded and nothing should have moved.
 */
export async function refundShipping(req: PayloadRequest, input: { order: string; amountCents: number; reason: string }) {
  const o = optionsOf(req.payload)
  const user = personOf(o, req)
  // The same answer for "not allowed" and "no such order", so nothing is learned about other sites' orders.
  const refuse = () => new KitError('notAllowed', 'Only the site’s administrators can refund shipping.')
  if (!user || !(await isAdmin(o, req))) throw refuse()
  if (!o.payments?.refund) throw new KitError('noPayments', 'Payments aren’t set up here, so nothing can be refunded.')
  const site = await siteOf(o, req)
  const reason = String(input?.reason ?? '').trim().slice(0, 300)
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input?.order).catch(() => {
      throw refuse()
    })
    const offer = await shippingRefundOffer(req, o, order)
    if (offer.done) throw new KitError('alreadyRefunded', 'This order’s shipping has already been refunded.')
    if (!reason) throw new KitError('refundReason', 'Say why, in a few words. It’s kept with the order.')
    const amount = Number(input.amountCents)
    if (!Number.isInteger(amount) || amount <= 0) throw new KitError('refundAmount', 'Enter an amount above zero.')
    if (amount > offer.paidCents) throw new KitError('refundTooMuch', `At most ${(offer.paidCents / 100).toFixed(2)}: the shipping paid on this order.`, { max: (offer.paidCents / 100).toFixed(2) })
    const at = new Date().toISOString()
    // Claimed first, so two clicks (or two admins) can't both send one.
    const claimed = await req.payload.update({
      collection: o.collections.orders,
      where: { and: [{ id: { equals: order.id } }, { 'kitFulfillment.shippingRefund.status': { not_in: ['pending', 'refunded'] } }] },
      data: { kitFulfillment: { ...(order.kitFulfillment ?? {}), shippingRefund: { status: 'pending', amountCents: amount, reason, by: user.id, at } } } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('shipping refund claimed')),
    })
    if (claimed.docs.length !== 1) throw new KitError('alreadyRefunded', 'This order’s shipping has already been refunded.')
    // The money, through the refund record kept outside the transaction: one refund at a time per order, and never
    // more than what's left of the payment once every other refund on it is counted.
    const done = await recordedRefund(req, o, { order, site, kind: 'shipping', key: `kit-return-shipping-${order.id}`, reason, by: user.id, amount: () => amount })
    await saveFulfillment(req, o, order, { shippingRefund: { status: 'refunded', amountCents: amount, reason, by: user.id, at, refundId: done.refundId } }, 'return shipping refunded')
    return { amountCents: amount, refundId: done.refundId! }
  })
}

