import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  checkKitSale,
  chooseAfterMissed,
  chooseDropOff,
  createLot,
  decideRequest,
  dropOffOffer,
  expectedAtEvents,
  findKit,
  formatPromised,
  helpOptions,
  helpReasons,
  replaceKit,
  KitError,
  markShipped,
  makeSlip,
  noticeDateChanged,
  noticeEventReturns,
  noticePreorders,
  packKit,
  preorderOffer,
  preorderTerms,
  promisedByFor,
  refundShipping,
  releaseForMail,
  releasePreorders,
  requestHelp,
  requestsToReview,
  settleRefund,
  startPreorder,
  storeDay,
  type PreorderVote,
} from '../src/index.js'
import { optionsOf } from '../src/internal.js'
import { recordedRefund, refundableOf } from '../src/refunds.js'
import { fakeEvents, fakePayments, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Made-up people, orders and event dates on two made-up sites, A and B. Nothing here is real.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, adminA: Person, buyer: Person, stranger: Person, staffB: Person, adminB: Person
const pay = fakePayments()
const credits: { key: string; mode: string }[] = []
const votes: { action: string; order: string; item: string | null }[] = []
const notices: { kind: string; to: Record<string, unknown>; data: Record<string, unknown> }[] = []
const flags = { onCanceledThrows: false, voteThrows: false, refuseMove: false, notifyThrows: false }
const DAY = 864e5
const noon = Date.parse(`${storeDay(new Date())}T19:00:00Z`)
const day = (n: number) => new Date(noon + n * DAY)
const ev = fakeEvents([
  { dateId: 'date-1', eventName: 'Made-up Expo', eventSlug: 'made-up-expo', starts: day(20).toISOString(), timezone: 'America/Phoenix', place: 'Made-up Hall', zips: ['85001'] },
  { dateId: 'date-2', eventName: 'Made-up Fair', eventSlug: 'made-up-fair', starts: day(30).toISOString(), timezone: 'America/Phoenix', place: 'Made-up Park', zips: ['85001'], miles: 4 },
])
const LOT = '737373'
let serial = 0
const freeKit = () => `${LOT}${String(++serial).padStart(6, '0')}`
const SHIP_TO = { name: 'Made-up Buyer', line1: '2 Sample Road', city: 'Faketown', state: 'AZ', postalCode: '85001' }

const as = (u: Person | null) => reqAs(payload, u as never)
async function kitErr(p: Promise<unknown>, code: string): Promise<KitError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `expected KitError ${code}`).toBeInstanceOf(KitError)
  expect((error as KitError).code).toBe(code)
  return error as KitError
}
const order = async (id: string) => (await payload.findByID({ collection: 'orders', id, overrideAccess: true, depth: 0 })) as unknown as Record<string, any>
const refundsOf = async (id: string) => (await payload.find({ collection: 'kit-refunds', where: { order: { equals: id } }, sort: 'createdAt', overrideAccess: true, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
const paidBack = (id: string) => pay.refunds.filter((r) => r.key.includes(id)).reduce((n, r) => n + r.amountCents, 0)
let next = 0
async function newOrder(over: Record<string, unknown> = {}, site = 'A') {
  const doc = await payload.create({
    collection: 'orders',
    data: {
      ref: `made-up ${++next}`,
      tenant: site,
      customer: buyer.id,
      shipTo: SHIP_TO,
      amount: 40000,
      totals: { shipping: 1200 },
      kitLines: [{ kind: 'count', quantity: 2 }],
      kitFulfillment: { status: 'to-pack' },
      ...over,
    } as never,
    overrideAccess: true,
  })
  return String(doc.id)
}
const pack = async (id: string, n = 2) => {
  const codes: string[] = []
  for (let i = 0; i < n; i++) {
    const code = freeKit()
    await packKit(await as(staffA), { order: id, code })
    codes.push(code)
  }
  return codes
}
const ship = async (id: string) => {
  const codes = await pack(id)
  await makeSlip(await as(staffA), { order: id })
  await markShipped(await as(staffA), { order: id, tracking: ['9400100000000000000077'] })
  return codes
}
const kitOf = async (code: string) => (await findKit(await as(staffA), code, 'A'))!

beforeAll(async () => {
  h = await startPayload((o) => ({
    ...o,
    payments: {
      ...pay.payments,
      creditOrder: async ({ order, mode, key }) => {
        credits.push({ key, mode })
        return { credits: mode === 'credit' ? 2 : Number((order as { kitCredits?: number }).kitCredits) || 0 }
      },
    },
    orders: {
      shipTo: ({ order }) => (order.shipTo as never) ?? null,
      onCanceled: async () => {
        if (flags.onCanceledThrows) throw new Error('made-up provider failure')
      },
    },
    adapters: { events: ev.events },
    policy: { storeTimeZone: 'America/Phoenix' },
    onPreorderVote: async ({ action, order, item }): Promise<PreorderVote | null> => {
      if (flags.voteThrows) throw new Error('made-up vote failure')
      if (action === 'move' && flags.refuseMove) throw new KitError('chooseSpecies', 'Choose a species on this site’s list.')
      votes.push({ action, order: String(order.id), item })
      return action === 'withdraw' ? null : { item: item ?? 'item-1', vote: `vote-${votes.length}`, contribution: 'made-up-contribution' }
    },
    notify: async ({ kind, to, data }) => {
      if (flags.notifyThrows) throw new Error('made-up notify failure')
      notices.push({ kind, to: to as never, data })
    },
  }))
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  adminA = await person(payload, 'A', 'admin')
  buyer = await person(payload, 'A')
  stranger = await person(payload, 'A')
  staffB = await person(payload, 'B', 'staff')
  adminB = await person(payload, 'B', 'admin')
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 150 })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

beforeEach(() => {
  Object.assign(flags, { onCanceledThrows: false, voteThrows: false, refuseMove: false })
  notices.length = 0
})

describe('order help', () => {
  it('refunds an unshipped order at once within the window, in full, for its buyer only', async () => {
    const id = await newOrder()
    const codes = await pack(id)
    for (const who of [stranger, staffA, staffB, null]) await kitErr(requestHelp(await as(who), { order: id, reasons: ['changed-mind'] }), 'noOrder')
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: [] }), 'chooseHelpReason')
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['other'] }), 'tellUsMore')
    expect(await helpOptions(await as(buyer), { order: id })).toMatchObject({ phase: 'refund', refundableCents: 40000, keptBackCents: 0, canCredit: true })
    const r = await requestHelp(await as(buyer), { order: id, reasons: ['changed-mind', 'not-a-reason'] })
    expect(r).toMatchObject({ outcome: 'refunded', refundCents: 40000, keptBackCents: 0 })
    expect(pay.refunds.filter((x) => x.key === `kit-order-refund-${id}`)).toHaveLength(1)
    const f = (await order(id)).kitFulfillment
    expect(f).toMatchObject({ status: 'cancelled', orderRefund: { status: 'refunded', amountCents: 40000 } })
    expect(f.requests).toEqual([expect.objectContaining({ kind: 'refund', reasons: ['changed-mind'], outcome: 'refunded', amountCents: 40000 })])
    // Kits packed into it are back in stock, with nothing of the order left on them.
    for (const code of codes) expect(await kitOf(code)).toMatchObject({ status: 'in-stock', order: null, buyer: null })
    expect(await refundsOf(id)).toEqual([expect.objectContaining({ kind: 'order', status: 'refunded', amountCents: 40000 })])
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }), 'alreadyCancelled')
    expect(paidBack(id)).toBe(40000)
  })

  it('sends a shipped order to staff, and lets only the site’s admins refund, never more than what’s left', async () => {
    const id = await newOrder()
    await ship(id)
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['other'], details: 'Made-up crushed box' })).toEqual({ outcome: 'review' })
    expect((await requestsToReview(await as(staffA))).map((x) => x.id)).toContain(id)
    expect((await requestsToReview(await as(staffB))).map((x) => x.id)).not.toContain(id)
    await kitErr(requestsToReview(await as(buyer)), 'notStaff')
    for (const who of [staffA, buyer, stranger, adminB, null]) await kitErr(decideRequest(await as(who), { order: id, decision: 'refund', amountCents: 100, note: 'Made-up' }), 'notAllowed')
    // Shipping refunded first: it counts against what's left.
    await refundShipping(await as(adminA), { order: id, amountCents: 1200, reason: 'Made-up goodwill' })
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 38801, note: 'Made-up' }), 'refundTooMuch')
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 0, note: 'Made-up' }), 'refundAmount')
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 500, note: ' ' }), 'refundReason')
    pay.fail()
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 500, note: 'Made-up' }), 'refundFailed')
    expect((await order(id)).kitFulfillment.requests[0].decidedAt ?? null).toBeNull()
    expect(await decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 38800, note: 'Made-up crushed kits' })).toEqual({ decision: 'refund', amountCents: 38800 })
    expect(paidBack(id)).toBe(40000)
    expect((await order(id)).kitFulfillment.requests[0]).toMatchObject({ outcome: 'refunded', amountCents: 38800, note: 'Made-up crushed kits' })
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'decline', note: 'Made-up' }), 'noRequest')
    expect((await refundsOf(id)).map((r) => [r.kind, r.status, r.amountCents])).toEqual([
      ['shipping', 'refunded', 1200],
      ['review', 'not-asked', null],
      ['review', 'failed', 500],
      ['review', 'refunded', 38800],
    ])
  })

  it('after the window, cancels the fixed cases keeping back only lost postage, never more than shown, and sends the rest to staff', async () => {
    const later = new Date(Date.now() + 40 * DAY)
    const lost = { box: 1, tracking: '9400100000000000000088', mode: 'production', costCents: 700, at: new Date().toISOString(), shipmentId: 'shp_made_up' }
    const id = await newOrder({ kitFulfillment: { status: 'to-pack', outboundLabels: [lost] } })
    expect(await helpOptions(await as(buyer), { order: id, now: later })).toMatchObject({ phase: 'help', keptBackCents: 700 })
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['too-slow'], now: later })).toEqual({ outcome: 'review' })
    const r = await requestHelp(await as(buyer), { order: id, reasons: ['duplicate'], confirmKeptBack: 500, now: later })
    expect(r).toMatchObject({ outcome: 'cancelled', refundCents: 39500, keptBackCents: 500 })
    expect((await order(id)).kitFulfillment.orderRefund).toMatchObject({ amountCents: 39500, deductedCents: 500 })
    expect(paidBack(id)).toBe(39500)
  })

  it('past a missed promised date: wait, move the vote, take credit, or a full refund', async () => {
    const promised = storeDay(day(-2))
    const id = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: promised, preorderVote: { item: 'item-1', vote: 'vote-0' } } })
    await kitErr(chooseAfterMissed(await as(buyer), { order: id, choice: 'wait', now: day(-5) }), 'notMissed')
    await kitErr(chooseAfterMissed(await as(stranger), { order: id, choice: 'wait' }), 'noOrder')
    await kitErr(chooseAfterMissed(await as(buyer), { order: id, choice: 'cash' }), 'chooseOption')
    expect(await chooseAfterMissed(await as(buyer), { order: id, choice: 'wait' })).toEqual({ outcome: 'waiting' })
    // The site refuses the move: nothing is recorded.
    flags.refuseMove = true
    await kitErr(chooseAfterMissed(await as(buyer), { order: id, choice: 'reallocate', item: 'item-elsewhere' }), 'chooseSpecies')
    expect((await order(id)).kitFulfillment.requests).toHaveLength(1)
    flags.refuseMove = false
    expect(await chooseAfterMissed(await as(buyer), { order: id, choice: 'reallocate', item: 'item-2' })).toEqual({ outcome: 'reallocated' })
    expect((await order(id)).kitFulfillment.preorderVote).toMatchObject({ item: 'item-2' })
    expect(await chooseAfterMissed(await as(buyer), { order: id, choice: 'credit' })).toMatchObject({ outcome: 'credited', refundCents: 0, creditsBack: 2 })
    expect(paidBack(id)).toBe(0)
    expect(credits.at(-1)).toEqual({ key: `order-cancel:${id}`, mode: 'credit' })
    // Credit keeps the vote.
    expect(votes.filter((v) => v.order === id).map((v) => v.action)).toEqual(['move'])

    const refundable = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: promised, preorderVote: { item: 'item-1', vote: 'vote-9' } } })
    expect(await chooseAfterMissed(await as(buyer), { order: refundable, choice: 'refund' })).toMatchObject({ outcome: 'refunded', refundCents: 40000 })
    // A refund withdraws the vote, after the commit.
    expect(votes.filter((v) => v.order === refundable).map((v) => v.action)).toEqual(['withdraw'])
    expect((await order(refundable)).kitFulfillment.preorderVote.vote).toBeNull()
  })

  it('counts refunds the site made before the move, and refuses moving a vote an order doesn’t have', async () => {
    const id = await newOrder({ kitFulfillment: { status: 'to-pack', shippingRefund: { status: 'refunded', amountCents: 1200 } } })
    expect((await helpOptions(await as(buyer), { order: id })).refundableCents).toBe(38800)
    const shipped = await newOrder({ kitFulfillment: { status: 'shipped', orderRefund: { status: 'refunded', amountCents: 1000 }, requests: [{ kind: 'help', reasons: ['damaged'], at: new Date().toISOString(), outcome: 'review' }] } })
    await kitErr(decideRequest(await as(adminA), { order: shipped, decision: 'refund', amountCents: 39001, note: 'Made-up' }), 'refundTooMuch')
    const noVote = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: storeDay(day(-2)) } })
    await kitErr(chooseAfterMissed(await as(buyer), { order: noVote, choice: 'reallocate', item: 'item-2' }), 'noVote')
  })

  it('keeps "damaged" off until the site turns it on, and still reads requests stored with it', async () => {
    const o = optionsOf(payload)
    expect(o.orderHelp).toBeUndefined()
    const id = await newOrder()
    await ship(id)
    // Off (the default): not offered, not accepted, and nothing is written.
    expect((await helpOptions(await as(buyer), { order: id })).reasons).not.toContain('damaged')
    const e = await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['damaged', 'other'], details: 'Made-up crushed box' }), 'reasonNotOffered')
    expect(e.vars).toEqual({ reason: 'damaged' })
    expect((await order(id)).kitFulfillment.requests ?? []).toEqual([])
    // A request stored with it before still reads.
    const old = await newOrder({ kitFulfillment: { status: 'shipped', requests: [{ kind: 'help', reasons: ['damaged'], at: new Date().toISOString(), outcome: 'review' }] } })
    expect((await helpOptions(await as(buyer), { order: old })).requests).toEqual([expect.objectContaining({ reasons: ['damaged'] })])
    // Staff can't replace a kit as damaged while it's off.
    const codes = (await payload.find({ collection: 'kits', where: { order: { equals: id } }, sort: 'code', depth: 0, overrideAccess: true })).docs.map((k) => k.code as string)
    await kitErr(replaceKit(await as(staffA), { code: codes[0]!, reason: 'damaged' }), 'chooseReason')
    // On: offered and accepted, and it goes through the replacement flow, never a refund.
    o.orderHelp = { reasons: { damaged: true } }
    try {
      expect((await helpOptions(await as(buyer), { order: id })).reasons).toContain('damaged')
      const unshipped = await newOrder()
      await kitErr(requestHelp(await as(buyer), { order: unshipped, reasons: ['damaged'] }), 'notShippedYet')
      expect((await order(unshipped)).kitFulfillment.status).toBe('to-pack')
      const refundsBefore = pay.refunds.length
      expect(await requestHelp(await as(buyer), { order: id, reasons: ['damaged'], details: 'Made-up crushed box' })).toEqual({ outcome: 'review' })
      expect((await order(id)).kitFulfillment.requests).toEqual([expect.objectContaining({ reasons: ['damaged'], outcome: 'review' })])
      // Staff replace it, exactly as for a lost kit: a free order of one for the same buyer, carrying the kit it replaces.
      const damaged = await replaceKit(await as(staffA), { code: codes[0]!, reason: 'damaged', note: 'Made-up crushed tube' })
      const lost = await replaceKit(await as(staffA), { code: codes[1]!, reason: 'lost' })
      expect(damaged).toMatchObject({ outcome: 'replacement' })
      const shape = async (r: { order?: string }) => {
        const x = await order(r.order!)
        return { customer: x.customer, lines: x.kitLines.map((l: { quantity: number }) => l.quantity), status: x.kitFulfillment.status }
      }
      expect(await shape(damaged as { order: string })).toEqual(await shape(lost as { order: string }))
      expect((await order((damaged as { order: string }).order)).kitFulfillment.replaces).toBe(String((await kitOf(codes[0]!)).id))
      expect((await kitOf(codes[0]!)).status).toBe('replaced')
      expect(pay.refunds.length).toBe(refundsBefore)
      // The buyer's request is answered: replaced.
      expect((await order(id)).kitFulfillment.requests).toEqual([expect.objectContaining({ reasons: ['damaged'], outcome: 'replaced' })])
      // One free replacement per subject, shared with lost and expired: the replacement's own damage is refused.
      const next = (damaged as { order: string }).order
      const fresh = freeKit()
      await packKit(await as(staffA), { order: next, code: fresh })
      await makeSlip(await as(staffA), { order: next })
      await markShipped(await as(staffA), { order: next, tracking: ['9400100000000000000078'] })
      await kitErr(replaceKit(await as(staffA), { code: fresh, reason: 'damaged' }), 'secondFree')
    } finally {
      o.orderHelp = undefined
    }
    expect(helpReasons({})).not.toContain('damaged')
    expect(helpReasons({ orderHelp: { reasons: { damaged: false } } })).not.toContain('damaged')
  })

  it('refuses credit where the site gives none, before anything changes', async () => {
    const o = optionsOf(payload)
    const real = o.payments!.creditOrder
    o.payments!.creditOrder = undefined
    try {
      const id = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: storeDay(day(-2)) } })
      await kitErr(chooseAfterMissed(await as(buyer), { order: id, choice: 'credit' }), 'noCredit')
      expect((await order(id)).kitFulfillment.status).toBe('pre-order')
    } finally {
      o.payments!.creditOrder = real
    }
  })
})

