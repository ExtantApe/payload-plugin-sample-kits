import type { PayloadRequest } from 'payload'

import { hasShipping } from './carrier.js'
import { assignKitUnits, kittingOf } from './kitting.js'
import { errName, afterCommit, freshReq, idOf, inTransaction, KitError, optionsOf, READ, requireStaff, scoped, siteOf } from './internal.js'
import { labelOrderInBackground } from './orderLabels.js'
import { buyerOf, getKitOrder, saveFulfillment } from './packing.js'
import { storeDay } from './pricing.js'
import { dateOnly, delayEmail, formatPromised, preorderTerms, promisedByFor, type DelayKind } from './terms.js'
import type { KitOrder, PreorderVote, ResolvedOptions, SubjectRef } from './types.js'

/**
 * Pre-orders: kits sold before they can ship. Each order has its own promised date, agreed before paying, and waits
 * out of the packing queue until kit staff release it. Buyers hear about their own order, once per event: a new date
 * set by staff, three days before the promised date, and the day after a missed one. Votes stay in the site
 * (`onPreorderVote`); `subjects.canSell` decides what may be sold.
 */

const DAY = 86_400_000
const WARN_DAYS = 3
const tzOf = (o: ResolvedOptions) => o.policy?.storeTimeZone ?? 'UTC'

// ---------------------------------------------------------------- selling

/**
 * Server only, for the site's checkout: may this product be sold for these subjects? A product that isn't a kit is
 * refused. With `subjects.canSell`, every subject must get exactly `true`; a thrown error refuses too. Answers
 * whether the sale is a pre-order.
 */
export async function checkKitSale(req: PayloadRequest, input: { product: Record<string, unknown>; subjects?: SubjectRef[] }): Promise<{ preorder: boolean }> {
  const o = optionsOf(req.payload)
  const kit = (input?.product?.kit ?? null) as { isKit?: boolean; preorder?: boolean } | null
  if (!kit?.isKit) throw new KitError('notAKit', 'That product isn’t a sample kit.')
  if (o.subjects.canSell)
    for (const ref of input.subjects ?? []) {
      let answer: unknown
      try {
        answer = await o.subjects.canSell({ product: input.product, ref, req })
      } catch {
        answer = null
      }
      if (answer !== true) {
        const r = answer as { code?: unknown; message?: unknown } | null
        throw new KitError(typeof r?.code === 'string' ? r.code : 'notForSale', typeof r?.message === 'string' ? r.message : 'Kits can’t be sold for that yet.')
      }
    }
  return { preorder: Boolean(kit.preorder) }
}

/** The pre-order terms for an order placed now, for the checkout form: the promised day and the words to tick. */
export function preorderOffer(o: ResolvedOptions, product: Record<string, unknown>, now = new Date(), words: { voteChoice?: boolean; closing?: string } = {}) {
  const shipBy = ((product?.kit ?? null) as { shipBy?: string | null } | null)?.shipBy ?? null
  const promisedBy = promisedByFor(shipBy, now, { timeZone: tzOf(o), maxMonths: o.policy?.preorderMaxMonths })
  return { promisedBy, text: preorderTerms(formatPromised(promisedBy), { refundDays: o.policy?.refundWithinDays ?? 30, voteChoice: words.voteChoice ?? Boolean(o.onPreorderVote), closing: words.closing }) }
}

/**
 * Server only, for the site's checkout once an order is placed: makes it a pre-order with its promised date and the
 * words the buyer ticked (`agreed`, which must be the offer's text). The vote is placed after the commit, through
 * `onPreorderVote`; a failure there is logged and never fails the order.
 */
export async function startPreorder(req: PayloadRequest, input: { order: string; product: Record<string, unknown>; agreed: string; words?: { voteChoice?: boolean; closing?: string } }) {
  const o = optionsOf(req.payload)
  const outer = req
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, undefined, input?.order)
    if (order.kitFulfillment?.status && order.kitFulfillment.status !== 'to-pack' && order.kitFulfillment.status !== 'pre-order') throw new KitError('orderClosed', 'This order has already been packed, shipped or canceled.')
    const created = order.createdAt ? new Date(String(order.createdAt)) : new Date()
    const offer = preorderOffer(o, input.product, created, input.words)
    if (String(input?.agreed ?? '') !== offer.text) throw new KitError('preorderTerms', 'Tick the pre-order terms to go on: they changed, or weren’t ticked.')
    await saveFulfillment(req, o, order, { status: 'pre-order', promisedBy: offer.promisedBy, agreed: { text: offer.text, at: new Date().toISOString() } }, 'pre-order placed')
    if (o.onPreorderVote) afterCommit(outer, () => vote(outer, o, String(order.id), 'place', null))
    return offer
  })
}

/** After the commit: the site places or withdraws the vote, and the order keeps what it answers. Never throws. */
export async function vote(req: PayloadRequest, o: ResolvedOptions, orderId: string, action: 'place' | 'withdraw', item: string | null) {
  try {
    await inTransaction(freshReq(req), async (r) => {
      const order = (await r.payload.findByID({ collection: o.collections.orders, id: orderId, overrideAccess: true, depth: 0, req: r })) as unknown as KitOrder
      if (action === 'place' && order.kitFulfillment?.preorderVote?.vote) return
      if (action === 'withdraw' && !order.kitFulfillment?.preorderVote?.vote) return
      const answer = await o.onPreorderVote!({ action, order, item, req: r })
      const kept: PreorderVote | null = answer ? { item: idOf(answer.item), vote: answer.vote ?? null, contribution: answer.contribution ?? null } : action === 'withdraw' ? { ...order.kitFulfillment!.preorderVote, vote: null } : null
      if (kept) await saveFulfillment(r, o, order, { preorderVote: kept }, `pre-order vote ${action}`)
    })
  } catch (error) {
    req.payload.logger.error({ err: errName(error), order: orderId }, `Sample Kits: pre-order vote not ${action === 'place' ? 'placed' : 'withdrawn'}`)
  }
}

