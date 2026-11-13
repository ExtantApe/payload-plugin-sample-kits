import { handleEndpoints, type CollectionConfig, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KIT_COLLECTION_SLUGS } from '../src/index.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Who can read what on a kit through the API (security read of fee0a58, 2026-11-10): a gift's buyer and its keeper
// never see each other. Made-up people, kits and orders on made-up site A only.
type Person = Awaited<ReturnType<typeof person>>
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let staff: Person, giftBuyer: Person, keeper: Person, ownBuyer: Person, stranger: Person
let gift = '', own = '', orderId = ''

const BUYER_SIDE = ['buyer', 'order', 'orderLine', 'identifierLabel', 'suggestedKind', 'suggestedId', 'secretIssuedAt']
const KEEPER_SIDE = ['activatedBy', 'activatedAt', 'sampledAt', 'subjectKind', 'subjectId']
const BOTH = ['code', 'status', 'lot', 'test', 'tenant']

/** An override that tries to open every field to everyone: the plugin's field rules must survive it. */
const openEverything = (fields: Field[]): Field[] =>
  fields.map((f) => {
    const x = f as Field & { fields?: Field[]; name?: string }
    if (!x.name && x.fields) return { ...x, fields: openEverything(x.fields) } as Field
    return x.name ? ({ ...x, access: { ...((x as { access?: object }).access ?? {}), read: () => true } } as Field) : x
  })

