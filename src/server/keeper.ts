import type { PayloadRequest, TypedUser, Where } from 'payload'

import { hasShipping } from '../carrier.js'
import { normalizeKitCode } from '../codes.js'
import { releaseForMail } from '../eventReturns.js'
import { idOf, KitError, ONE, personOf, READ, scoped, siteOf } from '../internal.js'
import { activateKit, findKit, markSampled } from '../kits.js'
import { chooseAfterMissed, helpOptions, helpPhase, requestHelp, type HelpPhase } from '../orderHelp.js'
import { buyerOf, getKitOrder } from '../packing.js'
import { resultView } from '../results.js'
import { customerReturnLabel, returnsByMail } from '../returns.js'
import { ACTIVATABLE, KIT_STATUS_LABELS, orderSummary, progressOf, PROGRESS_STEPS, type KitStatus, type OrderSummary } from '../status.js'
import { MISSED_CHOICES } from '../terms.js'
import type { KitDoc, KitOrder, ResolvedOptions, ResultView, Subject, SubjectRef } from '../types.js'
import { say, serve, text, type ServerResult } from './result.js'

/**
 * Server functions for the keeper's pages (`/my-tests/*`) and the activation wizard (`/my-tests/activate`, route id
 * `kit-activate`). A person sees only kits they bought or activated, and only their own orders:
 * - the buyer of a kit someone else activated sees its status, never the keeper or what they sampled;
 * - a keeper who got the kit as a gift sees the kit, never who bought it, the order, or what it was bought for;
 * - a result shows only to its keeper (and kit staff, through `resultView`);
 * - a kit that isn't theirs gets exactly the same answer as one that doesn't exist.
 */

/** The menu route id the activation wizard is mounted under (agreed with Platform). */
export const KIT_ACTIVATE_ROUTE = 'kit-activate'

export type KeeperKit = {
  code: string
  status: string
  statusText: string
  /** Index into `steps`, or -1 when the kit went off the usual path (`problem`). */
  step: number
  problem: string | null
  role: 'keeper' | 'buyer' | 'both'
  /** What it's for, by the subject provider's label: the keeper sees what they sampled, the buyer what they bought it for. */
  subject: string | null
  next: 'activate' | 'sample' | 'return' | null
}

const NOT_FOUND = () => new KitError('kitNotFound', 'We couldn’t find that kit on your account. Check the number under the barcode, or sign in with the account that ordered or activated it.')

const me = (o: ResolvedOptions, req: PayloadRequest): TypedUser => {
  const user = personOf(o, req)
  if (!user) throw new KitError('signIn', 'Sign in to see your tests.')
  return user
}

async function labelOf(o: ResolvedOptions, req: PayloadRequest, ref: SubjectRef | null): Promise<string | null> {
  if (!ref || !o.subjects.label) return null
  try {
    return (await o.subjects.label({ ref, req })) ?? null
  } catch {
    return null
  }
}

function roleOf(kit: KitDoc, user: TypedUser): KeeperKit['role'] | null {
  const buyer = idOf(kit.buyer) === String(user.id)
  const keeper = idOf(kit.activatedBy) === String(user.id)
  return buyer && keeper ? 'both' : keeper ? 'keeper' : buyer ? 'buyer' : null
}

async function keeperKit(o: ResolvedOptions, req: PayloadRequest, kit: KitDoc, role: KeeperKit['role']): Promise<KeeperKit> {
  const keeper = role !== 'buyer'
  const buyer = role !== 'keeper'
  const someoneElseActivated = !keeper && Boolean(idOf(kit.activatedBy))
  // A gift's keeper never sees what the buyer bought it for; a buyer never sees what someone else sampled.
  const ref = keeper ? (o.subjects.sampledOf(kit) ?? (buyer ? o.subjects.suggestedOf(kit) : null)) : someoneElseActivated ? null : o.subjects.suggestedOf(kit)
  const subject = (await labelOf(o, req, ref)) ?? (buyer && !someoneElseActivated && typeof kit.identifierLabel === 'string' ? kit.identifierLabel : null)
  const { step, problem } = progressOf(kit.status)
  const next: KeeperKit['next'] =
    buyer && ACTIVATABLE.includes(kit.status)
      ? 'activate'
      : keeper && kit.status === 'activated'
        ? 'sample'
        : (keeper || buyer) && ['activated', 'sampled'].includes(kit.status) && hasShipping(o) && returnsByMail([kit]).length
          ? 'return'
          : null
  return { code: kit.code, status: kit.status, statusText: say(o, `status.${kit.status}`, KIT_STATUS_LABELS[kit.status] ?? kit.status), step, problem, role, subject, next }
}

