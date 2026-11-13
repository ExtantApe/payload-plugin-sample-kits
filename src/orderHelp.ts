import type { PayloadRequest } from 'payload'

import { hasShipping, refundState } from './carrier.js'
import { errName, afterCommit, audit, freshReq, idOf, inTransaction, isAdmin, KitError, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { recordKitEvent } from './kits.js'
import { committedRows } from './ledger.js'
import { refundOutboundFor } from './orderLabels.js'
import { kittingAfterCommit, kittingOf, releaseUnits, requireSharedTransaction } from './kitting.js'
import { buyerOf, getKitOrder, saveFulfillment, unpackedFields } from './packing.js'
import { vote } from './preorders.js'
import { storeDay } from './pricing.js'
import { recordedRefund, refundableOf, refundRows } from './refunds.js'
import { cancelUnneededReturnLabels } from './returns.js'
import { dateOnly, FIXED_CASES, MISSED_CHOICES, REASONS, type MissedChoice, type Reason } from './terms.js'
import type { HelpRequest, KitDoc, KitOrder, ResolvedOptions } from './types.js'

/**
 * Order help on the buyer's order page, and staff's decisions:
 * - for the refund window after ordering (`policy.refundWithinDays`, default 30), "Request a refund": unshipped
 *   orders and pre-orders are refunded at once, in full, shipping included; shipped kits go to staff, since they have
 *   to come back;
 * - after that, until the promised date, "Get help with my order": the subject died or was rehomed, a duplicate
 *   order, or hardship cancel at once, keeping back only the postage that can't be recovered (shown before
 *   confirming, never more than shown); anything else goes to staff;
 * - once a pre-order's promised date has passed unshipped, the buyer chooses: wait, move the vote (when the site has
 *   votes), take credit (when the site gives credits), or a full refund, which is always one of the choices.
 * Every request and decision is kept on the order. Refunds go through `payments.refund`, recorded outside the
 * transaction with one refund at a time per order, and never more than was paid, every refund counted.
 */

const DAY = 86_400_000
const tzOf = (o: ResolvedOptions) => o.policy?.storeTimeZone ?? 'UTC'
const windowOf = (o: ResolvedOptions) => o.policy?.refundWithinDays ?? 30

/** Whole calendar days, in the store's time zone, from the order's day to `now`: 0 on the day of ordering. */
export const daysSinceOrder = (createdAt: string, now: Date, timeZone = 'UTC') => Math.round((Date.parse(storeDay(now, timeZone)) - Date.parse(storeDay(createdAt, timeZone))) / DAY)

export type HelpPhase = 'refund' | 'help' | 'missed' | 'closed'

/** Where an order stands for its buyer on `now`. */
export function helpPhase(o: ResolvedOptions, order: KitOrder, now = new Date()): { phase: HelpPhase; daysLeft: number; shipped: boolean; promisedBy: string | null; missed: boolean } {
  const f = order.kitFulfillment ?? {}
  const shipped = f.status === 'shipped'
  const promisedBy = f.promisedBy ? dateOnly(f.promisedBy) : null
  const missed = Boolean(promisedBy && !shipped && f.status !== 'cancelled' && storeDay(now, tzOf(o)) > promisedBy)
  const days = daysSinceOrder(String(order.createdAt ?? now.toISOString()), now, tzOf(o))
  const daysLeft = Math.max(0, windowOf(o) - days)
  if (f.status === 'cancelled' || f.orderRefund?.status) return { phase: 'closed', daysLeft: 0, shipped, promisedBy, missed: false }
  if (missed) return { phase: 'missed', daysLeft, shipped, promisedBy, missed }
  return { phase: days <= windowOf(o) ? 'refund' : 'help', daysLeft, shipped, promisedBy, missed }
}

type Postage = { mode?: string | null; costCents?: number | null; refund?: string | null; active: boolean; at: string }

/** An order's postage: its return labels, and the outbound labels bought at order time (their refunds are on the order). */
async function postageOf(req: PayloadRequest, order: KitOrder): Promise<Postage[]> {
  const rows = await committedRows(req.payload, { and: [{ order: { equals: idOf(order.id) } }, { kind: { not_equals: 'outbound' } }, { status: { in: ['active', 'replaced', 'cancelled'] } }] })
  const returns = rows.map((l) => ({ mode: l.mode, costCents: l.costCents, refund: l.refund, active: l.status === 'active', at: l.createdAt }))
  const outbound = (order.kitFulfillment?.outboundLabels ?? []).filter((l) => l.tracking && !l.unknown).map((l) => ({ mode: l.mode, costCents: l.costCents, refund: l.refund, active: !l.refund, at: l.at ?? new Date(0).toISOString() }))
  return [...returns, ...outbound]
}

/** Real postage that can't come back: production labels refused or past USPS's window, or still active and already past it. Test labels cost nothing. */
const unrecoverable = (labels: Postage[], now: Date) =>
  labels
    .filter((l) => l.mode === 'production' && (['too-late', 'refused'].includes(refundState(l.refund) ?? '') || (l.active && !l.refund && now.getTime() - Date.parse(l.at) >= 30 * DAY)))
    .reduce((n, l) => n + (Number(l.costCents) || 0), 0)

/** The buyer's own kit order on this site. The same answer for "no such order", "another site's" and "not yours". */
async function buyersOrder(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, orderId: unknown): Promise<KitOrder> {
  const me = personOf(o, req)
  const order = await getKitOrder(req, o, site, orderId).catch(() => null)
  if (!me || !order || buyerOf(o, order) !== String(me.id)) throw new KitError('noOrder', 'That order wasn’t found.')
  return order
}

/** The reasons the help form offers and accepts: `damaged` only when `orderHelp.reasons.damaged` is on (off by default). */
export const helpReasons = (o: Pick<ResolvedOptions, 'orderHelp'>): Reason[] => REASONS.filter((r) => r !== 'damaged' || o.orderHelp?.reasons?.damaged === true)

/** What the buyer's page offers: the phase, what's left of the payment, and for the after-window cases what would be kept back. */
export async function helpOptions(req: PayloadRequest, input: { order: string; now?: Date }) {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('noOrder', 'That order wasn’t found.')
  const site = await siteOf(o, req)
  const now = input?.now ?? new Date()
  const order = await buyersOrder(req, o, site, input?.order)
  const state = helpPhase(o, order, now)
  const left = await refundableOf(req, o, order)
  const keptBack = state.phase === 'help' && !state.shipped ? Math.min(left, unrecoverable(await postageOf(req, order), now)) : 0
  return {
    ...state,
    refundableCents: left,
    keptBackCents: keptBack,
    reasons: helpReasons(o),
    canCredit: Boolean(o.payments?.creditOrder),
    canMoveVote: Boolean(o.onPreorderVote && order.kitFulfillment?.preorderVote?.vote),
    requests: order.kitFulfillment?.requests ?? [],
    revisedBy: order.kitFulfillment?.revisedBy ? dateOnly(order.kitFulfillment.revisedBy) : null,
  }
}

const pushRequest = async (req: PayloadRequest, o: ResolvedOptions, order: KitOrder, entry: HelpRequest) => {
  const fresh = (await req.payload.findByID({ collection: o.collections.orders, id: order.id, overrideAccess: true, depth: 0, req })) as unknown as KitOrder
  const requests = [...(fresh.kitFulfillment?.requests ?? []).map((r) => ({ ...r, id: undefined })), entry]
  await saveFulfillment(req, o, order, { requests }, `order ${entry.kind}: ${entry.outcome}`)
}

type CancelOpts = { mode: 'refund' | 'credit'; keepBackUpTo?: number; keepVote?: boolean; why: string; now: Date }

/**
 * Cancel an unshipped order, in the caller's transaction: claimed first (so it can't run twice), then the money
 * (`keepBackUpTo`: postage that can't be recovered, never more than that), then kits packed into it go back to stock,
 * credits come back, and the order is marked canceled. After the commit, labels it no longer needs are refunded and
 * the vote withdrawn. If anything throws after the money moved, the refund's record stays, and a retry refunds only
 * what's left.
 */
async function cancelOrder(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, order: KitOrder, opts: CancelOpts, outer: PayloadRequest) {
  const actor = personOf(o, req)
  if (opts.mode === 'credit' && !o.payments?.creditOrder) throw new KitError('noCredit', 'Credit isn’t offered here. Choose a refund instead.')
  await requireSharedTransaction(o, req)
  // The claim, in the transaction: a second cancellation of the same order waits, then finds it taken.
  const claimed = await req.payload.update({
    collection: o.collections.orders,
    where: { and: [{ id: { equals: order.id } }, { 'kitFulfillment.orderRefund.status': { exists: false } }, { 'kitFulfillment.status': { not_in: ['shipped', 'cancelled'] } }] },
    data: { kitFulfillment: { ...(order.kitFulfillment ?? {}), orderRefund: { status: 'pending', at: new Date().toISOString(), by: actor?.id ?? null } } } as never,
    overrideAccess: true,
    depth: 0,
    req: sysReq(req, audit('order cancel claimed')),
  })
  if (claimed.docs.length !== 1) throw new KitError('alreadyCancelled', 'This order has already been canceled or has shipped.')
  // Kitting wired: the order's units go back to ready and its build requests end, before any money moves, so a
  // refusal from Kitting leaves everything as it was.
  if (kittingOf(o)) {
    await releaseUnits(req, o, site, String(order.id))
    kittingAfterCommit(o, outer)
  }
  // Money first, so a refusal leaves everything as it was.
  const keepable = opts.keepBackUpTo ? Math.min(opts.keepBackUpTo, unrecoverable(await postageOf(req, order), opts.now)) : 0
  let kept = 0
  const refund =
    opts.mode === 'refund'
      ? await recordedRefund(req, o, { order, site, kind: 'order', key: `kit-order-refund-${order.id}`, reason: opts.why, by: actor?.id, amount: (left) => ((kept = Math.min(keepable, left)), left - kept) })
      : { amountCents: 0, refundId: null }
  const packed = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { and: [{ order: { equals: order.id } }, { status: { equals: 'packed' } }] }), ...READ, req })).docs as unknown as KitDoc[]
  for (const k of packed) await recordKitEvent(req, k, { type: 'unpacked', order: String(order.id), source: actor ? 'admin' : 'system', note: `Order canceled: ${opts.why}`.slice(0, 300), set: { ...unpackedFields(o), attempt: 1 } })
  const credits = o.payments?.creditOrder ? await o.payments.creditOrder({ order, mode: opts.mode, reason: `Order canceled: ${opts.why}`.slice(0, 200), key: `order-cancel:${order.id}`, req }) : { credits: 0 }
  const creditsBack = Math.max(0, Math.floor(Number(credits?.credits) || 0))
  // Everything refunded for this cancellation, an earlier attempt's included (its record outlived its rollback).
  const total = (await refundRows(req.payload, { and: [{ order: { equals: idOf(order.id) } }, { kind: { equals: 'order' } }, { status: { equals: 'refunded' } }] })).reduce((n, r) => n + (Number(r.amountCents) || 0), 0)
  await saveFulfillment(req, o, order, {
    status: 'cancelled',
    orderRefund: { status: 'refunded', amountCents: total, deductedCents: kept, creditsBack, refundId: refund.refundId, at: new Date().toISOString(), by: actor?.id ?? null },
  }, `order canceled: ${opts.why}`)
  await o.orders?.onCanceled?.({ order, mode: opts.mode, refundCents: total, req })
  const id = String(order.id)
  if (hasShipping(o)) {
    afterCommit(outer, () => cancelUnneededReturnLabels(freshReq(outer), id).catch((e: unknown) => outer.payload.logger.error({ err: errName(e), order: id }, 'Sample Kits: return labels not canceled')))
    afterCommit(outer, () => refundOutboundFor(freshReq(outer), id).catch((e: unknown) => outer.payload.logger.error({ err: errName(e), order: id }, 'Sample Kits: outbound labels not canceled')))
  }
  if (!opts.keepVote && o.onPreorderVote && order.kitFulfillment?.preorderVote?.vote) afterCommit(outer, () => vote(outer, o, id, 'withdraw', null))
  return { refundCents: total, keptBackCents: kept, creditsBack }
}