describe('money', () => {
  it('rolls the cancellation back when a provider throws, keeps the refund’s record, and never refunds it twice', async () => {
    const id = await newOrder()
    const codes = await pack(id)
    pay.fail()
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }), 'refundFailed')
    expect((await order(id)).kitFulfillment.status).toBe('packed')
    expect((await refundsOf(id)).map((r) => r.status)).toEqual(['failed'])
    flags.onCanceledThrows = true
    await expect(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] })).rejects.toThrow(/made-up provider failure/)
    // Rolled back: still packed, kits still in it, no request. The money went, and its record stayed.
    expect((await order(id)).kitFulfillment).toMatchObject({ status: 'packed' })
    expect((await order(id)).kitFulfillment.requests ?? []).toHaveLength(0)
    for (const code of codes) expect((await kitOf(code)).status).toBe('packed')
    expect(paidBack(id)).toBe(40000)
    flags.onCanceledThrows = false
    // The retry finds nothing left to refund, asks for nothing, and records the earlier refund.
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] })).toMatchObject({ outcome: 'refunded', refundCents: 40000 })
    expect(pay.refunds.filter((x) => x.key === `kit-order-refund-${id}`)).toHaveLength(1)
    expect(paidBack(id)).toBe(40000)
  })

  it('never refunds more than was paid when refunds on one order race', async () => {
    const id = await newOrder()
    await pack(id)
    const results = await Promise.allSettled([
      requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }),
      requestHelp(await as(buyer), { order: id, reasons: ['duplicate'] }),
      refundShipping(await as(adminA), { order: id, amountCents: 1200, reason: 'Made-up goodwill' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(paidBack(id)).toBeLessThanOrEqual(40000)
    expect(pay.refunds.filter((x) => x.key === `kit-order-refund-${id}`).length).toBeLessThanOrEqual(1)
    // Straight at the record keeper: three at once for 30,000 each on a 40,000 order. Only one is asked.
    const second = await newOrder()
    const o = optionsOf(payload)
    const req = await as(adminA)
    const doc = await order(second)
    const racers = await Promise.allSettled([1, 2, 3].map((n) => recordedRefund(req, o, { order: doc as never, site: 'A', kind: 'review', key: `race-${second}-${n}`, reason: 'Made-up race', amount: () => 30000 })))
    expect(racers.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of racers.filter((r) => r.status === 'rejected')) expect(['refundBusy', 'refundTooMuch']).toContain(((r as PromiseRejectedResult).reason as KitError).code)
    expect(paidBack(second)).toBe(30000)
  })

  it('counts a refund whose answer never came as paid back, so no other kind can pass what was paid, until an admin settles it', async () => {
    const id = await newOrder()
    await ship(id)
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['other'], details: 'Made-up crushed box' })).toEqual({ outcome: 'review' })
    // The shipping refund goes through, then the connection drops before the answer: unknown, not failed.
    pay.timeoutAfterSuccess()
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 1200, reason: 'Made-up goodwill' }), 'refundUnknown')
    expect(paidBack(id)).toBe(1200)
    expect((await refundsOf(id)).map((r) => [r.kind, r.status, r.amountCents])).toEqual([['shipping', 'unknown', 1200]])
    // Another kind can't take what may already have gone back.
    await kitErr(decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 40000, note: 'Made-up' }), 'refundTooMuch')
    expect((await helpOptions(await as(buyer), { order: id })).refundableCents ?? 38800).toBeLessThanOrEqual(38800)
    expect(await decideRequest(await as(adminA), { order: id, decision: 'refund', amountCents: 38800, note: 'Made-up crushed kits' })).toEqual({ decision: 'refund', amountCents: 38800 })
    expect(paidBack(id)).toBe(40000)
    // A clear refusal is still `failed`, and frees its amount.
    const other = await newOrder()
    pay.fail()
    await kitErr(refundShipping(await as(adminA), { order: other, amountCents: 1200, reason: 'Made-up goodwill' }), 'refundFailed')
    expect((await refundsOf(other)).map((r) => r.status)).toEqual(['failed'])
    // Settling: only the site's admins, and only rows still asking or unknown.
    const unknown = (await refundsOf(id)).find((r) => r.status === 'unknown')!
    for (const who of [staffA, buyer, adminB, null]) await kitErr(settleRefund(await as(who), { refund: String(unknown.id), refundId: 're_made_up_2' }), who === adminB ? 'noRefund' : 'notAllowed')
    expect(await settleRefund(await as(adminA), { refund: String(unknown.id), refundId: 're_made_up_2' })).toEqual({ result: 'refunded' })
    await kitErr(settleRefund(await as(adminA), { refund: String(unknown.id), refundId: null }), 'noRefund')
    expect((await refundsOf(id)).find((r) => String(r.id) === String(unknown.id))).toMatchObject({ status: 'refunded', refundId: 're_made_up_2' })
  })

  it('frees the amount of an unknown refund that an admin finds didn’t go through', async () => {
    const id = await newOrder()
    const o = optionsOf(payload)
    const req = await as(adminA)
    const real = o.payments!.refund
    o.payments!.refund = async () => ({ id: '' })
    try {
      await kitErr(recordedRefund(req, o, { order: (await order(id)) as never, site: 'A', kind: 'review', key: `made-up-${id}`, reason: 'Made-up', amount: () => 40000 }), 'refundUnknown')
    } finally {
      o.payments!.refund = real
    }
    const [row] = await refundsOf(id)
    expect(row).toMatchObject({ status: 'unknown', amountCents: 40000 })
    // Counted while unknown: nothing more can be refunded.
    expect(await refundableOf(req, o, (await order(id)) as never)).toBe(0)
    await kitErr(recordedRefund(req, o, { order: (await order(id)) as never, site: 'A', kind: 'shipping', key: `made-up-2-${id}`, reason: 'Made-up', amount: () => 1 }), 'refundTooMuch')
    expect(await settleRefund(await as(adminA), { refund: String(row!.id), refundId: null })).toEqual({ result: 'failed' })
    expect(await refundableOf(req, o, (await order(id)) as never)).toBe(40000)
  })

  it('holds an order’s refunds while one is unsettled, until a site admin settles it', async () => {
    const id = await newOrder()
    const now = new Date().toISOString()
    // As if the server stopped while the payment service was being asked.
    const stuck = await payload.db.create({ collection: 'kit-refunds', data: { tenant: 'A', order: id, kind: 'order', status: 'asking', amountCents: 1000, claimKey: id, key: 'made-up', createdAt: now, updatedAt: now } } as never)
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }), 'refundBusy')
    expect(paidBack(id)).toBe(0)
    // While it's unsettled, its money counts as gone.
    expect((await helpOptions(await as(buyer), { order: id })).refundableCents).toBe(39000)
    for (const who of [staffA, buyer, adminB, null]) await kitErr(settleRefund(await as(who), { refund: String(stuck.id), refundId: null }), who === adminB ? 'noRefund' : 'notAllowed')
    await kitErr(settleRefund(await as(adminA), { refund: String(stuck.id), refundId: 'bad id!' }), 'refundDetails')
    expect(await settleRefund(await as(adminA), { refund: String(stuck.id), refundId: 're_made_up_1' })).toEqual({ result: 'refunded' })
    await kitErr(settleRefund(await as(adminA), { refund: String(stuck.id), refundId: null }), 'noRefund')
    // It went through, so it counts: the full refund gives back the rest.
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] })).toMatchObject({ outcome: 'refunded' })
    expect(paidBack(id)).toBe(39000)
  })
})

