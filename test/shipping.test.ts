import { commitTransaction, initTransaction, killTransaction, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  activateKit,
  applyRefundEvent,
  applyTrackerEvent,
  cancelReturnLabels,
  issueSecret,
  createLot,
  customerReturnLabel,
  findKit,
  KitError,
  labelOrderInBackground,
  makeOrderLabels,
  makeOrderReturnLabels,
  makeSlip,
  markShipped,
  nextTier,
  packKit,
  planBoxes,
  planShipment,
  recallLot,
  recordKitEvent,
  refundOutboundLabels,
  refundShipping,
  replaceKit,
  reprintReturnLabel,
  retryKitNotices,
  runAfterCommit,
  sampleKits,
  settleUnknownLabel,
  shippingFor,
  shippingHandler,
  staleReturnLabels,
  unitPrice,
  unpackKit,
  type SampleKitsOptions,
} from '../src/index.js'
import { afterCommit, inTransaction } from '../src/internal.js'
import { recordedPurchase } from '../src/ledger.js'
import { noticeTo, staffSiteMissing } from '../src/notices.js'
import { fakeAccess, fakePayments, fakeShipping, fakeSubjects, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Made-up people, places and orders on two made-up sites, A and B. Nothing here is real.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, adminA: Person, buyer: Person, stranger: Person, staffB: Person, adminB: Person
const ship = fakeShipping()
const pay = fakePayments()
const notices: { kind: string; to: unknown; data: Record<string, unknown> }[] = []
const flags = { notifyThrows: false, packForThrows: false, onShippedThrows: false, packForBad: false, notifyAnswer: undefined as unknown }
const LOT = '515151'
const c = (n: number) => `${LOT}${String(n).padStart(6, '0')}`
const HUB_ADDRESS = { kind: 'street', name: 'Made-up Hub', line1: '1 Example Way', city: 'Testville', state: 'AZ', postalCode: '85000' }
const SHIP_TO = { name: 'Made-up Buyer', line1: '2 Sample Road', city: 'Faketown', state: 'AZ', postalCode: '85001' }
let hubA: string

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
const kit = async (code: string, site = 'A') => (await findKit(await as(staffA), code, site))!
const order = async (id: string) => (await payload.findByID({ collection: 'orders', id, overrideAccess: true, depth: 0 })) as unknown as Record<string, any>
const allRows = async (id: string) => (await payload.find({ collection: 'return-labels', where: { order: { equals: id } }, sort: 'box', overrideAccess: true, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
const labelsOf = async (id: string) => (await allRows(id)).filter((l) => l.kind !== 'outbound')
const eventsOf = async (code: string) => (await payload.find({ collection: 'kit-events', where: { kit: { equals: (await kit(code)).id } }, sort: 'createdAt', pagination: false, overrideAccess: true, depth: 0 })).docs as unknown as Record<string, any>[]
let next = 0
/** Makes a return label 31 days old, straight in the database. */
const age = (id: unknown) => (payload.db.collections['return-labels'] as unknown as { updateOne: (f: object, u: object, o: object) => Promise<unknown> }).updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - 31 * 86_400_000) } }, { timestamps: false })
/** A made-up paid order on site A: two kits for subjects a1 and a2, and one not assigned yet. */
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
      kitLines: [
        { kind: 'animal', quantity: 2, subjectIds: ['a1', 'a2'] },
        { kind: 'count', quantity: 1 },
      ],
      kitFulfillment: { status: 'to-pack', returnShippingCents: 600 },
      ...over,
    } as never,
    overrideAccess: true,
  })
  return String(doc.id)
}
let serial = 0
const freeKit = () => c(++serial)
/** Packs every kit an order needs, makes the slip, and returns the codes and secrets. */
async function packAll(id: string, n = 3) {
  const codes: string[] = []
  for (let i = 0; i < n; i++) {
    const code = freeKit()
    await packKit(await as(staffA), { order: id, code })
    codes.push(code)
  }
  const slip = await makeSlip(await as(staffA), { order: id })
  return { codes, slip }
}