/**
 * The buyer's "Request a refund" (within the window) or "Get help with my order" (after). `reasons` from `REASONS`;
 * `details` the follow-up answers. `confirmKeptBack` is the amount the form showed as kept back: never more is kept.
 */
export async function requestHelp(req: PayloadRequest, input: { order: string; reasons: string[]; details?: string; confirmKeptBack?: number; now?: Date }) {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('noOrder', 'That order wasn’t found.')
  const site = await siteOf(o, req)
  const now = input?.now ?? new Date()
  const outer = req
  return inTransaction(req, async (req) => {
    const order = await buyersOrder(req, o, site, input?.order)
    const state = helpPhase(o, order, now)
    if (state.phase === 'closed') throw new KitError('alreadyCancelled', 'This order has already been canceled or refunded.')
    const given = Array.isArray(input.reasons) ? input.reasons : []
    // An optional reason that's off isn't quietly dropped: the person is told it isn't offered.
    const off = given.find((r) => (REASONS as readonly string[]).includes(r) && !helpReasons(o).includes(r as Reason))
    if (off) throw new KitError('reasonNotOffered', 'That reason isn’t offered here. Choose another.', { reason: off })
    const reasons = [...new Set(given.filter((r): r is Reason => helpReasons(o).includes(r as Reason)))]
    if (!reasons.length) throw new KitError('chooseHelpReason', 'Choose at least one reason.')
    const details = String(input.details ?? '').trim().slice(0, 1000)
    if (reasons.includes('other') && !details) throw new KitError('tellUsMore', 'Tell us a little more, so we can help.')
    // Damaged goes through the replacement flow, never a refund: only for a kit that has shipped, and to staff,
    // who replace it with `replaceKit(…, 'damaged')`.
    if (reasons.includes('damaged') && !state.shipped) throw new KitError('notShippedYet', 'A kit can only arrive damaged once it has shipped. Choose another reason.')
    const kind: HelpRequest['kind'] = state.phase === 'missed' ? 'missed-date' : state.phase === 'refund' ? 'refund' : 'help'
    const base = { kind, reasons, details: details || null, at: now.toISOString() }
    let result: { outcome: HelpRequest['outcome']; refundCents?: number; keptBackCents?: number; creditsBack?: number }
    if (state.shipped) {
      // A kit has to come back: staff review it.
      result = { outcome: 'review' }
    } else if (state.phase === 'refund' || state.phase === 'missed') {
      // Within the window, or past the promised date: everything back, shipping included.
      const r = await cancelOrder(req, o, site, order, { mode: 'refund', why: `refund requested (${reasons.join(', ')})`, now }, outer)
      result = { outcome: 'refunded', ...r }
    } else if (reasons.some((r) => FIXED_CASES.includes(r))) {
      // After the window, one of the fixed cases: cancel now, keeping back only unrecoverable postage, never more than shown.
      const r = await cancelOrder(req, o, site, order, { mode: 'refund', keepBackUpTo: Math.max(0, Math.floor(Number(input.confirmKeptBack) || 0)), why: `help (${reasons.join(', ')})`, now }, outer)
      result = { outcome: 'cancelled', ...r }
    } else result = { outcome: 'review' }
    await pushRequest(req, o, order, { ...base, outcome: result.outcome, amountCents: result.refundCents ?? null, deductedCents: result.keptBackCents ?? null })
    return result
  })
}

