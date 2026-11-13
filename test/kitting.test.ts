import type { CollectionConfig, Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { assignKitUnits, createLot, findKit, KitError, kittingOnBuild, makeSlip, markShipped, packKit, recallLot, releasePreorders, requestHelp, sampleKits, unpackKit } from '../src/index.js'
import { checkOptions } from '../src/plugin.js'
import { fakeKitting, fakePayments, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Kitting's units through `adapters.kitting`, with a stand-in that has Kitting's shapes and refusal codes and, like
// Kitting, joins the transaction of the `req` it's given. Made-up people, lots and orders on made-up sites A and B.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, staffB: Person, buyer: Person
const kitting = fakeKitting()
const pay = fakePayments()
const LOT = '515151'
const LOT2 = '525252'
const c = (n: number, lot = LOT) => `${lot}${String(n).padStart(6, '0')}`

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
const kit = async (code: string) => (await findKit(await as(staffA), code, 'A'))!
const unit = (code: string) => kitting.unit(payload, code)
const order = async (id: string) => (await payload.findByID({ collection: 'orders', id, overrideAccess: true, depth: 0 })) as unknown as Record<string, any>
const unitsOf = async (id: string) => (await payload.find({ collection: 'assembled-units' as never, where: { assignedTo: { equals: `Order ${id}` } } as never, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as { externalId: string; status: string }[]
let next = 0
async function newOrder(quantity: number, over: Record<string, unknown> = {}) {
  const doc = await payload.create({
    collection: 'orders',
    data: { ref: `made-up ${++next}`, tenant: 'A', customer: buyer.id, amount: 30000, kitLines: [{ kind: 'count', quantity }], kitFulfillment: { status: 'to-pack' }, ...over } as never,
    overrideAccess: true,
  })
  return String(doc.id)
}
let serial = 0
/** Fresh codes in the lot, with ready units for them. */
async function stocked(n: number) {
  const codes = Array.from({ length: n }, () => c(++serial))
  await kitting.build(payload, codes, 'A')
  return codes
}

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, payments: pay.payments, adapters: { kitting: kitting.adapter } }), { collections: [kitting.collection as unknown as CollectionConfig] })
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  buyer = await person(payload, 'A')
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 80 })
  await createLot(await as(staffA), { lotNumber: LOT2, expiresOn: '2099-01-01' })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

beforeEach(async () => {
  kitting.reset()
  // Each case starts with no spare ready units, so "ready first" picks only the units it made.
  await payload.update({ collection: 'assembled-units' as never, where: { status: { equals: 'ready' } } as never, data: { status: 'void' } as never, overrideAccess: true })
})