beforeAll(async () => {
  h = await startPayload((o) => ({
    ...o,
    site: { origin: 'https://example.invalid' },
    subjects: {
      ...o.subjects,
      packFor: (args) => {
        if (flags.packForThrows) throw new Error('made-up provider failure')
        if (flags.packForBad) return { set: { buyer: stranger.id } }
        return o.subjects.packFor!(args)
      },
    },
    adapters: { shipping: ship.adapter },
    payments: pay.payments,
    orders: {
      shipTo: ({ order }) => (order.shipTo as never) ?? null,
      onShipped: async () => {
        if (flags.onShippedThrows) throw new Error('made-up provider failure')
      },
    },
    notify: async ({ kind, to, data }) => {
      if (flags.notifyThrows) throw new Error('made-up notify failure')
      notices.push({ kind, to, data })
      return flags.notifyAnswer as never
    },
    policy: { freeRetests: 1, afterLastRetest: 'credit' },
  }))
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  adminA = await person(payload, 'A', 'admin')
  buyer = await person(payload, 'A')
  stranger = await person(payload, 'A')
  staffB = await person(payload, 'B', 'staff')
  adminB = await person(payload, 'B', 'admin')
  h.subjects.add({ kind: 'animal', id: 'a1', owner: buyer.id, name: 'Made-up Shelly' })
  h.subjects.add({ kind: 'animal', id: 'a2', owner: buyer.id, name: 'Made-up Dot' })
  const sys = { overrideAccess: true } as const
  hubA = String((await payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up Hub', address: HUB_ADDRESS, defaultReturn: true, shipsOrders: true } as never, ...sys })).id)
  await payload.create({ collection: 'hubs', data: { tenant: 'B', name: 'Made-up Hub B', address: HUB_ADDRESS, defaultReturn: true, shipsOrders: true } as never, ...sys })
  await payload.create({ collection: 'box-types', data: { tenant: 'A', name: 'Outer 2', kitsPerBox: 2, outsideLength: 6.6, outsideWidth: 6.6, outsideHeight: 4.6, emptyWeightOz: 4 } as never, ...sys })
  await payload.create({ collection: 'box-types', data: { tenant: 'A', name: 'Kit box', kitsPerBox: 1, outsideLength: 6, outsideWidth: 6, outsideHeight: 2, emptyWeightOz: 0 } as never, ...sys })
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 120 })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

beforeEach(() => {
  ship.reset()
  Object.assign(flags, { notifyThrows: false, packForThrows: false, onShippedThrows: false, packForBad: false, notifyAnswer: undefined })
})

describe('fields on the site’s orders and products', () => {
  const base = (withProducts: boolean, extraOrderField?: string) =>
    ({
      secret: 'made-up-secret-for-tests',
      collections: [
        { slug: 'users', auth: true, fields: [] },
        { slug: 'orders', fields: extraOrderField ? [{ name: extraOrderField, type: 'text' }] : [] },
        { slug: 'files', fields: [] },
        ...(withProducts ? [{ slug: 'products', fields: [] }] : []),
      ],
    }) as unknown as Config
  const good = (): SampleKitsOptions => ({ access: fakeAccess(), subjects: fakeSubjects(), tests: [{ label: 'Made-up test', value: 't' }] })
  const names = (config: Config, slug: string) => config.collections!.find((x) => x.slug === slug)!.fields.map((f) => ('name' in f ? f.name : f.type))

  it('adds the kit lines and fulfillment to orders, and the kit group to products', () => {
    const config = sampleKits(good())(base(true)) as Config
    expect(names(config, 'orders')).toEqual(['kitLines', 'kitFulfillment'])
    expect(names(config, 'products')).toEqual(['kit'])
    const f = config.collections!.find((x) => x.slug === 'orders')!.fields[1] as { fields: { name: string }[] }
    expect(f.fields.map((x) => x.name)).toEqual([
      'status', 'agreed', 'slipMadeAt', 'trackingNumbers', 'shippedAt', 'plan', 'returnAt', 'returnAtEvent', 'outboundLabels', 'labels', 'shippedEmail', 'replaces',
      'promisedBy', 'revisedBy', 'delayNoticeFor', 'missedNoticeFor', 'preorderVote', 'requests', 'orderRefund', 'returnShippingCents', 'shippingRefund',
    ])
    const kit = config.collections!.find((x) => x.slug === 'products')!.fields[0] as { fields: { name: string }[] }
    expect(kit.fields.map((x) => x.name)).toEqual(['isKit', 'tiers', 'shippingTiers', 'preorder', 'shipWindow', 'shipBy'])
    // Without Shipping, nothing is registered with Shipping's webhook.
    expect(config.custom?.shippingHandlers).toBeUndefined()
  })

  it('skips products when there are none, refuses a clash, and refuses half a shipping adapter', () => {
    expect(names(sampleKits(good())(base(false)) as Config, 'orders')).toEqual(['kitLines', 'kitFulfillment'])
    expect(() => sampleKits(good())(base(true, 'kitFulfillment'))).toThrow(/already has a field "kitFulfillment"/)
    expect(() => sampleKits({ ...good(), adapters: { shipping: { quote: ship.adapter.quote } } })(base(true))).toThrow(/needs all of .* Missing: buy/)
    expect(() => sampleKits({ ...good(), payments: { refund: pay.payments.refund } as never })(base(true))).toThrow(/`payments.creditBack`/)
    expect(() => sampleKits({ ...good(), policy: { afterLastRetest: 'cash' as never } })(base(true))).toThrow(/afterLastRetest/)
    const wired = sampleKits({ ...good(), adapters: { shipping: ship.adapter } })({ ...base(true), custom: { shippingHandlers: [{ owner: 'other' }] } }) as Config
    expect((wired.custom!.shippingHandlers as { owner: string }[]).map((x) => x.owner)).toEqual(['other', 'sample-kits'])
  })
})

describe('prices, shipping tiers and box plans', () => {
  const tiers = [{ minQuantity: 5, priceInUSD: 17500 }, { minQuantity: 1, priceInUSD: 19000 }, { minQuantity: 0, priceInUSD: 1 }]
  it('prices every kit at the order size’s tier, and has no price without valid tiers', () => {
    expect([unitPrice(1, tiers), unitPrice(4, tiers), unitPrice(5, tiers), unitPrice(0, tiers)]).toEqual([19000, 19000, 17500, null])
    expect(unitPrice(3, [{ minQuantity: 2, priceInUSD: 100 }])).toBeNull()
    expect(nextTier(3, tiers)).toEqual({ minQuantity: 5, priceInUSD: 17500 })
  })
  it('charges flat shipping by size, never lets the return part exceed the whole, and falls back when unset', () => {
    const st = [{ minQuantity: 1, shippingCents: 900, returnCents: 400 }, { minQuantity: 10, shippingCents: 1500, returnCents: 9000 }]
    expect([shippingFor(3, st), shippingFor(12, st)]).toEqual([{ shipping: 900, returnPart: 400 }, { shipping: 1500, returnPart: 1500 }])
    expect(shippingFor(3, [{ minQuantity: 2, shippingCents: 5, returnCents: 0 }])).toEqual({ shipping: 0, returnPart: 0 })
    expect(shippingFor(3, null, { shipping: 800, returnPart: 900 })).toEqual({ shipping: 800, returnPart: 800 })
  })
  it('packs snugly without prices, and by cost with them', async () => {
    const opts = [{ id: '12', name: 'Twelve', kitsPerBox: 12 }, { id: '4', name: 'Four', kitsPerBox: 4 }, { id: '48', name: 'Forty-eight', kitsPerBox: 48 }]
    expect(planBoxes(13, opts)!.boxes.map((b) => [b.name, b.kits])).toEqual([['Twelve', 12], ['Four', 1]])
    const types = [{ id: 'a', name: 'Two', kitsPerBox: 2, outsideLength: 6, outsideWidth: 6, outsideHeight: 4 }, { id: 'b', name: 'One', kitsPerBox: 1, outsideLength: 6, outsideWidth: 6, outsideHeight: 2 }]
    const parcel = (t: { outsideLength?: number | null }, kits: number) => (t.outsideLength ? { lengthIn: 6, widthIn: 6, heightIn: 2, weightOz: kits * 4 } : null)
    // A box of two costs more than two boxes of one: the plan splits them.
    const cheapOnes = await planShipment(2, types, async (t) => (t.id === 'a' ? { outboundCents: 900, returnCents: 900 } : { outboundCents: 400, returnCents: 400 }), parcel)
    expect(cheapOnes!.boxes.map((b) => b.name)).toEqual(['One', 'One'])
    expect(cheapOnes!.totalCents).toBe(1600)
    // Returns unpriced when every kit comes back in person.
    expect((await planShipment(2, types, async (t) => (t.id === 'a' ? { outboundCents: 500, returnCents: 900 } : { outboundCents: 400, returnCents: 400 }), parcel, 0))!.totalCents).toBe(500)
    expect((await planShipment(2, types, async () => ({ outboundCents: 1, returnCents: 1 }), () => null))!.priced).toBe(false)
  })
  it('refuses a PO Box hub without its recipient, through Shipping’s address check', async () => {
    await expect(payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up PO', address: { kind: 'po-box', poBox: '12', city: 'Testville', state: 'AZ', postalCode: '85000' } } as never, overrideAccess: true })).rejects.toThrow(/recipient’s name/)
  })
})

describe('access, with refusals and tenancy', () => {
  it('lets only kit staff of the order’s site pack, ship and handle labels', async () => {
    const id = await newOrder()
    const code = freeKit()
    for (const who of [buyer, stranger, null]) {
      const r = await as(who)
      await kitErr(packKit(r, { order: id, code }), 'notStaff')
      await kitErr(unpackKit(await as(who), { order: id, code }), 'notStaff')
      await kitErr(makeSlip(await as(who), { order: id }), 'notStaff')
      await kitErr(markShipped(await as(who), { order: id }), 'notStaff')
      await kitErr(makeOrderLabels(await as(who), { order: id }), 'notStaff')
      await kitErr(makeOrderReturnLabels(await as(who), { order: id }), 'notStaff')
      await kitErr(refundOutboundLabels(await as(who), { order: id }), 'notStaff')
      await kitErr(replaceKit(await as(who), { code, reason: 'lost' }), 'notStaff')
      await kitErr(settleUnknownLabel(await as(who), { order: id, box: 1, found: null }), 'notStaff')
      await kitErr(staleReturnLabels(await as(who)), 'notStaff')
      await kitErr(reprintReturnLabel(await as(who), { label: 'x' }), 'notStaff')
    }
    // Another site's staff can't see the order at all, nor its kits.
    await kitErr(packKit(await as(staffB), { order: id, code: c(1) }), 'noOrder')
    await kitErr(makeOrderLabels(await as(staffB), { order: id }), 'noOrder')
    await kitErr(packKit(await as(staffA), { order: 'not-an-id!', code }), 'noOrder')
    // An order with no kits isn't a kit order.
    const plain = String((await payload.create({ collection: 'orders', data: { tenant: 'A', customer: buyer.id } as never, overrideAccess: true })).id)
    await kitErr(packKit(await as(staffA), { order: plain, code }), 'noOrder')
    // Shipped and canceled orders take no more kits.
    for (const status of ['shipped', 'cancelled']) await kitErr(packKit(await as(staffA), { order: await newOrder({ kitFulfillment: { status } }), code }), 'orderClosed')
    expect(ship.bought).toHaveLength(0)
  })
})

describe('packing and the slip', () => {
  it('packs line by line with each kit’s subject, refuses what it should, and undoes a scan', async () => {
    const id = await newOrder()
    const [k1, k2, k3, k4] = [freeKit(), freeKit(), freeKit(), freeKit()]
    expect(await packKit(await as(staffA), { order: id, code: k1 })).toEqual({ code: k1, line: 0, label: 'Made-up Shelly', packed: 1, total: 3 })
    await kitErr(packKit(await as(staffA), { order: id, code: k1 }), 'alreadyInOrder')
    await kitErr(packKit(await as(staffA), { order: id, code: '999999000001' }), 'unknownKit')
    expect(await kit(k1)).toMatchObject({ status: 'packed', buyer: buyer.id, order: id, orderLine: 0, suggestedKind: 'animal', suggestedId: 'a1', identifierLabel: 'Made-up Shelly' })
    await packKit(await as(staffA), { order: id, code: k2 })
    await unpackKit(await as(staffA), { order: id, code: k2 })
    expect(await kit(k2)).toMatchObject({ status: 'in-stock', order: null, buyer: null, suggestedId: null })
    await packKit(await as(staffA), { order: id, code: k2 })
    expect((await kit(k2)).suggestedId).toBe('a2')
    expect(await packKit(await as(staffA), { order: id, code: k3 })).toMatchObject({ line: 1, label: null, packed: 3 })
    expect((await order(id)).kitFulfillment.status).toBe('packed')
    await kitErr(packKit(await as(staffA), { order: id, code: k4 }), 'orderFull')
    // A used kit isn't free.
    const other = await newOrder()
    expect((await kitErr(packKit(await as(staffA), { order: other, code: k1 }), 'notFree')).message).toBe(`Kit ${k1} isn’t free: it’s packed.`)
    await kitErr(unpackKit(await as(staffA), { order: other, code: k1 }), 'notInOrder')
  })

  it('refuses kits from recalled or expired lots', async () => {
    await createLot(await as(staffA), { lotNumber: '616161', expiresOn: '2000-01-01', firstSerial: 1, lastSerial: 2 })
    await createLot(await as(staffA), { lotNumber: '626262', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 2 })
    await recallLot(await as(staffA), { lotNumber: '626262', reason: 'Made-up fault' })
    const id = await newOrder()
    await kitErr(packKit(await as(staffA), { order: id, code: '616161000001' }), 'expired')
    await kitErr(packKit(await as(staffA), { order: id, code: '626262000001' }), 'recalled')
  })

  it('makes the slip through issueSecret, only once every kit is packed', async () => {
    const id = await newOrder()
    const first = freeKit()
    await packKit(await as(staffA), { order: id, code: first })
    await kitErr(makeSlip(await as(staffA), { order: id }), 'notPacked')
    await packKit(await as(staffA), { order: id, code: freeKit() })
    await packKit(await as(staffA), { order: id, code: freeKit() })
    const slip = await makeSlip(await as(staffA), { order: id })
    expect(slip).toHaveLength(3)
    expect(slip[0]).toMatchObject({ code: first, label: 'Made-up Shelly' })
    expect(slip[0]!.link).toContain('https://example.invalid')
    // The address is the plugin's `site.origin`, even when a caller passes its own.
    const again = await issueSecret(await as(staffA), { code: slip[1]!.code, origin: 'https://evil.example.test' } as never)
    expect(again.link!.startsWith('https://example.invalid/')).toBe(true)
    expect((await kit(first)).secretHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await eventsOf(first)).map((e) => e.type)).toEqual(['received', 'packed', 'slip-made'])
    expect((await order(id)).kitFulfillment.slipMadeAt).toBeTruthy()
    // The secret works for the buyer.
    expect(await activateKit(await as(buyer), { code: first, secret: slip[0]!.secret, subject: { kind: 'animal', id: 'a1' } })).toMatchObject({ code: first })
    await kitErr(makeSlip(await as(staffA), { order: id }), 'slipTooLate')
  })
})

describe('shipping an order', () => {
  it('needs the slip, ships, and tells the buyer after the commit, recording how it went', async () => {
    const id = await newOrder()
    for (let i = 0; i < 3; i++) await packKit(await as(staffA), { order: id, code: freeKit() })
    await kitErr(markShipped(await as(staffA), { order: id, tracking: ['9400111122223333'] }), 'noSlip')
    await makeSlip(await as(staffA), { order: id })
    notices.length = 0
    expect(await markShipped(await as(staffA), { order: id, tracking: ['9400 1111 2222 3333', 'bad'] })).toEqual({ kits: 3, tracking: ['9400111122223333'] })
    expect(notices).toEqual([{ kind: 'kits-shipped', to: { user: buyer.id, order: id }, data: { order: id, kits: 3, tracking: ['9400111122223333'] } }])
    const o = await order(id)
    expect(o.kitFulfillment).toMatchObject({ status: 'shipped', trackingNumbers: ['9400111122223333'], shippedEmail: { delivery: 'sent' } })
    await kitErr(markShipped(await as(staffA), { order: id }), 'orderClosed')
  })

  it('keeps the shipping when the notice fails, and waits for the caller’s commit', async () => {
    const id = await newOrder()
    await packAll(id)
    flags.notifyThrows = true
    await markShipped(await as(staffA), { order: id })
    expect((await order(id)).kitFulfillment).toMatchObject({ status: 'shipped', shippedEmail: { delivery: 'failed' } })
    flags.notifyThrows = false
    const id2 = await newOrder()
    await packAll(id2)
    notices.length = 0
    const req = await as(staffA)
    await initTransaction(req)
    await markShipped(req, { order: id2 })
    expect(notices).toHaveLength(0)
    await commitTransaction(req)
    await runAfterCommit(req)
    expect(notices).toHaveLength(1)
  })

  it('drops work waiting for a commit when the transaction rolls back', async () => {
    const req = await as(staffA)
    const ran: string[] = []
    await expect(inTransaction(req, async (r) => {
      afterCommit(r, async () => ran.push('rolled back'))
      throw new Error('made-up failure')
    })).rejects.toThrow(/made-up failure/)
    await inTransaction(req, async (r) => afterCommit(r, async () => ran.push('committed')))
    expect(ran).toEqual(['committed'])
  })

  it('rolls back when the site’s onShipped throws, and sends nothing', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    flags.onShippedThrows = true
    notices.length = 0
    await expect(markShipped(await as(staffA), { order: id })).rejects.toThrow(/made-up provider failure/)
    expect((await kit(codes[0]!)).status).toBe('packed')
    expect((await order(id)).kitFulfillment.status).toBe('packed')
    expect(notices).toHaveLength(0)
    // The same request used again: the failed action's notice never goes out.
    flags.onShippedThrows = false
    const req = await as(staffA)
    flags.onShippedThrows = true
    await expect(markShipped(req, { order: id })).rejects.toThrow(/made-up provider failure/)
    flags.onShippedThrows = false
    const id2 = await newOrder()
    await packAll(id2)
    await markShipped(req, { order: id2 })
    expect(notices.map((n) => n.data.order)).toEqual([id2])
  })

  it('rolls back a pack when the subject provider throws', async () => {
    const id = await newOrder()
    const code = freeKit()
    flags.packForThrows = true
    await expect(packKit(await as(staffA), { order: id, code })).rejects.toThrow(/made-up provider failure/)
    const after = await kit(code)
    expect([after.status, after.order ?? null]).toEqual(['in-stock', null])
    expect((await eventsOf(code)).map((e) => e.type)).toEqual(['received'])
    // A provider may only write its own subject fields.
    flags.packForThrows = false
    flags.packForBad = true
    await expect(packKit(await as(staffA), { order: id, code })).rejects.toThrow(/only write the subject fields/)
    expect((await kit(code)).status).toBe('in-stock')
  })

  it('refuses to ship a kit whose lot was recalled behind its back', async () => {
    await createLot(await as(staffA), { lotNumber: '656565', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    const id = await newOrder({ kitLines: [{ kind: 'count', quantity: 1 }] })
    await packKit(await as(staffA), { order: id, code: '656565000001' })
    await makeSlip(await as(staffA), { order: id })
    // Ticked straight in the database, so the recall's processing never ran.
    await (payload.db.collections['kit-lots'] as unknown as { updateOne: (f: object, u: object) => Promise<unknown> }).updateOne({ lotNumber: '656565' }, { $set: { recalled: true } })
    await kitErr(markShipped(await as(staffA), { order: id }), 'recalled')
    expect((await kit('656565000001')).status).toBe('packed')
  })
})

describe('labels at order time', () => {
  it('plans boxes by cost, buys an outbound and a return label per box, once', async () => {
    const id = await newOrder()
    const r = await makeOrderLabels(await as(staffA), { order: id })
    expect(r).toEqual({ state: 'made', boxes: 2, bought: 4 })
    const o = await order(id)
    expect(o.kitFulfillment.plan.boxes.map((b: { name: string; kits: number }) => [b.name, b.kits])).toEqual([['Outer 2', 2], ['Kit box', 1]])
    expect(o.kitFulfillment.outboundLabels).toHaveLength(2)
    expect(o.kitFulfillment.trackingNumbers).toHaveLength(2)
    // The return labels, and the record of each outbound purchase.
    expect((await allRows(id)).map((l) => [l.box, l.kind, l.status]).sort()).toEqual([[1, 'box', 'active'], [1, 'outbound', 'active'], [2, 'box', 'active'], [2, 'outbound', 'active']])
    const before = ship.bought.length
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 0 })
    expect(await labelOrderInBackground(payload, id)).toMatchObject({ state: 'made', bought: 0 })
    expect(ship.bought.length).toBe(before)
  })

  it('buys once when two runs start together', async () => {
    const id = await newOrder()
    const before = ship.bought.length
    const results = await Promise.allSettled([makeOrderLabels(await as(staffA), { order: id }), labelOrderInBackground(payload, id), makeOrderLabels(await as(staffA), { order: id })])
    expect(results.some((r) => r.status === 'fulfilled' && (r.value as { state: string } | null)?.state === 'made')).toBe(true)
    expect(ship.bought.length - before).toBe(4)
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 0 })
    expect(ship.bought.length - before).toBe(4)
  })

  it('never buys twice after an unclear answer, until staff settle it', async () => {
    const id = await newOrder()
    ship.fail('buy', 'MAYBE_BOUGHT')
    const r = await makeOrderLabels(await as(staffA), { order: id })
    expect(r.state).toBe('failed')
    expect(r.error).toMatch(/may have been bought/)
    const o = await order(id)
    expect(o.kitFulfillment.outboundLabels).toEqual([expect.objectContaining({ box: 1, unknown: true, reference: expect.stringMatching(/-box-1$/) })])
    expect(o.kitFulfillment.labels.state).toBe('failed')
    const before = ship.bought.length
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'failed', bought: 0 })
    expect(await labelOrderInBackground(payload, id)).toMatchObject({ state: 'failed', bought: 0 })
    expect(ship.bought.length).toBe(before)
    // Staff checked the carrier: it wasn't bought. Now a retry buys.
    expect(await settleUnknownLabel(await as(staffA), { order: id, box: 1, found: null })).toEqual({ result: 'not-bought' })
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 4 })
  })

  it('records an unclear return label as unknown, and keeps the outbound one it bought', async () => {
    const id = await newOrder()
    // The outbound label buys; the return label's purchase is unclear.
    const buys = ship.bought.length
    const original = ship.adapter.buyReturn
    let calls = 0
    ship.adapter.buyReturn = async (...args) => {
      if (++calls === 1) throw Object.assign(new Error('made-up unclear'), { name: 'CarrierError', code: 'MAYBE_BOUGHT', status: 0 })
      return original(...args)
    }
    try {
      const r = await makeOrderLabels(await as(staffA), { order: id })
      expect(r).toMatchObject({ state: 'failed', bought: 1 })
      expect(ship.bought.length).toBe(buys + 1)
      const [unknown] = await labelsOf(id)
      expect(unknown).toMatchObject({ status: 'unknown', box: 1, reference: expect.stringMatching(/-box-1$/) })
      expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ bought: 0 })
      // Staff found it at the carrier: it becomes an ordinary label, and the rest can be bought.
      await settleUnknownLabel(await as(staffA), { label: String(unknown!.id), found: { tracking: '9400999988887777', shipmentId: 'shp_made_up' } })
      expect((await labelsOf(id))[0]).toMatchObject({ status: 'active', tracking: '9400999988887777' })
      // A label that isn't waiting can't be settled again.
      await kitErr(settleUnknownLabel(await as(staffA), { label: String(unknown!.id), found: null }), 'noLabel')
      expect((await labelsOf(id))[0]!.status).toBe('active')
      expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 2 })
    } finally {
      ship.adapter.buyReturn = original
    }
  })

  it('refuses when real postage is off, buying and recording nothing; the background run records why', async () => {
    const id = await newOrder()
    const before = ship.bought.length
    ship.fail('quote', 'REFUSED')
    await kitErr(makeOrderLabels(await as(staffA), { order: id }), 'postageOff')
    expect(ship.bought.length).toBe(before)
    expect((await order(id)).kitFulfillment.outboundLabels ?? []).toHaveLength(0)
    ship.fail('quote', 'REFUSED')
    expect(await labelOrderInBackground(payload, id)).toMatchObject({ state: 'failed', bought: 0 })
    expect((await order(id)).kitFulfillment.labels).toMatchObject({ state: 'failed', error: expect.stringMatching(/postage is off/) })
  })

  it('keeps what it bought when the carrier refuses half way, and buys only what’s missing on retry', async () => {
    const id = await newOrder()
    // Outbound quotes: two for the plan, one for box 1, then box 2's is refused.
    let quotes = 0
    const original = ship.adapter.quote
    ship.adapter.quote = async (...args) => {
      if (++quotes === 4) throw Object.assign(new Error('made-up refusal'), { name: 'CarrierError', code: 'ADDRESS.INVALID', status: 422 })
      return original(...args)
    }
    try {
      const r = await makeOrderLabels(await as(staffA), { order: id })
      expect(r).toMatchObject({ state: 'failed', bought: 2 })
      expect((await order(id)).kitFulfillment.outboundLabels).toHaveLength(1)
    } finally {
      ship.adapter.quote = original
    }
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 2 })
    expect((await order(id)).kitFulfillment.outboundLabels.map((l: { box: number }) => l.box)).toEqual([1, 2])
  })

  it('keeps a paid label’s record when the caller’s transaction rolls back, and links it again instead of buying', async () => {
    const id = await newOrder()
    const before = ship.bought.length
    const req = await as(staffA)
    await initTransaction(req)
    expect(await makeOrderLabels(req, { order: id })).toMatchObject({ state: 'made', bought: 4 })
    await killTransaction(req)
    // The order forgot its labels with the rollback; the records of what was paid for stayed.
    expect((await order(id)).kitFulfillment.outboundLabels ?? []).toHaveLength(0)
    const kept = await allRows(id)
    expect(kept.map((l) => [l.kind, l.status, Boolean(l.tracking)]).sort()).toEqual([['box', 'active', true], ['box', 'active', true], ['outbound', 'active', true], ['outbound', 'active', true]])
    expect(await makeOrderLabels(await as(staffA), { order: id })).toMatchObject({ state: 'made', bought: 0 })
    expect(ship.bought.length - before).toBe(4)
    expect((await order(id)).kitFulfillment.outboundLabels.map((l: { tracking: string }) => l.tracking).sort()).toEqual(kept.filter((l) => l.kind === 'outbound').map((l) => l.tracking).sort())
    // The same for return labels bought at packing.
    const id2 = await newOrder()
    await packAll(id2)
    const r2 = await as(staffA)
    await initTransaction(r2)
    expect(await makeOrderReturnLabels(r2, { order: id2 })).toMatchObject({ made: 2 })
    await killTransaction(r2)
    expect((await labelsOf(id2)).map((l) => l.status)).toEqual(['active', 'active'])
    const n = ship.bought.length
    expect(await makeOrderReturnLabels(await as(staffA), { order: id2 })).toMatchObject({ made: 0, current: 2 })
    expect(ship.bought.length).toBe(n)
  })

  it('refuses another purchase for an order and box while one is buying or unknown, until settled', async () => {
    const id = await newOrder()
    await packAll(id)
    // A crash between asking the carrier and hearing back leaves a "buying" row. Older than a purchase in flight, it's
    // treated as unknown; a fresh one is another request's purchase (busy).
    const now = new Date(Date.now() - 10 * 60_000).toISOString()
    const stuck = (await payload.db.create({ collection: 'return-labels', data: { tenant: 'A', order: id, box: 1, kind: 'box', kits: [], status: 'buying', reference: 'made-up-ref', createdAt: now, updatedAt: now } } as never)) as unknown as { id: string }
    const before = ship.bought.length
    const r = await makeOrderReturnLabels(await as(staffA), { order: id })
    expect(r).toMatchObject({ made: 1, unknown: 1, error: expect.stringMatching(/may already have been bought/) })
    expect((await labelsOf(id)).filter((l) => l.box === 1).map((l) => l.status)).toEqual(['buying'])
    expect(ship.bought.length).toBe(before + 1)
    // The keeper gets box 2's label (box labels are interchangeable); nothing is bought. Order-time labels are refused.
    await markShipped(await as(staffA), { order: id })
    expect(await customerReturnLabel(await as(buyer), { code: (await packKitCodes(id))[0]! })).toMatchObject({ result: 'current' })
    const id3 = await newOrder()
    await payload.db.create({ collection: 'return-labels', data: { tenant: 'A', order: id3, box: 1, kind: 'outbound', kits: [], status: 'buying', reference: 'made-up-ref-2', createdAt: now, updatedAt: now } } as never)
    expect(await makeOrderLabels(await as(staffA), { order: id3 })).toMatchObject({ state: 'failed', bought: 0 })
    expect(ship.bought.length).toBe(before + 1)
    // The record keeper itself refuses, whoever calls it, and never asks the carrier.
    let asked = false
    await kitErr(recordedPurchase(payload, payload.config.custom!.sampleKits as never, { order: id3, kind: 'outbound', box: 1, site: 'A', reference: 'x' }, async () => {
      asked = true
      throw new Error('should not be asked')
    }), 'labelUnknown')
    expect(asked).toBe(false)
    // A purchase another request started moments ago is a lost race: busy, in plain words.
    const racing = await newOrder()
    const fresh = new Date().toISOString()
    await payload.db.create({ collection: 'return-labels', data: { tenant: 'A', order: racing, box: 1, kind: 'outbound', kits: [], status: 'buying', reference: 'made-up-ref-3', createdAt: fresh, updatedAt: fresh } } as never)
    const lost = await kitErr(recordedPurchase(payload, payload.config.custom!.sampleKits as never, { order: racing, kind: 'outbound', box: 1, site: 'A', reference: 'y' }, async () => {
      asked = true
      throw new Error('should not be asked')
    }), 'busy')
    expect(lost.message).toBe('Someone else just did this; refresh and check.')
    expect(asked).toBe(false)
    // While the carrier is being asked, the record already says "buying", committed for anyone to see.
    const id4 = await newOrder()
    let during: string[] = []
    const made = await recordedPurchase(payload, payload.config.custom!.sampleKits as never, { order: id4, kind: 'outbound', box: 1, site: 'A', reference: 'made-up-ref-4' }, async () => {
      during = (await allRows(id4)).map((l) => l.status)
      return { shipmentId: 'shp_made_up_4', tracking: '9400444444444444', carrier: 'USPS', service: 'GroundAdvantage', rateCents: 500, labelUrl: '', trackerUrl: null, mode: 'test' }
    })
    expect(during).toEqual(['buying'])
    expect(made.row).toMatchObject({ status: 'active', tracking: '9400444444444444', costCents: 500 })
    // Settled as not bought: the box can be bought again.
    expect(await settleUnknownLabel(await as(staffA), { label: String(stuck.id), found: null })).toEqual({ result: 'not-bought' })
    expect(await settleUnknownLabel(await as(staffA), { order: id3, box: 1, found: null })).toEqual({ result: 'not-bought' })
    expect(await makeOrderLabels(await as(staffA), { order: id3 })).toMatchObject({ state: 'made', bought: 4 })
  })

  it('leaves pre-orders and shipped orders alone', async () => {
    await kitErr(makeOrderLabels(await as(staffA), { order: await newOrder({ kitFulfillment: { status: 'pre-order' } }) }), 'orderClosed')
    await kitErr(makeOrderLabels(await as(staffA), { order: await newOrder({ kitFulfillment: { status: 'shipped' } }) }), 'orderClosed')
  })

  it('asks for unshipped outbound labels’ refunds, and records "too-old" past 30 days without asking', async () => {
    const id = await newOrder()
    await makeOrderLabels(await as(staffA), { order: id })
    const o = await order(id)
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString()
    const labels = o.kitFulfillment.outboundLabels.map((l: Record<string, unknown>, i: number) => (i === 1 ? { ...l, at: old } : l))
    await payload.update({ collection: 'orders', id, data: { kitFulfillment: { ...o.kitFulfillment, outboundLabels: labels } } as never, overrideAccess: true })
    const asked = ship.refunds.length
    expect(await refundOutboundLabels(await as(staffA), { order: id })).toEqual([{ box: 1, refund: 'submitted' }, { box: 2, refund: 'too-old' }])
    expect(ship.refunds.length).toBe(asked + 1)
    // The carrier's later answer.
    expect(await applyRefundEvent(await as(null), { tracking: labels[0].tracking, status: 'refunded' })).toBe('updated')
    expect((await order(id)).kitFulfillment.outboundLabels[0].refund).toBe('refunded')
    // An answer for a refund nobody asked for changes nothing.
    const other = await newOrder()
    await makeOrderLabels(await as(staffA), { order: other })
    const t = (await order(other)).kitFulfillment.outboundLabels[0].tracking
    expect(await applyRefundEvent(await as(null), { tracking: t, status: 'refunded' })).toBe('unchanged')
    expect((await order(other)).kitFulfillment.outboundLabels[0].refund ?? null).toBeNull()
    const [ret] = await labelsOf(other)
    expect(await applyRefundEvent(await as(null), { tracking: ret!.tracking, status: 'refunded' })).toBe('unchanged')
    expect((await labelsOf(other))[0]!.refund ?? null).toBeNull()
  })
})