describe('pre-orders', () => {
  const product = { title: 'Made-up kit', kit: { isKit: true, preorder: true, shipBy: null as string | null } }

  it('sells kits only through subjects.canSell, and words the terms as agreed', async () => {
    const o = optionsOf(payload)
    await kitErr(checkKitSale(await as(buyer), { product: { title: 'Made-up mug' } }), 'notAKit')
    o.subjects.canSell = async ({ ref }) => (ref.id === 'open' ? true : { code: 'speciesClosed', message: 'Kits for that species aren’t on sale yet.' })
    try {
      expect(await checkKitSale(await as(buyer), { product, subjects: [{ kind: 'animal', id: 'open' }] })).toEqual({ preorder: true })
      await kitErr(checkKitSale(await as(buyer), { product, subjects: [{ kind: 'animal', id: 'open' }, { kind: 'animal', id: 'closed' }] }), 'speciesClosed')
      o.subjects.canSell = async () => {
        throw new Error('made-up failure')
      }
      await kitErr(checkKitSale(await as(buyer), { product, subjects: [{ kind: 'animal', id: 'open' }] }), 'notForSale')
      o.subjects.canSell = (async () => 'yes') as never
      await kitErr(checkKitSale(await as(buyer), { product, subjects: [{ kind: 'animal', id: 'open' }] }), 'notForSale')
    } finally {
      o.subjects.canSell = undefined
    }
    // The site's own words, rebuilt exactly from the plugin's parts.
    expect(preorderTerms('March 3, 2027', { voteChoice: true, closing: 'Each pre-order places one vote for its species on the Roadmap.' })).toBe(
      "This is a pre-order. We promise to ship by March 3, 2027. For 30 days after you order you can cancel for a full refund, to the way you paid; after that it's locked in until that date. If we're going to miss it, we'll tell you before it passes. If it passes and your kits haven't shipped, you choose: wait for the new date, move your pre-order's vote to another species, turn the payment into credit, or a full refund. Each pre-order places one vote for its species on the Roadmap.",
    )
    // Never more than six months ahead.
    expect(promisedByFor('2099-01-01', new Date('2026-11-10T19:00:00Z'), { timeZone: 'America/Phoenix' })).toBe('2027-05-10')
    expect(promisedByFor('2026-12-01', new Date('2026-11-10T19:00:00Z'))).toBe('2026-12-01')
  })

  it('keeps the agreed words and promised date, places the vote after the commit, and waits for staff to release it', async () => {
    const id = await newOrder()
    await kitErr(startPreorder(await as(buyer), { order: id, product, agreed: 'something else' }), 'preorderTerms')
    const offer = preorderOffer(optionsOf(payload), product, new Date((await order(id)).createdAt))
    flags.voteThrows = true
    const failing = await newOrder()
    await startPreorder(await as(buyer), { order: failing, product, agreed: preorderOffer(optionsOf(payload), product, new Date((await order(failing)).createdAt)).text })
    // A vote that fails never fails the order.
    expect((await order(failing)).kitFulfillment.status).toBe('pre-order')
    flags.voteThrows = false
    expect(await startPreorder(await as(buyer), { order: id, product, agreed: offer.text })).toEqual(offer)
    const f = (await order(id)).kitFulfillment
    expect(f).toMatchObject({ status: 'pre-order', agreed: { text: offer.text }, preorderVote: { vote: expect.stringMatching(/^vote-/) } })
    expect(String(f.promisedBy).slice(0, 10)).toBe(offer.promisedBy)
    expect(offer.text).toContain(formatPromised(offer.promisedBy))
    await kitErr(packKit(await as(staffA), { order: id, code: freeKit() }), 'preorder')
    for (const who of [buyer, stranger, null]) await kitErr(releasePreorders(await as(who)), 'notStaff')
    expect(await releasePreorders(await as(staffB))).toBe(0)
    expect(await releasePreorders(await as(staffA))).toBeGreaterThanOrEqual(2)
    expect((await order(id)).kitFulfillment).toMatchObject({ status: 'to-pack', agreed: { text: offer.text } })
  })

  it('tells the buyer three days before the promised date, at once about a new date, and once the day after a missed one', async () => {
    const id = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: storeDay(day(10)) } })
    const sent = (kind: string) => notices.filter((n) => n.kind === kind && n.to.order === id).length
    const run = async (n: number) => noticePreorders(await as(null), { at: day(n) })
    await run(0)
    expect(sent('preorder-changed')).toBe(0)
    await run(7)
    await run(8)
    expect(sent('preorder-changed')).toBe(1)
    await payload.update({ collection: 'orders', id, data: { kitFulfillment: { ...(await order(id)).kitFulfillment, revisedBy: storeDay(day(40)) } } as never, overrideAccess: true })
    await run(8)
    await run(9)
    expect(sent('preorder-changed')).toBe(2)
    await run(10)
    expect(sent('preorder-late')).toBe(0)
    await run(11)
    await run(12)
    expect(sent('preorder-late')).toBe(1)
    const late = notices.find((n) => n.kind === 'preorder-late' && n.to.order === id)!
    expect(late.to.user).toBe(buyer.id)
    expect(String(late.data.words)).toMatch(/full refund/)
    expect(String(late.data.words)).toMatch(/move your pre-order’s vote/)
  })
})

