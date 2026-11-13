import { resolveScan, scanPlugin, type ScanKind } from '@extantape/payload-plugin-scan'
import type { Config, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { activateKit, boxCode, createLot, makeSlip, packKit, recordKitEvent, sampleKits, scanKinds } from '../src/index.js'
import { findKit } from '../src/kits.js'
import { reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Scan links through Scan's own `resolveScan` (a devDependency, used only here), with Sample Kits' kinds registered
// at `config.custom.scanKinds`. Made-up people, kits and orders on made-up sites A and B.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, staffB: Person, buyer: Person, keeper: Person, stranger: Person
let orderId: string
const LOT = '545454'
const c = (n: number) => `${LOT}${String(n).padStart(6, '0')}`
const as = (u: Person | null) => reqAs(payload, u as never)
const scan = async (who: Person | null, kind: string, code: string) => resolveScan(payload, { kind, code, req: await as(who) })

// Sample Kits' kinds fit Scan's own type.
const typed: Record<string, ScanKind> = scanKinds()

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, adapters: { scan: true } }), { plugins: [scanPlugin({ perMinute: 1000 })] })
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  buyer = await person(payload, 'A')
  keeper = await person(payload, 'A')
  stranger = await person(payload, 'A')
  h.subjects.add({ kind: 'animal', id: 'k1', owner: String(keeper.id), name: 'Made-up tortoise' })
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 5 })
  orderId = String(
    (
      await payload.create({
        collection: 'orders',
        data: { tenant: 'A', customer: buyer.id, kitLines: [{ kind: 'count', quantity: 2 }], kitFulfillment: { status: 'to-pack', plan: { boxes: [{ box: 1, boxType: 'x', name: 'Made-up mailer', kits: 2 }] } } } as never,
        overrideAccess: true,
      })
    ).id,
  )
  await packKit(await as(staffA), { order: orderId, code: c(1) })
  await packKit(await as(staffA), { order: orderId, code: c(2) })
  // Kit 2 was given away: the keeper activated it with its slip.
  const slip = await makeSlip(await as(staffA), { order: orderId })
  await recordKitEvent(await as(staffA), (await findKit(await as(staffA), c(2), 'A'))!, { type: 'shipped' })
  await activateKit(await as(keeper), { code: c(2), secret: slip.find((s) => s.code === c(2))!.secret, subject: { kind: 'animal', id: 'k1' } })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('scan links (k: kit code)', () => {
  it('sends kit staff of the kit’s site to the record, and the buyer to activation, never with a secret', async () => {
    expect(await scan(staffA, 'k', c(1))).toEqual({ outcome: 'to', to: `/kits/scan?mode=lookup&code=${c(1)}` })
    const buyerAnswer = await scan(buyer, 'k', c(1))
    expect(buyerAnswer).toEqual({ outcome: 'to', to: `/my-tests/activate?kit=${c(1)}` })
    expect(JSON.stringify(buyerAnswer)).not.toMatch(/#|secret|s=/)
  })

  it('tells staff "Not found" for a code that doesn’t exist, here or on their site', async () => {
    expect(await scan(staffA, 'k', c(99))).toEqual({ outcome: 'notFound' })
    expect(await scan(staffA, 'k', 'not-a-code')).toEqual({ outcome: 'notFound' })
    // Staff of another site: the kit isn't on theirs, so it's "Not found", the same as no such code.
    expect(await scan(staffB, 'k', c(1))).toEqual({ outcome: 'notFound' })
    // Asked directly, staff count as staff only for their own site's codes.
    const user = { ...staffB, collection: 'users' }
    for (const kind of [typed.k!, typed.b!]) {
      expect(await kind.isStaff({ user, scope: 'A', req: await as(staffB), payload })).toBe(false)
      expect(await kind.isStaff({ user, scope: 'B', req: await as(staffB), payload })).toBe(true)
      expect(await kind.isStaff({ user, scope: null, req: await as(staffB), payload })).toBe(true)
      expect(await kind.isStaff({ user: { ...stranger, collection: 'users' }, scope: 'A', req: await as(stranger), payload })).toBe(false)
    }
  })

  it('gives everyone else the same quiet answer, whatever the reason', async () => {
    const quiet = { outcome: 'nothingHere' }
    expect(await scan(stranger, 'k', c(1))).toEqual(quiet) // a real kit, not theirs
    expect(await scan(stranger, 'k', c(99))).toEqual(quiet) // no such kit
    expect(await scan(stranger, 'k', 'not-a-code')).toEqual(quiet) // not a code
    // The keeper of a gift isn't the buyer: activation is done, and who bought it isn't theirs to see.
    expect(await scan(keeper, 'k', c(2))).toEqual(quiet)
    expect(await scan(null, 'k', c(1))).toEqual({ outcome: 'signIn' })
  })
})

describe('scan links (b: shipping box)', () => {
  it('sends staff to the order’s packing page and the buyer to their order; anyone else gets nothing', async () => {
    expect(await scan(staffA, 'b', boxCode(orderId, 1))).toEqual({ outcome: 'to', to: `/kits/packing/${orderId}` })
    expect(await scan(buyer, 'b', boxCode(orderId, 1))).toEqual({ outcome: 'to', to: `/my-tests/orders/${orderId}` })
    expect(await scan(stranger, 'b', boxCode(orderId, 1))).toEqual({ outcome: 'nothingHere' })
    expect(await scan(keeper, 'b', boxCode(orderId, 1))).toEqual({ outcome: 'nothingHere' })
    // A box the order doesn't have, an order that doesn't exist, another site's staff.
    expect(await scan(staffA, 'b', boxCode(orderId, 2))).toEqual({ outcome: 'notFound' })
    expect(await scan(staffA, 'b', boxCode('ffffffffffffffffffffffff', 1))).toEqual({ outcome: 'notFound' })
    expect(await scan(staffB, 'b', boxCode(orderId, 1))).toEqual({ outcome: 'notFound' })
    expect(await scan(stranger, 'b', boxCode(orderId, 2))).toEqual({ outcome: 'nothingHere' })
  })
})

describe('registration', () => {
  const base = () => ({ secret: 'made-up-secret-for-tests', collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'orders', fields: [] }, { slug: 'files', fields: [] }] }) as never
  const options = () => ({ access: { staff: () => true, admin: () => true, maintainer: () => true }, subjects: h.subjects, tests: [{ label: 'T', value: 't' }] })

  it('registers the kinds only when the site turns Scan on, beside any already there', () => {
    expect((sampleKits(options())(base()) as Config).custom?.scanKinds).toBeUndefined()
    const on = sampleKits({ ...options(), adapters: { scan: true } })({ ...(base() as object), custom: { scanKinds: [{ owner: 'other', kinds: {} }] } } as never) as Config
    expect((on.custom!.scanKinds as { owner: string }[]).map((r) => r.owner)).toEqual(['other', 'sample-kits'])
    expect(Object.keys(typed)).toEqual(['k', 'b'])
  })

  it('takes the site’s own paths, and refuses paths that aren’t functions', () => {
    const paths = { kit: (code: string) => `/staff/kits/${code}` }
    expect(() => sampleKits({ ...options(), adapters: { scan: { paths } } })(base())).not.toThrow()
    expect(() => sampleKits({ ...options(), adapters: { scan: { paths: { kit: '/x' } as never } } })(base())).toThrow(/adapters\.scan\.paths/)
    expect(() => sampleKits({ ...options(), adapters: { scan: 'yes' as never } })(base())).toThrow(/adapters\.scan/)
  })
})