/** Past the promised date: wait, move the vote to another item, take credit, or a full refund. */
export async function chooseAfterMissed(req: PayloadRequest, input: { order: string; choice: string; item?: string; now?: Date }) {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('noOrder', 'That order wasn’t found.')
  const site = await siteOf(o, req)
  const now = input?.now ?? new Date()
  const outer = req
  return inTransaction(req, async (req) => {
    const order = await buyersOrder(req, o, site, input?.order)
    if (helpPhase(o, order, now).phase !== 'missed') throw new KitError('notMissed', 'These choices open the day after the promised date, if your kits haven’t shipped.')
    const choice = input.choice as MissedChoice
    if (!(MISSED_CHOICES as readonly string[]).includes(choice)) throw new KitError('chooseOption', 'Choose what you’d like to do.')
    const base = { kind: 'missed-date' as const, reasons: [choice], at: now.toISOString() }
    if (choice === 'refund' || choice === 'credit') {
      const r = await cancelOrder(req, o, site, order, { mode: choice, keepVote: choice === 'credit', why: `promised date missed: ${choice}`, now }, outer)
      await pushRequest(req, o, order, { ...base, outcome: choice === 'refund' ? 'refunded' : 'credited', amountCents: r.refundCents })
      return { outcome: choice === 'refund' ? ('refunded' as const) : ('credited' as const), ...r }
    }
    if (choice === 'reallocate') {
      const item = String(input.item ?? '').trim()
      if (!o.onPreorderVote || !order.kitFulfillment?.preorderVote?.vote) throw new KitError('noVote', 'This order has no vote to move.')
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(item)) throw new KitError('chooseSpecies', 'Choose where the vote goes.')
      // In the transaction: if the site refuses the move, nothing is recorded.
      const answer = await o.onPreorderVote({ action: 'move', order, item, req })
      await saveFulfillment(req, o, order, { preorderVote: answer ? { item: idOf(answer.item) ?? item, vote: answer.vote ?? null, contribution: answer.contribution ?? null } : { ...order.kitFulfillment.preorderVote, item } }, 'pre-order vote moved')
      await pushRequest(req, o, order, { ...base, outcome: 'reallocated', note: item })
      return { outcome: 'reallocated' as const }
    }
    await pushRequest(req, o, order, { ...base, outcome: 'waiting' })
    return { outcome: 'waiting' as const }
  })
}