describe('return labels', () => {
  it('makes one per outbound box, never twice, lists them when the hub moves, and reprints with a refund', async () => {
    const id = await newOrder()
    await packAll(id)
    expect(await makeOrderReturnLabels(await as(staffA), { order: id })).toMatchObject({ made: 2, current: 0 })
    expect(await makeOrderReturnLabels(await as(staffA), { order: id })).toMatchObject({ made: 0, current: 2 })
    expect((await eventsOf((await packKitCodes(id))[0]!)).filter((e) => e.type === 'label-printed')).toHaveLength(2)
    await payload.update({ collection: 'hubs', id: hubA, data: { address: { ...HUB_ADDRESS, line1: '3 New Example Way' } } as never, overrideAccess: true })
    try {
      const stale = (await staleReturnLabels(await as(staffA))).filter((l) => l.order === id)
      expect(stale).toHaveLength(2)
      await kitErr(makeOrderReturnLabels(await as(staffA), { order: id }), 'staleLabel')
      const asked = ship.refunds.length
      expect(await reprintReturnLabel(await as(staffA), { label: stale[0]!.id })).toMatchObject({ result: 'made', refund: 'submitted' })
      expect(ship.refunds.length).toBe(asked + 1)
      await kitErr(reprintReturnLabel(await as(staffA), { label: stale[0]!.id }), 'noLabel')
      // Past 30 days, nothing is asked: it's recorded as too old.
      await age(stale[1]!.id)
      expect(await reprintReturnLabel(await as(staffA), { label: stale[1]!.id })).toMatchObject({ result: 'made', refund: 'too-old' })
      expect(ship.refunds.length).toBe(asked + 1)
      // A failed purchase leaves the old label as it was.
      const fresh = (await labelsOf(id)).filter((l) => l.status === 'active')
      await payload.update({ collection: 'hubs', id: hubA, data: { address: HUB_ADDRESS } as never, overrideAccess: true })
      ship.fail('buy', 'SHIPMENT.INVALID', 422)
      await kitErr(reprintReturnLabel(await as(staffA), { label: String(fresh[0]!.id) }), 'carrier')
      expect((await labelsOf(id)).find((l) => l.id === fresh[0]!.id)!.status).toBe('active')
    } finally {
      await payload.update({ collection: 'hubs', id: hubA, data: { address: HUB_ADDRESS } as never, overrideAccess: true })
    }
  })

  it('gives the keeper the current label at no cost, one extra per kit, and nothing to strangers', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await markShipped(await as(staffA), { order: id })
    await makeOrderReturnLabelsAfterShip(id)
    const before = ship.bought.length
    const first = await customerReturnLabel(await as(buyer), { code: codes[0]! })
    expect(first.result).toBe('current')
    expect(ship.bought.length).toBe(before)
    const extra = await customerReturnLabel(await as(buyer), { code: codes[0]!, extra: true })
    expect(extra.result).toBe('made')
    expect(await customerReturnLabel(await as(buyer), { code: codes[0]!, extra: true })).toEqual({ result: 'current', labelUrl: extra.labelUrl, tracking: extra.tracking })
    expect(ship.bought.length).toBe(before + 1)
    // A stranger, another site's person and the signed-out learn nothing.
    await kitErr(customerReturnLabel(await as(stranger), { code: codes[0]! }), 'notYourKit')
    await kitErr(customerReturnLabel(await as(stranger), { code: '999999000001' }), 'notYourKit')
    await kitErr(customerReturnLabel(await as(adminB), { code: codes[0]! }), 'notYourKit')
    await kitErr(customerReturnLabel(await as(null), { code: codes[0]! }), 'signIn')
    // An unclear purchase for an extra stops the next one.
    ship.fail('buy', 'MAYBE_BOUGHT')
    expect(await customerReturnLabel(await as(buyer), { code: codes[1]!, extra: true })).toMatchObject({ result: 'unknown' })
    const n = ship.bought.length
    await kitErr(customerReturnLabel(await as(buyer), { code: codes[1]!, extra: true }), 'labelUnknown')
    expect(ship.bought.length).toBe(n)
  })

  it('refunds labels freed by kits coming back in person, and shows every outcome', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await makeOrderReturnLabels(await as(staffA), { order: id })
    // All three in person: both box labels go. The first refused by the carrier stays active.
    ship.fail('refund', 'SHIPMENT.REFUND.REJECTED', 422)
    const out = await cancelReturnLabels(await as(staffA), { order: id, kits: 'all', where: 'Made-up expo' })
    expect(out.map((l) => l.result).sort()).toEqual(['refused', 'requested'])
    const labels = await labelsOf(id)
    expect(labels.map((l) => l.status).sort()).toEqual(['active', 'cancelled'])
    expect(labels.find((l) => l.status === 'active')!.refund).toMatch(/^refused/)
    expect((await kit(codes[0]!)).returnInPerson).toBe('Made-up expo')
    // Asked again, the refused label isn't asked again: a refusal is final.
    const asked = ship.refunds.length
    await cancelReturnLabels(await as(staffA), { order: id, kits: 'all', where: 'Made-up expo' })
    expect(ship.refunds.length).toBe(asked)
    // A kit coming back in person gets no return label.
    await recordKitEvent(await as(staffA), await kit(codes[0]!), { type: 'shipped' })
    await kitErr(customerReturnLabel(await as(buyer), { code: codes[0]! }), 'returnInPerson')
    await kitErr(cancelReturnLabels(await as(buyer), { order: id, kits: 'all', where: 'x' }), 'notStaff')
    await kitErr(cancelReturnLabels(await as(staffA), { order: id, kits: 'all', where: ' ' }), 'returnWhere')
  })

  it('cancels unneeded labels when a kit is marked in person in the admin, and records "too late" after 30 days', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await makeOrderReturnLabels(await as(staffA), { order: id })
    const labels = await labelsOf(id)
    for (const l of labels) await age(l.id)
    const asked = ship.refunds.length
    // Kit 3 rides alone in box 2; once it's in person, one box is enough.
    await payload.update({ collection: 'kits', id: (await kit(codes[2]!)).id, data: { returnInPerson: 'Made-up hub' } as never, overrideAccess: false, user: { ...staffA, collection: 'users' } as never })
    expect(ship.refunds.length).toBe(asked)
    expect((await labelsOf(id)).map((l) => l.refund ?? null)).toEqual([null, 'too-old'])
    expect((await eventsOf(codes[2]!)).some((e) => e.type === 'note' && /refund too-late/.test(e.note))).toBe(true)
  })
})