describe('Kitting units', () => {
  it('makes each built kit an in-stock kit in the build’s transaction, and refuses what it can’t stock', async () => {
    const onBuild = kittingOnBuild({ recipeKey: 'sample-kit' })
    const built = (code: string, scope: string | null = 'A') => ({ externalId: code, scope })
    const recipe = { key: 'sample-kit' }
    await onBuild({ payload, req: await as(staffA), unit: built(c(1, LOT2)), recipe })
    expect(await kit(c(1, LOT2))).toMatchObject({ status: 'in-stock', tenant: 'A' })
    // Already in stock, no lot, no staff, another site's unit: each refuses, so the build rolls back.
    await kitErr(onBuild({ payload, req: await as(staffA), unit: built(c(1, LOT2)), recipe }), 'alreadyInStock')
    await kitErr(onBuild({ payload, req: await as(staffA), unit: built('999999000001'), recipe }), 'unknownLot')
    await kitErr(onBuild({ payload, req: await as(buyer), unit: built(c(2, LOT2)), recipe }), 'notStaff')
    await kitErr(onBuild({ payload, req: await as(staffA), unit: built(c(2, LOT2), 'B'), recipe }), 'wrongSite')
    await kitErr(onBuild({ payload, req: await as(staffB), unit: built(c(2, LOT2), 'A'), recipe }), 'wrongSite')
    await kitErr(onBuild({ payload, req: await as(staffA), unit: built(c(2, LOT2), null), recipe }), 'wrongSite')
    expect(await findKit(await as(staffA), c(2, LOT2), 'A')).toBeNull()
    // Other recipes aren't kits.
    await onBuild({ payload, req: await as(staffA), unit: built(c(3, LOT2)), recipe: { key: 'not-a-kit' } })
    expect(await findKit(await as(staffA), c(3, LOT2), 'A')).toBeNull()
  })

  it('swaps the scanned kit’s unit in at packing, in the same transaction', async () => {
    const [a, b, spare] = await stocked(3)
    const id = await newOrder(2)
    await assignKitUnits(payload, id)
    expect((await unitsOf(id)).map((u) => u.externalId).sort()).toEqual([a, b].sort())
    // The spare wasn't one of the two: it takes one's place, and that one goes back to ready.
    await packKit(await as(staffA), { order: id, code: spare! })
    expect(await unit(spare!)).toMatchObject({ status: 'assigned', assignedTo: `Order ${id}` })
    expect((await unitsOf(id)).filter((u) => u.status === 'assigned')).toHaveLength(2)
    expect(kitting.calls.filter((x) => x.call === 'swapUnit').every((x) => x.joined)).toBe(true)
    // Kitting's held emails go out after the commit.
    expect(kitting.alerts.sent).toBeGreaterThan(0)
  })

  it('packs a kit received before Kitting with a note, and gives an order with nothing reserved its units at packing', async () => {
    const id = await newOrder(2)
    // No unit for this code: packs as before, noted.
    const old = c(++serial)
    await packKit(await as(staffA), { order: id, code: old })
    const [ready] = await stocked(1)
    // Nothing reserved for the order yet: it's given its units now, and the swap is tried once more.
    await packKit(await as(staffA), { order: id, code: ready! })
    const notes = (await payload.find({ collection: 'kit-events', where: { and: [{ order: { equals: id } }, { type: { equals: 'packed' } }] }, sort: 'createdAt', depth: 0, overrideAccess: true })).docs.map((e) => (e.details as { kitting?: string }).kitting)
    expect(notes).toEqual(['no unit: received before Kitting', 'the order had no units reserved; given them at packing'])
    expect(await unit(ready!)).toMatchObject({ status: 'assigned', assignedTo: `Order ${id}` })
  })

  it('refuses packing in Kitting’s words when Kitting refuses, and leaves the kit and every unit as they were', async () => {
    const [a] = await stocked(1)
    const other = await newOrder(1)
    await assignKitUnits(payload, other)
    const id = await newOrder(1)
    // Kept for another order: refused, the kit stays in stock.
    const e = await kitErr(packKit(await as(staffA), { order: id, code: a! }), 'kitting')
    expect(e.vars).toMatchObject({ kittingCode: 'unitStatus' })
    expect(e.message).toMatch(/^Kitting: .*kept for Order/)
    expect(await kit(a!)).toMatchObject({ status: 'in-stock' })
    expect((await kit(a!)).order ?? null).toBeNull()
    expect(await unit(a!)).toMatchObject({ status: 'assigned', assignedTo: `Order ${other}` })
    // A crash (no code) halfway: the same, nothing written on either side.
    const [b] = await stocked(1)
    const third = await newOrder(1)
    await assignKitUnits(payload, third)
    kitting.failNext('swapUnit')
    await expect(packKit(await as(staffA), { order: third, code: b! })).rejects.toThrow(/made-up Kitting crash/)
    expect(await kit(b!)).toMatchObject({ status: 'in-stock' })
    expect((await kit(b!)).order ?? null).toBeNull()
    const events = await payload.count({ collection: 'kit-events', where: { and: [{ order: { equals: third } }, { type: { equals: 'packed' } }] }, overrideAccess: true })
    expect(events.totalDocs).toBe(0)
  })

  it('gives a unit back on unpacking and tops the order up again; a refusal there unpacks nothing', async () => {
    const [a, b, spare] = await stocked(3)
    const id = await newOrder(2)
    await assignKitUnits(payload, id)
    await packKit(await as(staffA), { order: id, code: a! })
    kitting.failNext('release', 'unitStatus')
    await kitErr(unpackKit(await as(staffA), { order: id, code: a! }), 'kitting')
    expect(await kit(a!)).toMatchObject({ status: 'packed', order: id })
    await unpackKit(await as(staffA), { order: id, code: a! })
    expect(await kit(a!)).toMatchObject({ status: 'in-stock' })
    expect((await kit(a!)).order ?? null).toBeNull()
    // Topped up: the order still holds one unit per kit it needs.
    expect((await unitsOf(id)).filter((u) => u.status === 'assigned')).toHaveLength(2)
    void b
    void spare
  })

  it('ships the units of the kits in the box, gives back one whose kit isn’t there, and rolls the shipping back if Kitting refuses', async () => {
    const [a, b] = await stocked(2)
    const id = await newOrder(2)
    await assignKitUnits(payload, id)
    await packKit(await as(staffA), { order: id, code: a! })
    // The second kit was received before Kitting: no unit. The other assigned unit stays on the shelf.
    const old = c(++serial)
    await packKit(await as(staffA), { order: id, code: old })
    await makeSlip(await as(staffA), { order: id })
    kitting.failNext('shipUnits', 'unitStatus')
    await kitErr(markShipped(await as(staffA), { order: id, tracking: ['9400100000000000000011'] }), 'kitting')
    expect(await kit(a!)).toMatchObject({ status: 'packed' })
    expect((await order(id)).kitFulfillment.status).not.toBe('shipped')
    await markShipped(await as(staffA), { order: id, tracking: ['9400100000000000000011'] })
    expect(await kit(a!)).toMatchObject({ status: 'shipped' })
    expect(await unit(a!)).toMatchObject({ status: 'shipped' })
    expect(await unit(b!)).toMatchObject({ status: 'ready', assignedTo: null })
  })

  it('voids a recalled lot’s units in the recall’s transaction, tops up the orders it reopens, and refuses the recall if Kitting fails', async () => {
    const lot = '535353'
    await createLot(await as(staffA), { lotNumber: lot, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 3 })
    const codes = [1, 2, 3].map((n) => c(n, lot))
    await kitting.build(payload, codes, 'A')
    const id = await newOrder(2)
    await assignKitUnits(payload, id)
    await packKit(await as(staffA), { order: id, code: codes[0]! })
    // Kitting fails: the recall is refused, the lot isn't recalled and the kit stays packed.
    kitting.failNext('voidUnit')
    await expect(recallLot(await as(staffA), { lotNumber: lot, reason: 'Made-up seal fault' })).rejects.toThrow(/made-up Kitting crash/)
    expect(((await payload.find({ collection: 'kit-lots', where: { lotNumber: { equals: lot } }, overrideAccess: true })).docs[0] as { recalled?: boolean }).recalled).toBe(false)
    expect(await kit(codes[0]!)).toMatchObject({ status: 'packed' })
    await recallLot(await as(staffA), { lotNumber: lot, reason: 'Made-up seal fault' })
    for (const code of codes) expect((await unit(code))!.status).toBe('void')
    expect(await kit(codes[0]!)).toMatchObject({ status: 'recalled' })
    expect((await kit(codes[0]!)).order ?? null).toBeNull()
    // The reopened order is made whole again: units held plus builds waiting cover what it needs.
    const held = (await unitsOf(id)).filter((u) => u.status === 'assigned').length
    expect(held + (kitting.queued.get(`Order ${id}`) ?? 0)).toBe(2)
  })

  it('gives back everything a canceled order holds before any money moves; a Kitting refusal cancels nothing', async () => {
    await stocked(2)
    const id = await newOrder(2)
    await assignKitUnits(payload, id)
    kitting.failNext('release', 'scope')
    await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }), 'kitting')
    expect(pay.refunds.filter((r) => r.key.includes(id))).toHaveLength(0)
    expect((await order(id)).kitFulfillment.status).toBe('to-pack')
    expect(await requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] })).toMatchObject({ outcome: 'refunded' })
    expect((await unitsOf(id)).filter((u) => u.status === 'assigned')).toHaveLength(0)
  })

  it('gives released pre-orders their units after the commit, and never fails the release', async () => {
    await stocked(1)
    const id = await newOrder(1, { kitFulfillment: { status: 'pre-order' } })
    kitting.failNext('assignUnits')
    expect(await releasePreorders(await as(staffA))).toBeGreaterThanOrEqual(1)
    expect((await order(id)).kitFulfillment.status).toBe('to-pack')
    expect(await unitsOf(id)).toHaveLength(0)
    // Packing assigns late when the release's assignment didn't run.
    await assignKitUnits(payload, id)
    expect((await unitsOf(id)).filter((u) => u.status === 'assigned')).toHaveLength(1)
  })

  it('refuses before writing anything when the database can’t share a transaction with Kitting', async () => {
    const [a] = await stocked(1)
    const id = await newOrder(1)
    const db = payload.db as unknown as { beginTransaction: () => Promise<unknown> }
    const real = db.beginTransaction
    db.beginTransaction = async () => null
    try {
      await kitErr(packKit(await as(staffA), { order: id, code: a! }), 'kittingNeedsTransaction')
      await kitErr(unpackKit(await as(staffA), { order: id, code: a! }), 'kittingNeedsTransaction')
      await kitErr(markShipped(await as(staffA), { order: id }), 'kittingNeedsTransaction')
      await kitErr(requestHelp(await as(buyer), { order: id, reasons: ['changed-mind'] }), 'kittingNeedsTransaction')
    } finally {
      db.beginTransaction = real
    }
    expect(await kit(a!)).toMatchObject({ status: 'in-stock' })
    expect((await kit(a!)).order ?? null).toBeNull()
    expect((await order(id)).kitFulfillment.orderRefund?.status ?? null).toBeNull()
    expect(kitting.calls).toHaveLength(0)
  })

  it('refuses an incomplete Kitting adapter, a Wizards adapter without answersFor, and a non-boolean reason switch at start-up', () => {
    const config = { secret: 'made-up-secret-for-tests', collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'orders', fields: [] }, { slug: 'files', fields: [] }] } as never
    const base = { access: { staff: () => true, admin: () => true, maintainer: () => true }, subjects: h.subjects, tests: [{ label: 'T', value: 't' }] }
    const { swapUnit: _s, ...noSwap } = kitting.adapter
    expect(() => checkOptions({ ...base, adapters: { kitting: noSwap as never } }, config)).toThrow(/adapters\.kitting\.swapUnit/)
    expect(() => checkOptions({ ...base, adapters: { kitting: { ...kitting.adapter, recipe: {} as never } } }, config)).toThrow(/adapters\.kitting\.recipe/)
    expect(() => checkOptions({ ...base, adapters: { kitting: kitting.adapter } }, config)).not.toThrow()
    // The other phase 4a options are checked the same way.
    expect(() => checkOptions({ ...base, adapters: { wizards: {} as never } }, config)).toThrow(/adapters\.wizards\.answersFor/)
    expect(() => checkOptions({ ...base, orderHelp: { reasons: { damaged: 'yes' as never } } }, config)).toThrow(/orderHelp/)
    expect(() => checkOptions({ ...base, orderHelp: { reasons: { damaged: true } } }, config)).not.toThrow()
    void sampleKits
  })
})