/**
 * Site admins decide a request sent for review: refund (up to what's left of the payment, every refund counted) or
 * decline, with a note for the record.
 */
export async function decideRequest(req: PayloadRequest, input: { order: string; decision: 'refund' | 'decline'; amountCents?: number; note: string }) {
  const o = optionsOf(req.payload)
  const me = personOf(o, req)
  // The same answer for "not allowed" and "no such order".
  const refuse = () => new KitError('notAllowed', 'Only the site’s administrators can decide refunds.')
  if (!me || !(await isAdmin(o, req))) throw refuse()
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input?.order).catch(() => {
      throw refuse()
    })
    const requests = order.kitFulfillment?.requests ?? []
    const open = requests.findIndex((r) => r.outcome === 'review' && !r.decidedAt)
    if (open < 0) throw new KitError('noRequest', 'There’s no request waiting on this order.')
    const note = String(input.note ?? '').trim().slice(0, 300)
    if (!note) throw new KitError('refundReason', 'Add a short note for the record.')
    if (input.decision !== 'refund' && input.decision !== 'decline') throw new KitError('chooseOption', 'Refund or decline.')
    let amount = 0
    let refundId: string | null = null
    if (input.decision === 'refund') {
      amount = Number(input.amountCents)
      if (!Number.isInteger(amount) || amount <= 0) throw new KitError('refundAmount', 'Enter an amount above zero.')
      const done = await recordedRefund(req, o, { order, site, kind: 'review', key: `kit-order-review-${order.id}-${open}`, reason: note, by: me.id, amount: () => amount })
      refundId = done.refundId
    }
    const fresh = (await req.payload.findByID({ collection: o.collections.orders, id: order.id, overrideAccess: true, depth: 0, req })) as unknown as KitOrder
    const f = fresh.kitFulfillment ?? {}
    const updated = (f.requests ?? []).map((r, i) => (i === open ? { ...r, id: undefined, outcome: input.decision === 'refund' ? 'refunded' : 'declined', amountCents: amount || null, decidedBy: me.id, decidedAt: new Date().toISOString(), note } : { ...r, id: undefined }))
    const prior = Number(f.orderRefund?.amountCents) || 0
    await saveFulfillment(req, o, order, { requests: updated, ...(amount ? { orderRefund: { ...(f.orderRefund ?? {}), status: 'refunded', amountCents: prior + amount, refundId, at: new Date().toISOString(), by: me.id } } : {}) }, `refund request ${input.decision}`)
    return { decision: input.decision, amountCents: amount }
  })
}

/** Kit staff: orders on their site with a request waiting for review, oldest first, with that request. */
export async function requestsToReview(req: PayloadRequest) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const { docs } = await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { 'kitFulfillment.requests.outcome': { equals: 'review' } }), sort: 'updatedAt', ...READ, req })
  return (docs as unknown as KitOrder[])
    .filter((x) => (x.kitFulfillment?.requests ?? []).some((r) => r.outcome === 'review' && !r.decidedAt))
    .map((x) => ({ id: String(x.id), createdAt: String(x.createdAt ?? ''), request: (x.kitFulfillment?.requests ?? []).filter((r) => r.outcome === 'review' && !r.decidedAt).at(-1)! }))
}