describe('refund shipping (money)', () => {
  it('refunds once, never more than paid, for the site’s admins only', async () => {
    const id = await newOrder()
    for (const who of [staffA, buyer, stranger, null]) await kitErr(refundShipping(await as(who), { order: id, amountCents: 600, reason: 'Made-up expo' }), 'notAllowed')
    await kitErr(refundShipping(await as(adminB), { order: id, amountCents: 600, reason: 'Made-up expo' }), 'notAllowed')
    await kitErr(refundShipping(await as(adminA), { order: '000000000000000000000000', amountCents: 600, reason: 'Made-up expo' }), 'notAllowed')
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 1201, reason: 'Made-up expo' }), 'refundTooMuch')
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 0, reason: 'Made-up expo' }), 'refundAmount')
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 600, reason: '  ' }), 'refundReason')
    pay.fail()
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 600, reason: 'Made-up expo' }), 'refundFailed')
    expect((await order(id)).kitFulfillment.shippingRefund?.status ?? null).toBeNull()
    const real = pay.payments.refund
    pay.payments.refund = async () => ({ id: '' })
    try {
      // An answer without an id may still have refunded: unknown, counted until an admin settles it.
      await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 600, reason: 'Made-up expo' }), 'refundUnknown')
    } finally {
      pay.payments.refund = real
    }
    expect((await order(id)).kitFulfillment.shippingRefund?.status ?? null).toBeNull()
    const r = await refundShipping(await as(adminA), { order: id, amountCents: 600, reason: 'Made-up expo' })
    expect(r).toMatchObject({ amountCents: 600 })
    expect(pay.refunds.filter((x) => x.key === `kit-return-shipping-${id}`)).toHaveLength(1)
    expect((await order(id)).kitFulfillment.shippingRefund).toMatchObject({ status: 'refunded', amountCents: 600, reason: 'Made-up expo', by: adminA.id, refundId: r.refundId })
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 100, reason: 'again' }), 'alreadyRefunded')
    // Said before anything else is checked: a finished refund is finished.
    await kitErr(refundShipping(await as(adminA), { order: id, amountCents: 0, reason: '' }), 'alreadyRefunded')
    expect(pay.refunds.filter((x) => x.key === `kit-return-shipping-${id}`)).toHaveLength(1)
  })
})

