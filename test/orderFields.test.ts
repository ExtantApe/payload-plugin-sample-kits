import { handleEndpoints, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Who can set the fields Sample Kits adds to the site's orders, when an order is made or copied.
// The harness's orders collection lets any signed-in person create. Made-up people and orders on made-up site A.
type Person = Awaited<ReturnType<typeof person>>
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let staff: Person, admin: Person, buyer: Person, otherSiteStaff: Person
let sourceId = ''

const api = (u: Person) => ({ overrideAccess: false as const, user: { ...u, collection: 'users' } as never })
const at = '2026-11-05T12:00:00.000Z'
const lines = [{ kind: 'count', quantity: 3, test: 'test-a' }]

/** A value in every field the plugin adds under `kitFulfillment`. */
const everything = () => ({
  status: 'shipped',
  agreed: { text: 'Made-up agreed words', at },
  slipMadeAt: at,
  trackingNumbers: ['9400100000000000000099'],
  shippedAt: at,
  plan: [{ boxType: 'made-up-box', kits: 3 }],
  returnAt: 'made-up-event',
  returnAtEvent: { name: 'Made-up event', slug: 'made-up-event', starts: at, timezone: 'America/Phoenix', place: 'Exampleton', remindedAt: at, canceledToldAt: at, missedToldAt: at },
  outboundLabels: [{ box: 1, costCents: 512, reference: 'made-up-ref' }],
  labels: { state: 'made', error: 'made-up error', at, run: 'made-up-run' },
  shippedEmail: { delivery: 'failed', at },
  replaces: '0123456789abcdef01234567',
  promisedBy: at,
  revisedBy: at,
  delayNoticeFor: at,
  missedNoticeFor: at,
  preorderVote: { item: 'made-up-item', vote: 'made-up-vote', contribution: 'made-up-contribution' },
  requests: [{ kind: 'help', reasons: ['other'], details: 'Made-up details', at, outcome: 'declined', amountCents: 1, deductedCents: 1, decidedBy: staff.id, decidedAt: at, note: 'Made-up note' }],
  orderRefund: { status: 'refunded', amountCents: 100, deductedCents: 1, creditsBack: 1, refundId: 'made-up-refund', at, by: staff.id },
  returnShippingCents: 500,
  shippingRefund: { status: 'refunded', amountCents: 100, refundId: 'made-up-refund', at, by: staff.id },
})

/** What's really stored: no nulls, empty lists or empty groups. */
const filled = (v: unknown): unknown => {
  if (v === null || v === undefined) return undefined
  if (Array.isArray(v)) return v.length ? v.map(filled) : undefined
  if (typeof v !== 'object' || v instanceof Date) return v
  const kept = Object.entries(v).map(([k, x]) => [k, filled(x)] as const).filter(([, x]) => x !== undefined)
  return kept.length ? Object.fromEntries(kept) : undefined
}
const stored = async (id: unknown) => (await payload.findByID({ collection: 'orders', id: String(id), depth: 0 })) as unknown as Doc
const untouched = async (id: unknown) => {
  const doc = await stored(id)
  expect(filled(doc.kitLines)).toBeUndefined()
  expect(filled(doc.kitFulfillment)).toEqual({ status: 'to-pack' })
  return doc
}

const tokens = new Map<string, string>()
async function post(u: Person, path: string, body: Doc): Promise<{ status: number; body: Doc }> {
  if (!tokens.has(u.id)) tokens.set(u.id, (await payload.login({ collection: 'users', data: { email: u.email, password: u.password } })).token!)
  const request = new Request(`http://localhost/api${path}`, { method: 'POST', headers: { Authorization: `JWT ${tokens.get(u.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: h.key, request } as never)
  return { status: res.status, body: (await res.json()) as Doc }
}

beforeAll(async () => {
  h = await startPayload()
  payload = h.payload
  staff = await person(payload, 'A', 'staff')
  admin = await person(payload, 'A', 'admin')
  buyer = await person(payload, 'A')
  otherSiteStaff = await person(payload, 'A')
  sourceId = String((await payload.create({ collection: 'orders', data: { tenant: 'A', ref: 'made-up-source', customer: buyer.id, kitLines: lines, kitFulfillment: everything() } as never })).id)
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('server code (the Local API’s default, overrideAccess: true)', () => {
  it('records every field on create, and copies them on duplicate', async () => {
    const source = await stored(sourceId)
    expect(source.kitLines).toMatchObject(lines)
    expect(Object.keys(filled(source.kitFulfillment) as object).sort()).toEqual(Object.keys(everything()).sort())
    expect(source.kitFulfillment.agreed.text).toBe('Made-up agreed words')
    const copy = await payload.duplicate({ collection: 'orders', id: sourceId } as never)
    expect((await stored((copy as Doc).id)).kitFulfillment.agreed.text).toBe('Made-up agreed words')
  })
})

describe('someone who isn’t kit staff', () => {
  it('creates an order that starts with no kit lines and only the default status (Local API)', async () => {
    const made = (await payload.create({ collection: 'orders', data: { tenant: 'A', ref: 'made-up-new', customer: buyer.id, kitLines: lines, kitFulfillment: everything() } as never, ...api(buyer) })) as unknown as Doc
    expect((await untouched(made.id)).ref).toBe('made-up-new')
  })

  it('creates an order that starts with no kit lines and only the default status (REST)', async () => {
    const res = await post(buyer, '/orders', { tenant: 'A', ref: 'made-up-rest', customer: buyer.id, kitLines: lines, kitFulfillment: everything() })
    expect(res.status).toBe(201)
    expect((await untouched(res.body.doc.id)).ref).toBe('made-up-rest')
  })

  for (const [what, data] of [['as it is', () => ({})], ['with values of their own', () => ({ kitLines: lines, kitFulfillment: everything() })]] as const) {
    it(`duplicates an order ${what}: the kit fields aren’t carried over (Local API)`, async () => {
      const copy = (await payload.duplicate({ collection: 'orders', id: sourceId, data: data() as never, ...api(buyer) } as never)) as unknown as Doc
      expect(copy.id).not.toBe(sourceId)
      // The site's own fields still copy.
      expect((await untouched(copy.id)).ref).toBe('made-up-source')
    })

    it(`duplicates an order ${what}: the kit fields aren’t carried over (REST)`, async () => {
      const res = await post(buyer, `/orders/${sourceId}/duplicate`, data())
      expect(res.status).toBeLessThan(300)
      expect(res.body.doc.id).not.toBe(sourceId)
      await untouched(res.body.doc.id)
    })
  }

  it('includes a signed-in person with no kit role, whoever they are on the order', async () => {
    const made = (await payload.create({ collection: 'orders', data: { tenant: 'A', customer: buyer.id, kitLines: lines, kitFulfillment: everything() } as never, ...api(otherSiteStaff) })) as unknown as Doc
    await untouched(made.id)
  })
})

/** Written by the plugin or by server code only: kit staff don't set these through the API. */
const SERVER_ONLY = ['agreed', 'returnAt', 'returnAtEvent', 'outboundLabels', 'labels', 'shippedEmail', 'replaces', 'promisedBy', 'preorderVote', 'requests', 'orderRefund', 'returnShippingCents', 'shippingRefund']
const STAFF_SET = ['status', 'slipMadeAt', 'trackingNumbers', 'shippedAt', 'plan', 'revisedBy', 'delayNoticeFor', 'missedNoticeFor']

describe('kit staff and admins', () => {
  it('between them, the two lists name every field under kitFulfillment', () => {
    expect([...SERVER_ONLY, ...STAFF_SET].sort()).toEqual(Object.keys(everything()).sort())
  })

  for (const role of ['staff', 'admin'] as const) {
    it(`create an order with its kit lines and fulfillment, without the agreed words or other server records (${role})`, async () => {
      const who = role === 'staff' ? staff : admin
      const made = (await payload.create({ collection: 'orders', data: { tenant: 'A', customer: buyer.id, kitLines: lines, kitFulfillment: everything() } as never, ...api(who) })) as unknown as Doc
      const doc = await stored(made.id)
      expect(doc.kitLines).toMatchObject(lines)
      expect(Object.keys(filled(doc.kitFulfillment) as object).sort()).toEqual([...STAFF_SET].sort())
      expect(doc.kitFulfillment.status).toBe('shipped')
    })
  }

  it('duplicate an order with its kit lines and fulfillment, without the agreed words or other server records', async () => {
    const copy = (await payload.duplicate({ collection: 'orders', id: sourceId, ...api(staff) } as never)) as unknown as Doc
    const doc = await stored(copy.id)
    expect(doc.kitLines).toMatchObject(lines)
    expect(Object.keys(filled(doc.kitFulfillment) as object).sort()).toEqual([...STAFF_SET].sort())
  })

  it('can’t add or change the agreed words afterwards', async () => {
    const made = (await payload.create({ collection: 'orders', data: { tenant: 'A', customer: buyer.id, kitLines: lines } as never })) as unknown as Doc
    await payload.update({ collection: 'orders', id: made.id, data: { kitFulfillment: { status: 'to-pack', agreed: { text: 'Made-up words', at } } } as never, ...api(staff) })
    expect(filled((await stored(made.id)).kitFulfillment.agreed)).toBeUndefined()
  })
})