// ---------------------------------------------------------------- release

/**
 * Kit staff, when kits can ship: every waiting pre-order on their site moves to the packing queue at once. Returns
 * how many moved. Labels are bought after the commit (an unused label is refundable for only 30 days, so not at
 * ordering). The agreed words stay on each order.
 */
export async function releasePreorders(req: PayloadRequest): Promise<number> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const outer = req
  return inTransaction(req, async (req) => {
    const { docs } = await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { 'kitFulfillment.status': { equals: 'pre-order' } }), ...READ, req })
    for (const order of docs as unknown as KitOrder[]) {
      await saveFulfillment(req, o, order, { status: 'to-pack' }, 'pre-orders released')
      if (hasShipping(o)) afterCommit(outer, () => labelOrderInBackground(outer.payload, String(order.id)))
      // Kitting wired: the released order gets its units after the commit; never fails the release.
      if (kittingOf(o)) afterCommit(outer, () => assignKitUnits(outer.payload, String(order.id)))
    }
    return docs.length
  })
}

// ---------------------------------------------------------------- notices

/**
 * Server only, daily (and after staff set a new date): each buyer hears about their own pre-order, each once:
 * - a new date set by staff (`revisedBy`), with the new date;
 * - three days before the promised date, if the order still hasn't shipped;
 * - the day after a missed date, with their choices, a full refund always among them.
 * The marker is saved first, then the notice goes through `notify`.
 */
export async function noticePreorders(req: PayloadRequest, input: { at?: Date } = {}): Promise<{ revised: number; warned: number; missed: number }> {
  const o = optionsOf(req.payload)
  const at = input.at ?? new Date()
  const today = storeDay(at, tzOf(o))
  const out = { revised: 0, warned: 0, missed: 0 }
  const { docs } = await req.payload.find({
    collection: o.collections.orders,
    where: { and: [{ 'kitFulfillment.promisedBy': { exists: true } }, { 'kitFulfillment.status': { in: ['pre-order', 'to-pack', 'packed'] } }] },
    ...READ,
  })
  const date = (d: string) => formatPromised(d)
  const choices = o.onPreorderVote ? 'You can wait, move your pre-order’s vote to another species, turn the payment into credit, or get a full refund, shipping included: choose on your order page.' : 'You can wait, turn the payment into credit, or get a full refund, shipping included: choose on your order page.'
  for (const order of docs as unknown as KitOrder[]) {
    const f = order.kitFulfillment ?? {}
    if (!f.promisedBy) continue
    const promised = dateOnly(f.promisedBy)
    const revised = f.revisedBy ? dateOnly(f.revisedBy) : null
    const said = f.delayNoticeFor ? dateOnly(f.delayNoticeFor) : null
    let kind: DelayKind
    let words: string
    let mark: Record<string, unknown>
    let count: keyof typeof out
    if (today > promised) {
      if (f.missedNoticeFor && dateOnly(f.missedNoticeFor) === promised) continue
      words = `We promised to ship by ${date(promised)}, and your kits haven’t shipped. ${revised && revised > promised ? `We now expect ${date(revised)}. ` : ''}${choices}`
      ;[kind, mark, count] = ['preorder-late', { missedNoticeFor: promised }, 'missed']
    } else if (revised && revised > promised && said !== revised) {
      words = `We won’t make the date we promised, ${date(promised)}: we now expect to ship by ${date(revised)}. If ${date(promised)} passes before your kits ship, you can choose a full refund.`
      ;[kind, mark, count] = ['preorder-changed', { delayNoticeFor: revised }, 'revised']
    } else if (!said && Date.parse(promised) - Date.parse(today) <= WARN_DAYS * DAY) {
      words = `Your kits haven’t shipped yet, and we promised to ship by ${date(promised)}. We’re working on it and will tell you the new date if we miss it. If the date passes, you can choose a full refund.`
      ;[kind, mark, count] = ['preorder-changed', { delayNoticeFor: promised }, 'warned']
    } else continue
    await inTransaction(freshReq(req), (r) => saveFulfillment(r, o, order, mark, 'pre-order notice'))
    const buyer = buyerOf(o, order)
    if (!buyer || !o.notify) continue
    try {
      await o.notify({ kind, to: { user: buyer, order: String(order.id) }, data: { order: String(order.id), words, ...delayEmail(kind, words) }, req: freshReq(req) })
      out[count]++
    } catch (error) {
      // A delay notice is owed to the buyer: undo the mark, so the next run tries again. A rare second copy (a send
      // that went out and then reported an error) is better than a buyer never told.
      const undo = Object.fromEntries(Object.keys(mark).map((k) => [k, (f as Record<string, unknown>)[k] ?? null]))
      await inTransaction(freshReq(req), (r) => saveFulfillment(r, o, order, undo, 'pre-order notice not sent; will retry')).catch(() => undefined)
      req.payload.logger.warn({ err: { name: (error as Error)?.name }, order: String(order.id) }, 'Sample Kits: pre-order notice not sent; the next run tries again')
    }
  }
  return out
}