describe('replacements and credits back', () => {
  async function sold(n = 3) {
    const id = await newOrder()
    const { codes, slip } = await packAll(id, n)
    await markShipped(await as(staffA), { order: id })
    return { id, codes, slip }
  }
  const toStatus = async (code: string, type: 'returned' | 'activated') => recordKitEvent(await as(staffA), await kit(code), { type })

  it('replaces a recalled kit for free with a new order in the packing queue', async () => {
    await createLot(await as(staffA), { lotNumber: '636363', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 4 })
    const id = await newOrder({ kitLines: [{ kind: 'animal', quantity: 1, subjectIds: ['a1'] }] })
    await packKit(await as(staffA), { order: id, code: '636363000001' })
    await makeSlip(await as(staffA), { order: id })
    await markShipped(await as(staffA), { order: id })
    await recallLot(await as(staffA), { lotNumber: '636363', reason: 'Made-up fault' })
    const r = await replaceKit(await as(staffA), { code: '636363000001', reason: 'recalled' })
    expect(r.outcome).toBe('replacement')
    const fresh = await order((r as { order: string }).order)
    expect(fresh).toMatchObject({ tenant: 'A', customer: buyer.id, kitLines: [expect.objectContaining({ kind: 'animal', quantity: 1, subjectIds: ['a1'] })], kitFulfillment: expect.objectContaining({ status: 'to-pack', replaces: (await kit('636363000001')).id }) })
    expect((await kit('636363000001')).status).toBe('replaced')
    await kitErr(replaceKit(await as(staffA), { code: '636363000001', reason: 'recalled' }), 'alreadyReplaced')
    const code = freeKit()
    await packKit(await as(staffA), { order: fresh.id, code })
    expect(await kit(code)).toMatchObject({ attempt: 1, replacementOf: (await kit('636363000001')).id, suggestedId: 'a1' })
  })

  it('gives one free replacement for a lost kit, not two', async () => {
    const { codes } = await sold(1 + 2)
    const r = await replaceKit(await as(staffA), { code: codes[0]!, reason: 'lost', note: 'Made-up: never arrived' })
    const code = freeKit()
    await packKit(await as(staffA), { order: (r as { order: string }).order, code })
    await makeSlip(await as(staffA), { order: (r as { order: string }).order })
    await markShipped(await as(staffA), { order: (r as { order: string }).order })
    await kitErr(replaceKit(await as(staffA), { code, reason: 'lost' }), 'secondFree')
    await kitErr(replaceKit(await as(staffA), { code: freeKit(), reason: 'lost' }), 'notSold')
    await kitErr(replaceKit(await as(staffA), { code: codes[1]!, reason: 'broken' }), 'chooseReason')
    await kitErr(replaceKit(await as(staffA), { code: codes[1]!, reason: 'failed' }), 'cantReplace')
  })

  it('sends a retest after a failed sample, then gives one test back, once, through payments', async () => {
    const { codes } = await sold()
    await toStatus(codes[0]!, 'activated')
    await toStatus(codes[0]!, 'returned')
    const r = await replaceKit(await as(staffA), { code: codes[0]!, reason: 'failed' })
    const code = freeKit()
    await packKit(await as(staffA), { order: (r as { order: string }).order, code })
    expect((await kit(code)).attempt).toBe(2)
    await makeSlip(await as(staffA), { order: (r as { order: string }).order })
    await markShipped(await as(staffA), { order: (r as { order: string }).order })
    await toStatus(code, 'activated')
    await toStatus(code, 'returned')
    // A payment provider that throws leaves the kit as it was.
    pay.fail()
    await expect(replaceKit(await as(staffA), { code, reason: 'failed' })).rejects.toThrow(/made-up payment failure/)
    expect((await kit(code)).status).toBe('returned')
    expect(await replaceKit(await as(staffA), { code, reason: 'failed' })).toEqual({ outcome: 'credit', code })
    expect(await replaceKit(await as(staffA), { code, reason: 'failed' })).toEqual({ outcome: 'credit', code })
    const kitId = String((await kit(code)).id)
    expect(pay.credits.filter((x) => x.kit === kitId)).toEqual([expect.objectContaining({ key: `kit:${kitId}` })])
  })
})