/** The progress steps, in words, for every keeper page. */
const stepsOf = (o: ResolvedOptions) =>
  PROGRESS_STEPS.map((s) => say(o, `steps.${s}`, { ordered: 'Ordered', shipped: 'Shipped', activated: 'Activated', sampled: 'Sampled', returned: 'Sent back', lab: 'At the lab', results: 'Results' }[s]))

// ---------------------------------------------------------------- /my-tests

export type MyOrder = {
  id: string
  createdAt: string | null
  status: string
  kitCount: number
  summary: OrderSummary
  promisedBy: string | null
  trackingNumbers: string[]
  help: HelpPhase
  kits: KeeperKit[]
}

export type MyTestsData = { steps: string[]; orders: MyOrder[]; otherKits: KeeperKit[] }

/** `/my-tests`: the person's own kit orders with their kits, and kits they activated that someone else bought. */
export function myTestsPage(req: PayloadRequest): Promise<ServerResult<MyTestsData>> {
  return serve(req, async (o) => {
    const user = me(o, req)
    const site = await siteOf(o, req)
    const mine = String(user.id)
    const buyerWhere: Where = o.orders?.buyerWhere ? o.orders.buyerWhere(mine) : { customer: { equals: mine } }
    const found = (await req.payload.find({ pagination: false, collection: o.collections.orders, where: scoped(o, site, { and: [buyerWhere, { 'kitFulfillment.status': { exists: true } }] }), sort: '-createdAt', limit: 100, ...ONE, req })).docs as unknown as KitOrder[]
    // Checked again by the buyer rule itself, so a query that's too loose can't show someone else's order.
    const orders = found.filter((d) => buyerOf(o, d) === mine && d.kitLines?.length)
    const ids = orders.map((d) => d.id)
    const inOrders = ids.length ? ((await req.payload.find({ collection: 'kits', where: scoped(o, site, { order: { in: ids } }), sort: 'code', ...READ, req })).docs as unknown as KitDoc[]) : []
    const out: MyOrder[] = []
    for (const d of orders) {
      const f = d.kitFulfillment ?? {}
      const kits = inOrders.filter((k) => idOf(k.order) === String(d.id))
      const rows: KeeperKit[] = []
      for (const k of kits) rows.push(await keeperKit(o, req, k, roleOf(k, user) ?? 'buyer'))
      out.push({
        id: String(d.id),
        createdAt: d.createdAt ? String(d.createdAt) : null,
        status: String(f.status ?? ''),
        kitCount: (d.kitLines ?? []).reduce((n, l) => n + (Number(l.quantity) || 0), 0),
        summary: orderSummary(f.status, kits.map((k) => k.status)),
        promisedBy: f.promisedBy && !['shipped', 'cancelled'].includes(String(f.status)) ? String(f.promisedBy).slice(0, 10) : null,
        trackingNumbers: f.trackingNumbers ?? [],
        help: helpPhase(o, d).phase,
        kits: rows,
      })
    }
    const ordered = new Set(ids.map(String))
    const activated = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { activatedBy: { equals: mine } }), sort: '-activatedAt', limit: 500, ...READ, req })).docs as unknown as KitDoc[]
    const otherKits: KeeperKit[] = []
    for (const k of activated.filter((k) => !ordered.has(idOf(k.order) ?? ''))) otherKits.push(await keeperKit(o, req, k, roleOf(k, user) ?? 'keeper'))
    return { steps: stepsOf(o), orders: out, otherKits }
  })
}

// ---------------------------------------------------------------- /my-tests/kits/[code]

export type MyKitData = KeeperKit & {
  steps: string[]
  attempt: number
  dates: { step: 'ordered' | 'shipped' | 'activated' | 'sampled'; label: string; at: string }[]
  trackingNumbers: string[]
  inPerson: string | null
  result: ResultView | null
}