const api = (u: Person | null) => ({ overrideAccess: false as const, user: u ? ({ ...u, collection: 'users' } as never) : undefined })
const read = async (u: Person | null, id: string, depth: number) => (await payload.findByID({ collection: 'kits', id, depth, ...api(u) })) as unknown as Doc
const tokens = new Map<string, string>()
async function rest(u: Person | null, path: string): Promise<{ status: number; body: Doc }> {
  const headers: Record<string, string> = {}
  if (u) {
    if (!tokens.has(u.id)) tokens.set(u.id, (await payload.login({ collection: 'users', data: { email: u.email, password: u.password } })).token!)
    headers.Authorization = `JWT ${tokens.get(u.id)}`
  }
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: h.key, request: new Request(`http://localhost/api${path}`, { headers }) } as never)
  return { status: res.status, body: (await res.json()) as Doc }
}
const has = (doc: Doc, names: string[]) => names.filter((n) => doc[n] !== undefined && doc[n] !== null)
const lacks = (doc: Doc, names: string[]) => names.filter((n) => doc[n] === undefined)

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, overrides: { kits: (c: CollectionConfig) => ({ ...c, fields: openEverything(c.fields) }) } }))
  payload = h.payload
  staff = await person(payload, 'A', 'staff')
  giftBuyer = await person(payload, 'A')
  keeper = await person(payload, 'A')
  ownBuyer = await person(payload, 'A')
  stranger = await person(payload, 'A')
  const lot = await payload.create({ collection: 'kit-lots', data: { tenant: 'A', lotNumber: '919191', expiresOn: '2099-01-01' } as never })
  orderId = String((await payload.create({ collection: 'orders', data: { tenant: 'A', customer: giftBuyer.id, kitLines: [{ kind: 'animal', quantity: 1 }], kitFulfillment: { status: 'shipped', trackingNumbers: ['9400100000000000000099'], outboundLabels: [{ box: 1, costCents: 512, reference: 'made-up-ref' }], labels: { state: 'made', run: 'made-up-run' }, delayNoticeFor: '2026-11-01', requests: [{ kind: 'help', reasons: ['other'], at: '2026-11-01', outcome: 'declined', decidedBy: staff.id, note: 'Made-up note' }], orderRefund: { status: 'refunded', amountCents: 100, by: staff.id } } } as never })).id)
  const at = '2026-11-05T00:00:00.000Z'
  const kitData = (code: string, buyer: Person, by: Person) => ({
    tenant: 'A', code, lot: lot.id, buyer: buyer.id, order: orderId, orderLine: 0, identifierLabel: 'Made-up Boa Pip', secretIssuedAt: at,
    suggestedKind: 'animal', suggestedId: 'bought-for-1', activatedBy: by.id, activatedAt: at, sampledAt: at, subjectKind: 'animal', subjectId: 'sampled-1', notes: 'Made-up staff note',
  })
  gift = String((await payload.create({ collection: 'kits', data: kitData('919191000001', giftBuyer, keeper) as never })).id)
  own = String((await payload.create({ collection: 'kits', data: kitData('919191000002', ownBuyer, ownBuyer) as never })).id)
  const now = new Date().toISOString()
  await payload.db.create({ collection: 'kit-events', data: { tenant: 'A', kit: gift, type: 'activated', at: now, actor: keeper.id, source: 'customer', createdAt: now, updatedAt: now } } as never)
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('a gift’s buyer and its keeper, through the Local API (overrideAccess: false)', () => {
  for (const depth of [0, 1]) {
    it(`the buyer sees what they bought and for whom, never the keeper or what was sampled (depth ${depth})`, async () => {
      const doc = await read(giftBuyer, gift, depth)
      expect(has(doc, BUYER_SIDE)).toEqual(BUYER_SIDE)
      expect(lacks(doc, KEEPER_SIDE)).toEqual(KEEPER_SIDE)
      expect(doc.notes).toBeUndefined()
      expect(has(doc, BOTH)).toEqual(BOTH)
      // The keeper's user record never comes through, at any depth, under any name.
      expect(JSON.stringify(doc)).not.toContain(keeper.email)
      expect(JSON.stringify(doc)).not.toContain(String(keeper.id))
      // The custody trail is staff's: the join gives the buyer nothing.
      expect(doc.events?.docs ?? []).toEqual([])
    })

    it(`the keeper sees their activation and sample, never the buyer, the order or what it was bought for (depth ${depth})`, async () => {
      const doc = await read(keeper, gift, depth)
      expect(has(doc, KEEPER_SIDE)).toEqual(KEEPER_SIDE)
      expect(lacks(doc, BUYER_SIDE)).toEqual(BUYER_SIDE)
      expect(doc.notes).toBeUndefined()
      if (depth === 1) expect(doc.activatedBy).toMatchObject({ id: keeper.id })
      expect(JSON.stringify(doc)).not.toContain(giftBuyer.email)
      expect(JSON.stringify(doc)).not.toContain(String(giftBuyer.id))
      expect(JSON.stringify(doc)).not.toContain('Made-up Boa Pip')
      expect(doc.events?.docs ?? []).toEqual([])
    })

    it(`whoever both bought and activated a kit sees both sides, never staff notes (depth ${depth})`, async () => {
      const doc = await read(ownBuyer, own, depth)
      expect(has(doc, [...BUYER_SIDE, ...KEEPER_SIDE])).toEqual([...BUYER_SIDE, ...KEEPER_SIDE])
      expect(doc.notes).toBeUndefined()
    })

    it(`kit staff see everything, notes included (depth ${depth})`, async () => {
      const doc = await read(staff, gift, depth)
      expect(has(doc, [...BUYER_SIDE, ...KEEPER_SIDE, 'notes'])).toEqual([...BUYER_SIDE, ...KEEPER_SIDE, 'notes'])
      if (depth === 1) expect(doc.buyer).toMatchObject({ id: giftBuyer.id })
    })

    it(`a stranger gets nothing (depth ${depth})`, async () => {
      await expect(read(stranger, gift, depth)).rejects.toThrow()
      expect((await payload.find({ collection: 'kits', depth, ...api(stranger) })).docs).toEqual([])
      await expect(read(null, gift, depth)).rejects.toThrow()
    })
  }

  it('lists hold the same rules', async () => {
    const mine = (await payload.find({ collection: 'kits', depth: 1, ...api(giftBuyer) })).docs as unknown as Doc[]
    expect(mine.map((d) => d.code)).toEqual(['919191000001'])
    expect(lacks(mine[0]!, KEEPER_SIDE)).toEqual(KEEPER_SIDE)
    const kept = (await payload.find({ collection: 'kits', depth: 1, ...api(keeper) })).docs as unknown as Doc[]
    expect(lacks(kept[0]!, BUYER_SIDE)).toEqual(BUYER_SIDE)
  })

  it('refuses a query on a field the person can’t read, so nobody can probe for the other side', async () => {
    await expect(payload.find({ collection: 'kits', where: { activatedBy: { equals: keeper.id } }, ...api(giftBuyer) })).rejects.toThrow(/activatedBy/)
    await expect(payload.find({ collection: 'kits', where: { subjectId: { equals: 'sampled-1' } }, ...api(giftBuyer) })).rejects.toThrow(/subjectId/)
    await expect(payload.find({ collection: 'kits', where: { buyer: { equals: giftBuyer.id } }, ...api(keeper) })).rejects.toThrow(/buyer/)
    await expect(payload.find({ collection: 'kits', where: { notes: { exists: true } }, ...api(keeper) })).rejects.toThrow(/notes/)
    expect((await payload.find({ collection: 'kits', where: { notes: { exists: true } }, ...api(staff) })).docs.length).toBe(2)
  })
})