describe('recall reopens unshipped orders', () => {
  it('takes packed kits out and puts the order back in the packing queue; shipped orders stay', async () => {
    await createLot(await as(staffA), { lotNumber: '646464', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 6 })
    const packed = await newOrder({ kitLines: [{ kind: 'count', quantity: 2 }] })
    await packKit(await as(staffA), { order: packed, code: '646464000001' })
    await packKit(await as(staffA), { order: packed, code: '646464000002' })
    expect((await order(packed)).kitFulfillment.status).toBe('packed')
    const shipped = await newOrder({ kitLines: [{ kind: 'count', quantity: 1 }] })
    await packKit(await as(staffA), { order: shipped, code: '646464000003' })
    await makeSlip(await as(staffA), { order: shipped })
    await markShipped(await as(staffA), { order: shipped })
    await recallLot(await as(staffA), { lotNumber: '646464', reason: 'Made-up fault' })
    expect((await order(packed)).kitFulfillment.status).toBe('to-pack')
    expect(await kit('646464000001')).toMatchObject({ status: 'recalled', order: null, buyer: null })
    expect((await order(shipped)).kitFulfillment.status).toBe('shipped')
    expect((await kit('646464000003')).status).toBe('recalled')
    await kitErr(packKit(await as(staffA), { order: packed, code: '646464000004' }), 'recalled')
  })
})

describe('carrier tracking', () => {
  it('moves shipped kits to Delivered once, tells the buyer after the commit, and leaves unknown parcels to others', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await markShipped(await as(staffA), { order: id, tracking: ['9400555566667777'] })
    notices.length = 0
    const req = await as(null)
    expect(await shippingHandler.onTracker({ event: { id: 'evt_1', tracking: '9400555566667777', status: 'out_for_delivery' }, req, payload })).toBe('handled')
    expect((await kit(codes[0]!)).status).toBe('shipped')
    expect(await applyTrackerEvent(await as(null), { id: 'evt_2', tracking: '9400555566667777', status: 'delivered' })).toBe('applied')
    expect(await applyTrackerEvent(await as(null), { id: 'evt_3', tracking: '9400555566667777', status: 'delivered' })).toBe('duplicate')
    for (const code of codes) expect((await kit(code)).status).toBe('delivered')
    expect(notices.map((n) => [n.kind, n.data.event, n.to])).toEqual([
      ['kit-shipment', 'out-for-delivery', { user: buyer.id, order: id }],
      ['kit-shipment', 'delivered', { user: buyer.id, order: id }],
    ])
    expect(await shippingHandler.onTracker({ event: { id: 'evt_4', tracking: '9400000000000000', status: 'delivered' }, req, payload })).toBe('unknown')
    expect(await shippingHandler.onRefund({ event: { tracking: '9400000000000000', status: 'refunded' }, req, payload })).toBe('unknown')
  })

  it('records the return leg without moving kits', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await markShipped(await as(staffA), { order: id })
    await makeOrderReturnLabelsAfterShip(id)
    const [label] = await labelsOf(id)
    expect(await applyTrackerEvent(await as(null), { id: 'evt_r1', tracking: label!.tracking, status: 'in_transit' })).toBe('recorded')
    expect((await kit(codes[0]!)).status).toBe('shipped')
    expect((await eventsOf(codes[0]!)).some((e) => e.details?.leg === 'return')).toBe(true)
  })
})