/** One kit, for its buyer or keeper. Anyone else, and a code that doesn't exist, get the same `kitNotFound`. */
export function myKitPage(req: PayloadRequest, input: { code: string }): Promise<ServerResult<MyKitData>> {
  return serve(req, async (o) => {
    const user = me(o, req)
    const site = await siteOf(o, req)
    const code = normalizeKitCode(input?.code)
    const kit = code ? await findKit(req, code, site) : null
    const role = kit ? roleOf(kit, user) : null
    if (!kit || !role) throw NOT_FOUND()
    const row = await keeperKit(o, req, kit, role)
    const buyer = role !== 'keeper'
    const keeper = role !== 'buyer'
    const order = buyer && idOf(kit.order) ? ((await req.payload.find({ pagination: false, collection: o.collections.orders, where: scoped(o, site, { id: { equals: idOf(kit.order) } }), limit: 1, ...ONE, req })).docs[0] as unknown as KitOrder | undefined) : undefined
    const word = (s: 'ordered' | 'shipped' | 'activated' | 'sampled') => say(o, `steps.${s}`, { ordered: 'Ordered', shipped: 'Shipped', activated: 'Activated', sampled: 'Sampled' }[s])
    const dates: MyKitData['dates'] = []
    if (order?.createdAt) dates.push({ step: 'ordered', label: word('ordered'), at: String(order.createdAt) })
    if (order?.kitFulfillment?.shippedAt) dates.push({ step: 'shipped', label: word('shipped'), at: String(order.kitFulfillment.shippedAt) })
    if (keeper && kit.activatedAt) dates.push({ step: 'activated', label: word('activated'), at: String(kit.activatedAt) })
    if (keeper && kit.sampledAt) dates.push({ step: 'sampled', label: word('sampled'), at: String(kit.sampledAt) })
    return {
      ...row,
      steps: stepsOf(o),
      attempt: Number(kit.attempt) || 1,
      dates,
      trackingNumbers: buyer && ['shipped', 'delivered'].includes(kit.status) ? (order?.kitFulfillment?.trackingNumbers ?? []) : [],
      inPerson: typeof kit.returnInPerson === 'string' && kit.returnInPerson ? kit.returnInPerson : null,
      // Only the keeper: resultView itself answers null to anyone else, and the provider isn't asked.
      result: keeper ? await resultView(req, { code: kit.code }) : null,
    }
  })
}

/** The keeper's return label: the box's label again, or with `extra` one of its own for this kit. */
export function getReturnLabel(req: PayloadRequest, input: { code: string; extra?: boolean }): Promise<ServerResult<{ result: string; labelUrl: string; tracking: string; message: string }>> {
  return serve(req, async (o) => {
    try {
      const r = await customerReturnLabel(req, { code: text(input?.code, 40), extra: input?.extra === true })
      if (r.result === 'unknown') return { ...r, message: say(o, 'returnLabel.checking', 'We’re checking on your label with the carrier. Please try again tomorrow. You won’t be charged.') }
      return { ...r, message: say(o, 'returnLabel.ready', 'Your return label is ready. Print it and tape it over the old address.') }
    } catch (error) {
      if (error instanceof KitError && error.code === 'notYourKit') throw NOT_FOUND()
      // Carrier, hub and address problems are for staff (their log); the keeper gets one plain answer.
      if (error instanceof KitError && ['noShipping', 'noReturnHub', 'hubAddress', 'customerAddress', 'postageOff', 'carrier', 'labelUnknown', 'noShipFrom'].includes(error.code)) {
        req.payload.logger.warn({ code: error.code }, 'Sample Kits: a keeper’s return label wasn’t made')
        throw new KitError('labelUnavailable', 'We can’t make a return label right now. Please try again later, or contact us and we’ll send you one.')
      }
      throw error
    }
  })
}

/** After a missed or canceled event date, mail the kits back instead. */
export function submitReleaseForMail(req: PayloadRequest, input: { code: string }): Promise<ServerResult<{ released: string[]; message: string }>> {
  return serve(req, async (o) => {
    const r = await releaseForMail(req, { code: text(input?.code, 40) })
    return { ...r, message: say(o, 'dropOff.released', 'You can mail your kits back now. Get the return label below.') }
  })
}

// ---------------------------------------------------------------- /my-tests/orders/[id]: order help and the pre-order choice