describe('the same through REST', () => {
  for (const depth of [0, 1]) {
    it(`keeps the buyer and the keeper apart, and gives a stranger nothing (depth ${depth})`, async () => {
      const b = await rest(giftBuyer, `/kits/${gift}?depth=${depth}`)
      expect(b.status).toBe(200)
      expect(lacks(b.body, KEEPER_SIDE)).toEqual(KEEPER_SIDE)
      expect(has(b.body, BUYER_SIDE)).toEqual(BUYER_SIDE)
      expect(JSON.stringify(b.body)).not.toContain(keeper.email)
      const k = await rest(keeper, `/kits/${gift}?depth=${depth}`)
      expect(k.status).toBe(200)
      expect(lacks(k.body, BUYER_SIDE)).toEqual(BUYER_SIDE)
      expect(has(k.body, KEEPER_SIDE)).toEqual(KEEPER_SIDE)
      expect(JSON.stringify(k.body)).not.toContain(giftBuyer.email)
      for (const body of [b.body, k.body]) expect(body.notes).toBeUndefined()
      const s = await rest(staff, `/kits/${gift}?depth=${depth}`)
      expect(s.body.notes).toBe('Made-up staff note')
      const list = await rest(giftBuyer, `/kits?depth=${depth}`)
      expect(list.body.docs.map((d: Doc) => d.code)).toEqual(['919191000001'])
      expect(lacks(list.body.docs[0], KEEPER_SIDE)).toEqual(KEEPER_SIDE)
      expect((await rest(stranger, `/kits/${gift}?depth=${depth}`)).status).toBeGreaterThanOrEqual(400)
      expect((await rest(stranger, `/kits?depth=${depth}`)).body.docs).toEqual([])
      expect((await rest(null, `/kits/${gift}?depth=${depth}`)).status).toBeGreaterThanOrEqual(400)
    })
  }

  it('refuses a probing query', async () => {
    expect((await rest(giftBuyer, `/kits?where[activatedBy][equals]=${keeper.id}`)).status).toBe(400)
    expect((await rest(keeper, `/kits?where[buyer][equals]=${giftBuyer.id}`)).status).toBe(400)
  })
})

describe('the other collections', () => {
  it('give people who aren’t kit staff nothing to read in any plugin collection but kits', async () => {
    for (const slug of KIT_COLLECTION_SLUGS.filter((s) => s !== 'kits'))
      for (const who of [giftBuyer, keeper, stranger]) await expect(payload.find({ collection: slug, depth: 1, ...api(who) }), `${slug}`).rejects.toThrow(/not allowed/)
    expect((await payload.find({ collection: 'kit-events', ...api(staff) })).docs.length).toBe(1)
  })

  it('on the site’s orders: a buyer can’t change kit lines or fulfillment, and never reads purchase records or who decided', async () => {
    const before = (await payload.findByID({ collection: 'orders', id: orderId, depth: 0 })) as unknown as Doc
    await payload.update({ collection: 'orders', id: orderId, data: { kitLines: [{ kind: 'count', quantity: 99 }], kitFulfillment: { status: 'to-pack', trackingNumbers: [] } } as never, ...api(giftBuyer) })
    const after = (await payload.findByID({ collection: 'orders', id: orderId, depth: 0 })) as unknown as Doc
    expect(after.kitLines).toEqual(before.kitLines)
    expect(after.kitFulfillment.status).toBe('shipped')
    expect(after.kitFulfillment.trackingNumbers).toEqual(['9400100000000000000099'])
    for (const depth of [0, 1]) {
      const seen = (await payload.findByID({ collection: 'orders', id: orderId, depth, ...api(giftBuyer) })) as unknown as Doc
      expect(seen.kitFulfillment).toMatchObject({ status: 'shipped', trackingNumbers: ['9400100000000000000099'] })
      // Payload may leave an empty list in place of a hidden array: what matters is that nothing in it comes through.
      expect(seen.kitFulfillment.outboundLabels ?? []).toEqual([])
      for (const hidden of ['labels', 'delayNoticeFor']) expect(seen.kitFulfillment[hidden], hidden).toBeUndefined()
      // Match the label's cost as a JSON number, never as bare digits: "512" turns up by chance inside random
      // session ids, ObjectIds and timestamp milliseconds, which made this check fail about one run in 30.
      expect(JSON.stringify(seen)).not.toMatch(/made-up-ref|made-up-run|"costCents"|[:,[]512[,\]}]/)
      expect(seen.kitFulfillment.requests[0].decidedBy).toBeUndefined()
      expect(seen.kitFulfillment.orderRefund.by).toBeUndefined()
      expect(seen.kitFulfillment.orderRefund.amountCents).toBe(100)
      expect(JSON.stringify(seen)).not.toContain(staff.email)
    }
    const r = await rest(giftBuyer, `/orders/${orderId}?depth=1`)
    expect(r.body.kitFulfillment.outboundLabels ?? []).toEqual([])
    // Kit staff change and read all of it.
    await payload.update({ collection: 'orders', id: orderId, data: { kitFulfillment: { ...after.kitFulfillment, revisedBy: '2026-12-01' } } as never, ...api(staff) })
    const s = (await payload.findByID({ collection: 'orders', id: orderId, depth: 0, ...api(staff) })) as unknown as Doc
    expect(s.kitFulfillment.revisedBy).toMatch(/^2026-12-01/)
    expect(s.kitFulfillment.outboundLabels[0]).toMatchObject({ costCents: 512 })
    expect(s.kitFulfillment.requests[0].decidedBy).toBe(staff.id)
  })
})