describe('shipment notices, each once', () => {
  /** A tracker update shaped as Shipping's webhook hands it over (its `TrackerEvent`), made up. */
  let ev = 0
  const carrier = (tracking: string, status: string) => ({ id: `evt_made_up_${++ev}`, createdAt: new Date().toISOString(), tracking, status, carrier: 'USPS', publicUrl: null })
  const track = async (tracking: string, status: string) => shippingHandler.onTracker({ event: carrier(tracking, status) as never, req: await as(null), payload })
  const rows = async (tracking: string) => (await payload.find({ collection: 'kit-notices', where: { tracking: { equals: tracking } }, sort: 'createdAt', overrideAccess: true, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
  const said = () => notices.map((n) => [n.kind, n.data.event, n.data.leg, n.to])
  let n = 0
  const shippedOrder = async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    const tracking = `9400123400000000${String(++n).padStart(6, '0')}`
    await markShipped(await as(staffA), { order: id, tracking: [tracking] })
    notices.length = 0
    return { id, codes, tracking }
  }

  it('tells the buyer each outbound status once, and the buyer and staff of a problem, however often the carrier repeats it', async () => {
    const { id, tracking } = await shippedOrder()
    for (const status of ['in_transit', 'out_for_delivery', 'out_for_delivery', 'failure', 'return_to_sender', 'failure', 'delivered', 'available_for_pickup', 'delivered'])
      expect(await track(tracking, status)).toBe('handled')
    expect(said()).toEqual([
      ['kit-shipment', 'out-for-delivery', 'outbound', { user: buyer.id, order: id }],
      ['kit-shipment', 'exception', 'outbound', { user: buyer.id, order: id }],
      ['kit-shipment-staff', 'exception', 'outbound', { user: null, order: id, staff: true, site: 'A' }],
      ['kit-shipment', 'delivered', 'outbound', { user: buyer.id, order: id }],
    ])
    expect((await rows(tracking)).map((r) => [r.audience, r.status, r.attempts])).toEqual([
      ['buyer', 'sent', 1],
      ['buyer', 'sent', 1],
      ['staff', 'sent', 1],
      ['buyer', 'sent', 1],
    ])
    // The same event id again (a webhook retry): nothing new either.
    const again = carrier(tracking, 'delivered')
    await shippingHandler.onTracker({ event: again as never, req: await as(null), payload })
    await shippingHandler.onTracker({ event: again as never, req: await as(null), payload })
    expect(notices).toHaveLength(4)
    // Never an address, and staff get the codes and carrier status.
    expect(JSON.stringify(notices)).not.toMatch(/Sample Road|Faketown|Example Way|Made-up Buyer|85001/)
    expect(notices[2]!.data).toMatchObject({ carrierStatus: 'failure', tracking: [tracking], order: id })
  })

  it('sends a notice that failed on the parcel’s next update or the daily run, and gives up after five tries', async () => {
    const { id, tracking } = await shippedOrder()
    flags.notifyThrows = true
    await track(tracking, 'out_for_delivery')
    expect(notices).toHaveLength(0)
    expect((await rows(tracking)).map((r) => [r.status, r.attempts])).toEqual([['failed', 1]])
    flags.notifyThrows = false
    // A repeat of the same status is enough to send what's still owed.
    await track(tracking, 'out_for_delivery')
    expect(said()).toEqual([['kit-shipment', 'out-for-delivery', 'outbound', { user: buyer.id, order: id }]])
    // The daily run, for one that failed with no update after it.
    flags.notifyThrows = true
    await track(tracking, 'delivered')
    flags.notifyThrows = false
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 1, failed: 0 })
    expect(notices.map((x) => x.data.event)).toEqual(['out-for-delivery', 'delivered'])
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 0, failed: 0 })
    // Five failures, then it waits for staff.
    flags.notifyThrows = true
    await track(tracking, 'error')
    for (let i = 0; i < 6; i++) await retryKitNotices(await as(null))
    expect((await rows(tracking)).filter((r) => r.data.event === 'exception').map((r) => [r.status, r.attempts])).toEqual([
      ['gave-up', 5],
      ['gave-up', 5],
    ])
    // Even a row someone set back to failed isn't tried a sixth time, by an update or the run.
    flags.notifyThrows = false
    notices.length = 0
    const gaveUp = (await rows(tracking)).find((r) => r.status === 'gave-up')!
    await payload.db.updateOne({ collection: 'kit-notices', id: gaveUp.id, data: { status: 'failed' } } as never)
    await track(tracking, 'error')
    await retryKitNotices(await as(null))
    expect(notices).toHaveLength(0)
  })

  it('sends a notice left pending by a crash before its send, and one left sending only once it’s stale', async () => {
    const { tracking } = await shippedOrder()
    await track(tracking, 'out_for_delivery')
    const [row] = await rows(tracking)
    await payload.db.updateOne({ collection: 'kit-notices', id: row!.id, data: { status: 'sending', triedAt: new Date().toISOString() } } as never)
    notices.length = 0
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 0, failed: 0 })
    await payload.db.updateOne({ collection: 'kit-notices', id: row!.id, data: { triedAt: new Date(Date.now() - 11 * 60_000).toISOString() } } as never)
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 1, failed: 0 })
    await payload.db.updateOne({ collection: 'kit-notices', id: row!.id, data: { status: 'pending', attempts: 1 } } as never)
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 1, failed: 0 })
    expect(notices).toHaveLength(2)
  })

  it('sends a notice owed once when several senders run at the same moment', async () => {
    const { tracking } = await shippedOrder()
    flags.notifyThrows = true
    await track(tracking, 'out_for_delivery')
    flags.notifyThrows = false
    notices.length = 0
    const runs = await Promise.all([retryKitNotices(await as(null)), retryKitNotices(await as(null)), track(tracking, 'out_for_delivery'), retryKitNotices(await as(null))])
    expect(notices).toHaveLength(1)
    expect(runs.filter((r) => typeof r === 'object').reduce((n, r) => n + (r as { sent: number }).sent, 0)).toBeLessThanOrEqual(1)
    expect((await rows(tracking)).map((r) => [r.status, r.attempts])).toEqual([['sent', 2]])
  })

  it('sends one notice when the carrier sends the same update twice at once', async () => {
    const { tracking } = await shippedOrder()
    const results = await Promise.allSettled([track(tracking, 'out_for_delivery'), track(tracking, 'out_for_delivery'), track(tracking, 'out_for_delivery')])
    // A loser may fail (Shipping answers 500 and the carrier tries again later); its retry is a duplicate.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    await track(tracking, 'out_for_delivery')
    expect(notices.filter((x) => x.data.event === 'out-for-delivery')).toHaveLength(1)
    expect(await rows(tracking)).toHaveLength(1)
  })

  it('tells the keeper of a gift, not its buyer, about a return-leg problem, and nobody while it’s in transit or delivered', async () => {
    const keeper = await person(payload, 'A')
    const id = await newOrder()
    const { codes } = await packAll(id)
    await markShipped(await as(staffA), { order: id })
    await makeOrderReturnLabelsAfterShip(id)
    const [label] = await labelsOf(id)
    const onLabel = ((label!.kits as unknown[]) ?? []).map(String)
    const covered: string[] = []
    for (const code of codes) {
      const k = await kit(code)
      if (onLabel.length && !onLabel.includes(String(k.id))) continue
      covered.push(code)
      await recordKitEvent(await as(staffA), k, { type: 'activated', set: { activatedBy: keeper.id, activatedAt: new Date().toISOString() } })
    }
    notices.length = 0
    for (const status of ['in_transit', 'out_for_delivery', 'delivered', 'available_for_pickup']) await track(label!.tracking, status)
    expect(notices).toHaveLength(0)
    await track(label!.tracking, 'return_to_sender')
    await track(label!.tracking, 'return_to_sender')
    expect(said()).toEqual([
      ['kit-shipment', 'exception', 'return', { user: keeper.id, order: null }],
      ['kit-shipment-staff', 'exception', 'return', { user: null, order: id, staff: true, site: 'A' }],
    ])
    // A gift keeper (who may be a minor) never sees the buyer or the order, in `to` or in `data`.
    expect(JSON.stringify(notices[0])).not.toContain(String(buyer.id))
    expect(JSON.stringify(notices[0]!.to)).not.toContain(String(id))
    expect(JSON.stringify(notices[0]!.data)).not.toContain(String(id))
    expect(notices[0]!.data).not.toHaveProperty('order')
    // The row keeps the order, for the seed and for retries.
    const row = (await payload.find({ collection: 'kit-notices', where: { and: [{ audience: { equals: 'keeper' } }, { user: { equals: keeper.id } }] }, overrideAccess: true, depth: 0 })).docs[0] as unknown as { order?: unknown }
    expect(String(row.order)).toBe(String(id))
    expect(notices[0]!.data.codes).toEqual(covered)
    // No kit on it activated: the buyer mailed it, so the buyer hears.
    const id2 = await newOrder()
    await packAll(id2)
    await markShipped(await as(staffA), { order: id2 })
    await makeOrderReturnLabelsAfterShip(id2)
    const [label2] = await labelsOf(id2)
    notices.length = 0
    await track(label2!.tracking, 'failure')
    expect(said()).toEqual([
      ['kit-shipment', 'exception', 'return', { user: buyer.id, order: id2 }],
      ['kit-shipment-staff', 'exception', 'return', { user: null, order: id2, staff: true, site: 'A' }],
    ])
  })

  it('does nothing for a tracking number that isn’t ours', async () => {
    notices.length = 0
    const before = (await payload.count({ collection: 'kit-notices', overrideAccess: true })).totalDocs
    for (const status of ['out_for_delivery', 'delivered', 'failure']) expect(await track('9400999988887777666655', status)).toBe('unknown')
    expect(notices).toHaveLength(0)
    expect((await payload.count({ collection: 'kit-notices', overrideAccess: true })).totalDocs).toBe(before)
  })

  it('stores only the delivery answers it knows, and anything else as unknown', async () => {
    const { tracking } = await shippedOrder()
    flags.notifyAnswer = 'no-address'
    await track(tracking, 'out_for_delivery')
    flags.notifyAnswer = 'made-up <b>answer</b>'
    await track(tracking, 'delivered')
    flags.notifyAnswer = { delivery: 'sent' }
    await track(tracking, 'failure')
    const got = (await rows(tracking)).map((r) => [r.audience, r.status, r.delivery])
    expect(got).toEqual([
      ['buyer', 'sent', 'no-address'],
      ['buyer', 'sent', 'unknown'],
      ['buyer', 'sent', 'unknown'],
      ['staff', 'sent', 'unknown'],
    ])
    // No answer at all, undefined or null, means sent.
    const second = await shippedOrder()
    flags.notifyAnswer = null
    await track(second.tracking, 'out_for_delivery')
    expect((await rows(second.tracking)).map((r) => [r.status, r.delivery])).toEqual([['sent', 'sent']])
  })

  it('names the order’s site on a staff notice, and never the order on a keeper’s', () => {
    const o = payload.config.custom!.sampleKits as never
    expect(noticeTo(o, { audience: 'staff', user: null, order: 'o1', tenant: 'B' })).toEqual({ user: null, order: 'o1', staff: true, site: 'B' })
    expect(noticeTo(o, { audience: 'staff', user: null, order: 'o1', tenant: { id: 'B' } })).toEqual({ user: null, order: 'o1', staff: true, site: 'B' })
    expect(noticeTo(o, { audience: 'staff', user: null, order: 'o1' })).toEqual({ user: null, order: 'o1', staff: true, site: null })
    expect(noticeTo({ ...(o as object), scope: undefined } as never, { audience: 'staff', user: null, order: 'o1', tenant: 'B' })).toEqual({ user: null, order: 'o1', staff: true, site: null })
    expect(noticeTo(o, { audience: 'keeper', user: 'k1', order: 'o1', tenant: 'B' })).toEqual({ user: 'k1', order: null })
    // Only a keeper recorded as the order's own buyer gets the order; anything but exactly true is no.
    expect(noticeTo(o, { audience: 'keeper', user: 'b1', order: 'o1', toBuyer: true })).toEqual({ user: 'b1', order: 'o1' })
    for (const toBuyer of [false, 'true', 1, null, undefined]) expect(noticeTo(o, { audience: 'keeper', user: 'k1', order: 'o1', toBuyer })).toEqual({ user: 'k1', order: null })
    expect(noticeTo(o, { audience: 'buyer', user: 'b1', order: 'o1', tenant: 'B' })).toEqual({ user: 'b1', order: 'o1' })
  })

  it('never sends a staff notice that names no site when the plugin is scoped, and sends it without scope', async () => {
    const { id, tracking } = await shippedOrder()
    // Rows as a crash or an older version might have left them: a staff notice with no site.
    const make = async (key: string) =>
      payload.create({ collection: 'kit-notices', data: { noticeKey: key, kind: 'kit-shipment-staff', audience: 'staff', user: null, order: id, tracking, kits: [], data: { event: 'exception' }, status: 'pending', attempts: 0 } as never, overrideAccess: true, depth: 0 })
    const row = (await make(`${tracking}|no-site|staff`)) as unknown as { id: string; tenant?: unknown }
    await payload.db.updateOne({ collection: 'kit-notices', where: { id: { equals: row.id } }, data: { tenant: null } } as never)
    notices.length = 0
    await retryKitNotices(await as(null))
    expect(notices).toHaveLength(0)
    const after = (await payload.findByID({ collection: 'kit-notices', id: row.id, overrideAccess: true, depth: 0 })) as unknown as Record<string, unknown>
    expect([after.status, after.delivery]).toEqual(['gave-up', 'noSite'])
    await retryKitNotices(await as(null))
    expect(notices).toHaveLength(0)
    // Without scope, a staff notice with no site is a single-site notice, so it goes out as before.
    const o = payload.config.custom!.sampleKits as never
    expect(staffSiteMissing(o, { audience: 'staff', tenant: null })).toBe(true)
    expect(staffSiteMissing({ ...(o as object), scope: undefined } as never, { audience: 'staff', tenant: null })).toBe(false)
    expect(staffSiteMissing(o, { audience: 'staff', tenant: 'A' })).toBe(false)
    expect(staffSiteMissing(o, { audience: 'buyer', tenant: null })).toBe(false)
  })

  it('keeps the notice record to kit staff', async () => {
    for (const who of [buyer, stranger, null]) {
      const user = who ? ({ ...who, collection: 'users' } as never) : undefined
      await expect(payload.find({ collection: 'kit-notices', overrideAccess: false, user })).rejects.toThrow(/not allowed/)
    }
    expect((await payload.find({ collection: 'kit-notices', overrideAccess: false, user: { ...staffA, collection: 'users' } as never })).docs.length).toBeGreaterThan(0)
    expect((await payload.find({ collection: 'kit-notices', overrideAccess: false, user: { ...staffB, collection: 'users' } as never })).docs).toHaveLength(0)
  })
})