export type MyOrderData = MyOrder & {
  steps: string[]
  options: {
    phase: HelpPhase
    daysLeft: number
    shipped: boolean
    missed: boolean
    refundableCents: number
    keptBackCents: number
    reasons: string[]
    canCredit: boolean
    canMoveVote: boolean
    revisedBy: string | null
    requests: { kind: string; reasons: string[]; at: string; outcome: string; amountCents: number | null; deductedCents: number | null; decidedAt: string | null }[]
  }
  missedChoices: string[]
}

/** One of the buyer's orders, with what help it can get now. Someone else's order, and one that doesn't exist, get the same `noOrder`. */
export function myOrderPage(req: PayloadRequest, input: { order: string }): Promise<ServerResult<MyOrderData>> {
  return serve(req, async (o) => {
    const user = me(o, req)
    const options = await helpOptions(req, { order: text(input?.order, 64) })
    const site = await siteOf(o, req)
    const order = await getKitOrder(req, o, site, input.order)
    const f = order.kitFulfillment ?? {}
    const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { order: { equals: order.id } }), sort: 'code', ...READ, req })).docs as unknown as KitDoc[]
    const rows: KeeperKit[] = []
    for (const k of kits) rows.push(await keeperKit(o, req, k, roleOf(k, user) ?? 'buyer'))
    return {
      id: String(order.id),
      createdAt: order.createdAt ? String(order.createdAt) : null,
      status: String(f.status ?? ''),
      kitCount: (order.kitLines ?? []).reduce((n, l) => n + (Number(l.quantity) || 0), 0),
      summary: orderSummary(f.status, kits.map((k) => k.status)),
      promisedBy: options.promisedBy,
      trackingNumbers: f.trackingNumbers ?? [],
      help: options.phase,
      kits: rows,
      steps: stepsOf(o),
      options: {
        phase: options.phase,
        daysLeft: options.daysLeft,
        shipped: options.shipped,
        missed: options.missed,
        refundableCents: options.refundableCents,
        keptBackCents: options.keptBackCents,
        reasons: [...options.reasons],
        canCredit: options.canCredit,
        canMoveVote: options.canMoveVote,
        revisedBy: options.revisedBy,
        // Who decided, and staff notes, stay with staff.
        requests: options.requests.map((r) => ({ kind: r.kind, reasons: r.reasons ?? [], at: r.at, outcome: r.outcome, amountCents: r.amountCents ?? null, deductedCents: r.deductedCents ?? null, decidedAt: r.decidedAt ?? null })),
      },
      missedChoices: MISSED_CHOICES.filter((c) => (c !== 'credit' || options.canCredit) && (c !== 'reallocate' || options.canMoveVote)),
    }
  })
}

/** "Request a refund" or "Get help with my order". */
export function submitHelp(req: PayloadRequest, input: { order: string; reasons: string[]; details?: string; confirmKeptBack?: number }): Promise<ServerResult<{ outcome: string; refundCents: number | null; creditsBack: number | null; message: string }>> {
  return serve(req, async (o) => {
    const r = (await requestHelp(req, {
      order: text(input?.order, 64),
      reasons: Array.isArray(input?.reasons) ? input.reasons.map((x) => text(x, 40)).slice(0, 10) : [],
      details: text(input?.details, 1000),
      confirmKeptBack: Number(input?.confirmKeptBack) || 0,
    })) as { outcome: string; refundCents?: number; creditsBack?: number }
    return { outcome: r.outcome, refundCents: r.refundCents ?? null, creditsBack: r.creditsBack ?? null, message: helpMessage(o, r.outcome) }
  })
}

/** After a missed pre-order date: wait, move the vote, take credit, or a full refund. */
export function submitMissedChoice(req: PayloadRequest, input: { order: string; choice: string; item?: string }): Promise<ServerResult<{ outcome: string; refundCents: number | null; creditsBack: number | null; message: string }>> {
  return serve(req, async (o) => {
    const r = (await chooseAfterMissed(req, { order: text(input?.order, 64), choice: text(input?.choice, 20), ...(input?.item ? { item: text(input.item, 64) } : {}) })) as { outcome: string; refundCents?: number; creditsBack?: number }
    return { outcome: r.outcome, refundCents: r.refundCents ?? null, creditsBack: r.creditsBack ?? null, message: helpMessage(o, r.outcome) }
  })
}