describe('pre-order notices that fail to send', () => {
  it('tries again on the next run when a delay notice couldn’t be sent, so no buyer goes untold', async () => {
    const id = await newOrder({ kitFulfillment: { status: 'pre-order', promisedBy: storeDay(day(10)) } })
    const sent = () => notices.filter((n) => n.kind === 'preorder-late' && n.to.order === id).length
    flags.notifyThrows = true
    await noticePreorders(await as(null), { at: day(11) })
    flags.notifyThrows = false
    expect(sent()).toBe(0)
    expect((await order(id)).kitFulfillment.missedNoticeFor ?? null).toBeNull()
    await noticePreorders(await as(null), { at: day(12) })
    expect(sent()).toBe(1)
    await noticePreorders(await as(null), { at: day(13) })
    expect(sent()).toBe(1)
  })
})

describe('event drop-off', () => {
  it('offers only what the events side offers this ZIP, never throws, and checks the choice again', async () => {
    expect((await dropOffOffer(await as(buyer), { postalCode: '85001' })).map((c) => c.dateId)).toEqual(['date-1', 'date-2'])
    expect((await dropOffOffer(await as(buyer), { postalCode: '85001' }))[1]!.miles).toBe(4)
    expect(await dropOffOffer(await as(buyer), { postalCode: '99999' })).toEqual([])
    expect(await dropOffOffer(await as(buyer), { postalCode: 'abc' })).toEqual([])
    expect(await dropOffOffer(await as(buyer), { postalCode: '85001', country: 'CA' })).toEqual([])
    ev.state.throwNext = true
    expect(await dropOffOffer(await as(buyer), { postalCode: '85001' })).toEqual([])
    const id = await newOrder()
    for (const who of [stranger, staffB, null]) await kitErr(chooseDropOff(await as(who), { order: id, dateId: 'date-1' }), 'noOrder')
    await kitErr(chooseDropOff(await as(buyer), { order: id, dateId: 'date-nope' }), 'dropOffGone')
    const far = await newOrder({ shipTo: { ...SHIP_TO, postalCode: '99999' } })
    await kitErr(chooseDropOff(await as(buyer), { order: far, dateId: 'date-1' }), 'dropOffGone')
  })

  it('saves the choice, marks every kit packed for it, and tells the buyer a week before, when moved, canceled and missed: each once', async () => {
    const id = await newOrder()
    const first = (await pack(id, 1))[0]!
    expect(await chooseDropOff(await as(buyer), { order: id, dateId: 'date-1' })).toMatchObject({ dateId: 'date-1', kits: 1 })
    expect((await order(id)).kitFulfillment).toMatchObject({ returnAt: 'date-1', returnAtEvent: { name: 'Made-up Expo', place: 'Made-up Hall', slug: 'made-up-expo' } })
    expect((await kitOf(first)).returnInPerson).toMatch(/^Made-up Expo, /)
    const [second] = await pack(id, 1)
    expect((await kitOf(second!)).returnInPerson).toMatch(/^Made-up Expo, /)
    await makeSlip(await as(staffA), { order: id })
    await markShipped(await as(staffA), { order: id })
    const told = (word: RegExp) => notices.filter((n) => n.kind === 'kit-dropoff' && n.to.order === id && word.test(String(n.data.subject))).length
    // Before the date, a mail label is refused with why.
    await kitErr(releaseForMail(await as(buyer), { code: first, now: day(1) }), 'dropOffUpcoming')
    await kitErr(releaseForMail(await as(stranger), { code: first }), 'noKit')
    // A week before: reminded, once.
    expect((await noticeEventReturns(await as(null), { at: day(10) })).reminded).toBe(0)
    await noticeEventReturns(await as(null), { at: day(14) })
    await noticeEventReturns(await as(null), { at: day(15) })
    expect(told(/^Bring your kits/)).toBe(1)
    // Moved by the events side: told at once, and the kits carry the new day.
    ev.dates[0]!.starts = day(22).toISOString()
    expect((await noticeDateChanged({ dateId: 'date-1', req: await as(null) })).moved).toBe(1)
    expect((await noticeDateChanged({ dateId: 'date-1', req: await as(null) })).moved).toBe(0)
    expect((await order(id)).kitFulfillment.returnAtEvent.starts).toBe(day(22).toISOString())
    expect((await kitOf(first)).returnInPerson).toContain(day(22).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Phoenix' }))
    // Staff see what each date expects.
    expect((await expectedAtEvents(await as(staffA))).find((d) => d.dateId === 'date-1')).toMatchObject({ orders: 1, kits: 2, state: 'upcoming' })
    await kitErr(expectedAtEvents(await as(buyer)), 'notStaff')
    // Missed: told the day after, once, and a mail label is one click away.
    await noticeEventReturns(await as(null), { at: day(23) })
    await noticeEventReturns(await as(null), { at: day(24) })
    expect(told(/still need to come back/)).toBe(1)
    expect((await releaseForMail(await as(buyer), { code: first, now: day(23) })).released.sort()).toEqual([first, second].sort())
    expect((await kitOf(second!)).returnInPerson ?? null).toBeNull()
  })

  it('tells buyers at once when a booked date is canceled', async () => {
    const id = await newOrder()
    await chooseDropOff(await as(buyer), { order: id, dateId: 'date-2' })
    ev.dates[1]!.canceled = true
    expect((await noticeDateChanged({ dateId: 'date-2', req: await as(null) })).canceled).toBe(1)
    expect((await noticeDateChanged({ dateId: 'date-2', req: await as(null) })).canceled).toBe(0)
    expect(notices.find((n) => n.to.order === id)?.data.subject).toBe('Your kit drop-off date was canceled')
  })

  it('refuses a drop-off on an order that has shipped', async () => {
    const id = await newOrder()
    await ship(id)
    await kitErr(chooseDropOff(await as(buyer), { order: id, dateId: 'date-1' }), 'orderClosed')
  })
})