describe('no leaks to strangers', () => {
  it('keeps return labels, their trail and the order’s buyer to staff and the buyer', async () => {
    const id = await newOrder()
    const { codes } = await packAll(id)
    await makeOrderReturnLabels(await as(staffA), { order: id })
    for (const who of [buyer, stranger, null]) {
      const user = who ? ({ ...who, collection: 'users' } as never) : undefined
      await expect(payload.find({ collection: 'return-labels', overrideAccess: false, user })).rejects.toThrow(/not allowed/)
      await expect(payload.find({ collection: 'kit-events', overrideAccess: false, user })).rejects.toThrow(/not allowed/)
    }
    // A stranger doesn't see the kit at all; the buyer sees it, without anything of the label.
    const where = { code: { equals: codes[0] } }
    expect((await payload.find({ collection: 'kits', where, overrideAccess: false, user: { ...stranger, collection: 'users' } as never })).docs).toHaveLength(0)
    expect((await payload.find({ collection: 'kits', where, overrideAccess: false, user: { ...buyer, collection: 'users' } as never })).docs).toHaveLength(1)
  })
})

describe('one purchase per slot, even at the same moment', () => {
  const opts = () => payload.config.custom!.sampleKits as never
  const fakeLabel = (n: number) => ({ shipmentId: `shp_race_${n}`, tracking: `94007777${String(n).padStart(8, '0')}`, carrier: 'USPS', service: 'GroundAdvantage', rateCents: 500, labelUrl: '', trackerUrl: null, mode: 'test' as const })

  it('lets only one of three simultaneous purchases for a slot reach the carrier', async () => {
    const id = await newOrder()
    let calls = 0
    const buy = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return fakeLabel(calls)
    }
    const slot = { order: id, kind: 'box' as const, box: 1, site: 'A', reference: 'made-up-race' }
    const results = await Promise.allSettled([recordedPurchase(payload, opts(), slot, buy), recordedPurchase(payload, opts(), slot, buy), recordedPurchase(payload, opts(), slot, buy)])
    expect(calls).toBe(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    // The losers lost a race: busy, not "unknown".
    for (const r of results.filter((r) => r.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as KitError).code).toBe('busy')
    expect((await allRows(id)).map((l) => [l.box, l.status])).toEqual([[1, 'active']])
    // Bought and settled, the slot is free again: a reprint or replacement for that box can buy.
    expect((await recordedPurchase(payload, opts(), slot, async () => fakeLabel(99))).row.status).toBe('active')
    expect((await allRows(id)).map((l) => l.status)).toEqual(['active', 'active'])
  })

  it('backs the claim with a unique index that ignores settled rows', async () => {
    const coll = (payload.db.collections['return-labels'] as unknown as { collection: { indexes: () => Promise<{ name: string; unique?: boolean; partialFilterExpression?: unknown }[]> } }).collection
    const index = (await coll.indexes()).find((i) => i.name === 'sampleKits_slotKey_claim')
    expect(index).toMatchObject({ unique: true, partialFilterExpression: { slotKey: { $type: 'string' } } })
    // An unknown purchase keeps its claim; settling it as not bought frees the slot.
    const id = await newOrder()
    const kitId = String((await kit(c(1))).id)
    const slot = { order: id, kind: 'extra' as const, kit: kitId, kits: [kitId], site: 'A', reference: 'made-up-extra' }
    const first = await recordedPurchase(payload, opts(), slot, async () => {
      throw Object.assign(new Error('made-up unclear'), { name: 'CarrierError', code: 'MAYBE_BOUGHT', status: 0 })
    })
    expect(first.unknown).toBe(true)
    await kitErr(recordedPurchase(payload, opts(), slot, async () => fakeLabel(1)), 'labelUnknown')
    await settleUnknownLabel(await as(staffA), { label: String(first.row.id), found: null })
    expect((await recordedPurchase(payload, opts(), slot, async () => fakeLabel(2))).row.status).toBe('active')
  })
})

describe('each site’s rows stay on that site', () => {
  it('lets staff on site A read none of site B’s return labels, kits or lots through the API', async () => {
    const sys = { overrideAccess: true } as const
    await createLot(await as(staffB), { lotNumber: '818181', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    const bOrder = String((await payload.create({ collection: 'orders', data: { tenant: 'B', kitLines: [{ kind: 'count', quantity: 1 }], kitFulfillment: { status: 'to-pack' } } as never, ...sys })).id)
    const now = new Date().toISOString()
    await payload.db.create({ collection: 'return-labels', data: { tenant: 'B', order: bOrder, box: 1, kind: 'box', kits: [], status: 'active', tracking: '9400818181818181', createdAt: now, updatedAt: now } } as never)
    const read = async (who: Person, collection: 'return-labels' | 'kits' | 'kit-lots' | 'hubs' | 'box-types' | 'kit-events') =>
      (await payload.find({ collection, overrideAccess: false, user: { ...who, collection: 'users' } as never, pagination: false, depth: 0 })).docs as unknown as { tenant?: string }[]
    for (const collection of ['return-labels', 'kits', 'kit-lots', 'hubs', 'kit-events'] as const) {
      const a = await read(staffA, collection)
      expect(a.length, collection).toBeGreaterThan(0)
      expect(a.every((d) => d.tenant === 'A'), collection).toBe(true)
      const b = await read(staffB, collection)
      expect(b.length, collection).toBeGreaterThan(0)
      expect(b.every((d) => d.tenant === 'B'), collection).toBe(true)
    }
    for (const who of [adminA]) expect((await read(who, 'return-labels')).every((d) => d.tenant === 'A')).toBe(true)
    // By id too, and no change across sites.
    const bLot = (await payload.find({ collection: 'kit-lots', where: { lotNumber: { equals: '818181' } }, ...sys })).docs[0]!
    await expect(payload.findByID({ collection: 'kit-lots', id: bLot.id, overrideAccess: false, user: { ...staffA, collection: 'users' } as never })).rejects.toThrow()
    await expect(payload.update({ collection: 'kit-lots', id: bLot.id, data: { notes: 'made-up' } as never, overrideAccess: false, user: { ...staffA, collection: 'users' } as never })).rejects.toThrow()
  })
})

describe('without Shipping or payments', () => {
  let p2: Payload
  beforeAll(async () => {
    p2 = (await startPayload((o) => ({ ...o, policy: { freeRetests: 0, afterLastRetest: 'none' } }))).payload
  }, 120_000)
  afterAll(async () => {
    await p2?.destroy()
  })

  it('skips order labels in the background, refuses them for staff, and gives nothing back after a failed last try', async () => {
    const staff = await person(p2, 'A', 'staff')
    const req = () => reqAs(p2, staff as never)
    const id = String((await p2.create({ collection: 'orders', data: { tenant: 'A', customer: staff.id, kitLines: [{ kind: 'count', quantity: 1 }], kitFulfillment: { status: 'to-pack' } } as never, overrideAccess: true })).id)
    expect(await labelOrderInBackground(p2, id)).toEqual({ state: 'skipped', boxes: 0, bought: 0 })
    await kitErr(makeOrderLabels(await req(), { order: id }), 'noShipping')
    await kitErr(makeOrderReturnLabels(await req(), { order: id }), 'noShipping')
    await createLot(await req(), { lotNumber: '717171', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    await packKit(await req(), { order: id, code: '717171000001' })
    await makeSlip(await req(), { order: id })
    await markShipped(await req(), { order: id })
    const k = (await findKit(await req(), '717171000001', 'A'))!
    await recordKitEvent(await req(), k, { type: 'activated' })
    await recordKitEvent(await req(), k, { type: 'returned' })
    expect(await replaceKit(await req(), { code: '717171000001', reason: 'failed' })).toEqual({ outcome: 'none', code: '717171000001' })
    expect((await findKit(await req(), '717171000001', 'A'))!.status).toBe('failed')
  })
})

// ---------------------------------------------------------------- helpers that read back

async function packKitCodes(id: string) {
  return (await payload.find({ collection: 'kits', where: { order: { equals: id } }, sort: 'createdAt', overrideAccess: true, depth: 0, pagination: false })).docs.map((d) => (d as unknown as { code: string }).code)
}
/** Box labels for an order that already shipped (labels are bought before shipping in real use). */
async function makeOrderReturnLabelsAfterShip(id: string) {
  const o = await order(id)
  await payload.update({ collection: 'orders', id, data: { kitFulfillment: { ...o.kitFulfillment, status: 'packed' } } as never, overrideAccess: true })
  await makeOrderReturnLabels(await as(staffA), { order: id })
  await payload.update({ collection: 'orders', id, data: { kitFulfillment: { ...(await order(id)).kitFulfillment, status: 'shipped' } } as never, overrideAccess: true })
}