function helpMessage(o: ResolvedOptions, outcome: string): string {
  const words: Record<string, string> = {
    refunded: 'Your order is canceled and refunded. The refund shows on your statement in 5 to 10 days.',
    cancelled: 'Your order is canceled.',
    credited: 'Your order is canceled and the tests are back on your account as credit.',
    review: 'Thanks. We’ve got your request and will reply by email within 2 working days.',
    waiting: 'Thanks. Your order stays as it is, and we’ll email you when it ships.',
    reallocated: 'Your vote has moved.',
    replaced: 'A replacement is on its way.',
    declined: 'This request was declined.',
  }
  return say(o, `help.${outcome}`, words[outcome] ?? 'Done.')
}

// ---------------------------------------------------------------- /my-tests/activate (route id `kit-activate`)

export type ActivateData = {
  /** Who it can be for, from the subject provider; null when the provider gives no list (the site's picker brings its own). */
  choices: Subject[] | null
  /** True when the guided steps (Wizards) record the sample: then `submitSampled` takes `answers`. */
  guided: boolean
  /** The code from the link, cleaned, or null. Never the secret: that stays in the browser's fragment until it's sent. */
  code: string | null
  /** `sample` when this person already activated this kit and only the sample is left; else `activate`. */
  stage: 'activate' | 'sample'
}

/**
 * The activation page's data. A kit is only used to mark a suggestion when this person bought it and it can still be
 * activated; any other code gives the same plain list, so nothing is learned about a code before its secret is checked.
 */
export function activatePage(req: PayloadRequest, input: { code?: string | null } = {}): Promise<ServerResult<ActivateData>> {
  return serve(req, async (o) => {
    const user = me(o, req)
    const site = await siteOf(o, req)
    const code = normalizeKitCode(input?.code ?? null)
    const found = code ? await findKit(req, code, site) : null
    const own = found && idOf(found.buyer) === String(user.id) && ACTIVATABLE.includes(found.status) ? found : null
    const { secretHash: _secret, ...kit } = own ?? ({ id: '', code: code ?? '', lot: null, status: 'packed' as KitStatus } as KitDoc)
    const choices = o.subjects.choices ? (await o.subjects.choices({ user, kit: kit as KitDoc, req })).map((c) => ({ ref: { kind: String(c.ref.kind), id: String(c.ref.id) }, label: String(c.label), suggested: own ? c.suggested === true : false })) : null
    const stage = found && found.status === 'activated' && idOf(found.activatedBy) === String(user.id) ? 'sample' : 'activate'
    return { choices, guided: Boolean(o.adapters?.wizards), code, stage }
  })
}

/** Activate a kit with its code and secret, for a subject. The secret comes in the request body, never a query. */
export function submitActivation(req: PayloadRequest, input: { code: string; secret: string; subject: SubjectRef }): Promise<ServerResult<{ code: string; label: string | null; message: string }>> {
  return serve(req, async (o) => {
    me(o, req)
    const subject = input?.subject && typeof input.subject === 'object' ? { kind: text(input.subject.kind, 40), id: text(input.subject.id, 64) } : { kind: '', id: '' }
    if (!subject.kind || !subject.id) throw new KitError('chooseSubject', 'Choose who this sample is from, then try again.')
    const r = await activateKit(req, { code: text(input?.code, 40), secret: text(input?.secret, 40), subject })
    return { ...r, message: r.label ? say(o, 'activate.doneFor', 'Kit {code} is activated for {label}.', { code: r.code, label: r.label }) : say(o, 'activate.done', 'Kit {code} is activated.', { code: r.code }) }
  })
}

/** The keeper says the sample is in the tube: with Wizards, `answers` from the guided steps (checked on the server). */
export function submitSampled(req: PayloadRequest, input: { code: string; answers?: unknown; locale?: string; confirmed?: Record<string, unknown> }): Promise<ServerResult<{ code: string; message: string }>> {
  return serve(req, async (o) => {
    const r = await markSampled(req, {
      code: text(input?.code, 40),
      ...(input?.answers !== undefined ? { answers: input.answers } : {}),
      ...(input?.locale ? { locale: text(input.locale, 20) } : {}),
      ...(input?.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
    })
    return { code: r.code, message: say(o, 'sampled.done', 'Sample recorded for kit {code}. Seal the tube and send it back.', { code: r.code }) }
  })
}
