import type { Config, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLot, findKit, KIT_COLLECTION_SLUGS, KitError, rateStudy, removeKitRecords, seedKitStory, studyReport, suggestTiers } from '../src/index.js'
import { kitCollections } from '../src/collections.js'
import { AFTER_COMMIT_KEY, carriable, carry, EVENT_WRITE, EVENT_WRITE_KEY, freshReq, GUARD_CONTEXT_KEYS, optionsOf, PLUGIN_CONTEXT_KEYS, SKIP_LABEL_CANCEL, sysReq, topLevelFields } from '../src/internal.js'
import { checkOptions } from '../src/plugin.js'
import { fakeShipping, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// The seed story and its removal, and the rate study, all with made-up people, places and prices. The `seeded` field
// stands in for the seed plugin's marker, added to every collection a seed may write, as the seed plugin does.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, adminA: Person, staffB: Person, keeper: Person, labPerson: Person, stranger: Person
const ship = fakeShipping()
const paymentIds: string[] = []
const MARK = 'seeded'
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
/** Every write and delete's context on the seed's collections, while `spy.on`: a site hook, made up. */
const spy: { on: boolean; seen: { collection: string; op: string; context: Record<string, unknown> }[] } = { on: false, seen: [] }
const BATCH = 'sandboxBatch'
const addMarker = (config: Config): Config => ({
  ...config,
  collections: (config.collections ?? []).map((c) =>
    (KIT_COLLECTION_SLUGS as readonly string[]).includes(c.slug) || c.slug === 'orders'
      ? {
          ...c,
          // The marker, and a field a site's sandbox batches would stamp.
          fields: [...c.fields, { name: MARK, type: 'checkbox', index: true }, { name: BATCH, type: 'text', index: true }],
          hooks: {
            ...c.hooks,
            beforeChange: [...(c.hooks?.beforeChange ?? []), ({ context, operation }) => void (spy.on && spy.seen.push({ collection: c.slug, op: operation, context: { ...context } }))],
            beforeDelete: [...(c.hooks?.beforeDelete ?? []), ({ context }) => void (spy.on && spy.seen.push({ collection: c.slug, op: 'delete', context: { ...context } }))],
          },
        }
      : c,
  ),
})
/** The seed plugin's allow(), made up: what it answers is set per test. */
const gate: { answer: (req: unknown) => unknown } = { answer: () => true }
const HUB = { kind: 'street', name: 'Made-up Hub', line1: '1 Example Way', city: 'Testville', state: 'AZ', postalCode: '85000' }

beforeAll(async () => {
  h = await startPayload(
    (o) => ({
      ...o,
      adapters: { shipping: ship.adapter, seed: { allow: (req) => gate.answer(req) as boolean } },
      orders: {
        seeded: ({ buyer, paymentId }) => {
          paymentIds.push(paymentId)
          return { customer: buyer, amount: 0, ref: `paid ${paymentId}` }
        },
      },
    }),
    { plugins: [addMarker] },
  )
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  adminA = await person(payload, 'A', 'admin')
  staffB = await person(payload, 'B', 'staff')
  keeper = await person(payload, 'A')
  labPerson = await person(payload, 'A')
  stranger = await person(payload, 'A')
  h.subjects.add({ kind: 'animal', id: 's1', owner: String(keeper.id), name: 'Made-up tortoise' })
  h.subjects.add({ kind: 'animal', id: 's2', owner: String(keeper.id), name: 'Made-up skink' })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('seed story', () => {
  const people = () => ({ keeper: String(keeper.id), staff: String(staffA.id), lab: String(labPerson.id) })

  it('can only be told by kit staff or an admin, on their own site', async () => {
    for (const who of [keeper, stranger, null]) await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, req: await as(who) }), 'notStaff')
    await kitErr(seedKitStory(payload, { scope: 'B', people: people(), mark: MARK, req: await as(staffA) }), 'wrongSite')
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, req: await as(staffB) }), 'wrongSite')
    await kitErr(seedKitStory(payload, { people: people(), mark: MARK, req: await as(staffA) }), 'wrongSite')
    // The story's own staff member must be kit staff too.
    await kitErr(seedKitStory(payload, { scope: 'A', people: { ...people(), staff: String(stranger.id) }, mark: MARK, req: await as(staffA) }), 'seedPeople')
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: 'not a field', req: await as(staffA) }), 'badMark')
    expect(await payload.count({ collection: 'kits', overrideAccess: true })).toMatchObject({ totalDocs: 0 })
  })

  it('needs the seed plugin’s allow() to answer exactly true, and a marker, before anything is written', async () => {
    const kits = async () => (await payload.count({ collection: 'kits', overrideAccess: true })).totalDocs
    const before = await kits()
    const o = optionsOf(payload)
    const seed = o.adapters!.seed
    try {
      // Not configured at all.
      o.adapters!.seed = undefined
      await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, req: await as(staffA) }), 'seedNotAllowed')
      await kitErr(removeKitRecords(payload, { ids: [], mark: MARK, req: await as(staffA) }), 'seedNotAllowed')
    } finally {
      o.adapters!.seed = seed
    }
    try {
      for (const answer of [() => false, () => 'yes', () => 1, () => Promise.resolve('true'), () => undefined, () => { throw new Error('made-up failure') }]) {
        gate.answer = answer
        await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, req: await as(staffA) }), 'seedNotAllowed')
        await kitErr(removeKitRecords(payload, { ids: [], mark: MARK, req: await as(staffA) }), 'seedNotAllowed')
      }
      // allow() is asked with the caller's request, and comes before the staff check.
      const asked: unknown[] = []
      gate.answer = (req) => (asked.push(req), false)
      const req = await as(keeper)
      await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, req }), 'seedNotAllowed')
      expect(asked).toEqual([req])
    } finally {
      gate.answer = () => true
    }
    // Allowed, but no marker: refused too.
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), req: await as(staffA) } as never), 'badMark')
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: '', req: await as(staffA) }), 'badMark')
    expect(await kits()).toBe(before)
    // The plugin refuses to start with an allow that isn't a function.
    expect(() => checkOptions({ ...o, adapters: { seed: { allow: true } } } as never, payload.config as never)).toThrow(/adapters\.seed\.allow/)
  })

  let tracked: { collection: string; id: string }[] = []
  it('tells one keeper’s story through the plugin’s own actions, marked and reported oldest first', async () => {
    tracked = []
    const out = await seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, track: (collection, id) => void tracked.push({ collection, id }), req: await as(adminA) })
    expect(out).toMatchObject({ orders: 4, kits: 13 })
    expect(out.site.lab).toBeTruthy()
    expect(tracked).toHaveLength(out.records)
    expect(tracked[0]!.collection).toBe('hubs')
    // Every record made is marked, and on site A.
    for (const m of tracked) {
      const doc = (await payload.findByID({ collection: m.collection as never, id: m.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
      expect(doc[MARK], `${m.collection} ${m.id}`).toBe(true)
      expect(doc.tenant, `${m.collection} ${m.id}`).toBe('A')
    }
    // Stand-in payment ids only.
    expect(paymentIds.length).toBe(4)
    for (const id of paymentIds) expect(id).toMatch(/^seed_pi_\d{16}$/)
    // The story's kits: at the lab, activated, packed, recalled out of their order, set aside.
    const statuses = (await payload.find({ collection: 'kits', where: { tenant: { equals: 'A' } }, sort: 'code', pagination: false, depth: 0, overrideAccess: true })).docs.map((k) => k.status)
    expect(statuses.filter((s) => s === 'at-lab')).toHaveLength(2)
    expect(statuses.filter((s) => s === 'activated')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'packed')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'recalled')).toHaveLength(3)
    // Its hub and lab are found again by the marker, not made twice.
    const again = await seedKitStory(payload, { scope: 'A', people: { keeper: String(keeper.id), staff: String(staffA.id) }, mark: MARK, req: await as(staffA) })
    expect(again.site.hub).toBe(out.site.hub)
    expect(again.site.lab).toBeNull()
  })

  it('removes only marked records of the request’s site, and an unmarked kit survives', async () => {
    const lot = '575757'
    await createLot(await as(staffA), { lotNumber: lot, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    const unmarked = (await findKit(await as(staffA), `${lot}000001`, 'A'))!
    const otherSite = await payload.create({ collection: 'hubs', data: { tenant: 'B', name: 'Made-up B hub', [MARK]: true } as never, overrideAccess: true })
    const ids = [...tracked, { collection: 'kits', id: String(unmarked.id) }, { collection: 'hubs', id: String(otherSite.id) }, { collection: 'users', id: String(keeper.id) }]
    // Never without staff, never without the marker.
    for (const who of [keeper, stranger, null]) await kitErr(removeKitRecords(payload, { ids, mark: MARK, req: await as(who) }), 'notStaff')
    await kitErr(removeKitRecords(payload, { ids, mark: '', req: await as(staffA) }), 'badMark')
    const out = await removeKitRecords(payload, { ids, mark: MARK, req: await as(staffA) })
    expect(out).toEqual({ removed: tracked.length, skipped: 3 })
    for (const m of tracked) expect((await payload.count({ collection: m.collection as never, where: { id: { equals: m.id } }, overrideAccess: true })).totalDocs, `${m.collection} ${m.id}`).toBe(0)
    expect(await findKit(await as(staffA), unmarked.code, 'A')).toMatchObject({ id: unmarked.id })
    expect(await payload.findByID({ collection: 'hubs', id: otherSite.id, overrideAccess: true })).toBeTruthy()
    expect(await payload.findByID({ collection: 'users', id: keeper.id, overrideAccess: true })).toBeTruthy()
  })
})

describe('rate study', () => {
  beforeAll(async () => {
    const sys = { overrideAccess: true } as const
    await payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up Study Hub', address: HUB, defaultReturn: true, shipsOrders: true } as never, ...sys })
    await payload.create({ collection: 'box-types', data: { tenant: 'A', name: 'Made-up mailer', kitsPerBox: 2, outsideLength: 6.6, outsideWidth: 6.6, outsideHeight: 4.6, emptyWeightOz: 4 } as never, ...sys })
    await payload.create({ collection: 'box-types', data: { tenant: 'A', name: 'Made-up kit box', kitsPerBox: 1, outsideLength: 6, outsideWidth: 6, outsideHeight: 2, emptyWeightOz: 0 } as never, ...sys })
  })

  it('prices order sizes from test-mode quotes, buys nothing, and says when the prices are made up', async () => {
    const before = ship.bought.length
    const r = await rateStudy(await as(staffA), { counts: [1, 2, 3] })
    expect(r.fake).toBe(true)
    expect(r.rows).toHaveLength(3 * 10)
    expect(r.rows.every((x) => x.plan.totalCents! > 0)).toBe(true)
    expect(ship.bought.length).toBe(before)
    const report = studyReport(r, '2026-11-10')
    expect(report).toMatch(/Made-up prices/)
    expect(report).not.toMatch(/Made-up Study Hub|Example Way/)
    expect(suggestTiers(r.rows, [1, 2]).map((t) => t.minQuantity)).toEqual([1, 2])
  })

  it('refuses in production mode, and for anyone but kit staff', async () => {
    const o = optionsOf(payload)
    const real = o.adapters!.shipping!.quote!
    o.adapters!.shipping!.quote = async (...args) => ({ ...(await real(...args)), mode: 'production' })
    try {
      await kitErr(rateStudy(await as(staffA), { counts: [1] }), 'productionMode')
    } finally {
      o.adapters!.shipping!.quote = real
    }
    const realReturn = o.adapters!.shipping!.quoteReturn!
    o.adapters!.shipping!.quoteReturn = async (...args) => ({ ...(await realReturn(...args)), mode: 'production' })
    try {
      await kitErr(rateStudy(await as(staffA), { counts: [1] }), 'productionMode')
    } finally {
      o.adapters!.shipping!.quoteReturn = realReturn
    }
    for (const who of [keeper, null]) await kitErr(rateStudy(await as(who), { counts: [1] }), 'notStaff')
  })
})

describe('seed stamp and context', () => {
  const people = () => ({ keeper: String(keeper.id), staff: String(staffA.id), lab: String(labPerson.id) })
  /** What the site sends (the seed plugin). */
  const SITE = { audit: { origin: 'script', system: 'seed-world' }, disableRevalidate: true }
  const counts = async () => {
    const out: Record<string, number> = {}
    for (const c of [...KIT_COLLECTION_SLUGS, 'orders']) out[c] = (await payload.count({ collection: c as never, overrideAccess: true })).totalDocs
    return out
  }
  const story = async (stamp: Record<string, unknown> | undefined, context?: Record<string, unknown>) => {
    const tracked: { collection: string; id: string }[] = []
    const out = await seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: stamp as never, context, track: (collection, id) => void tracked.push({ collection, id }), req: await as(staffA) })
    return { out, tracked }
  }

  it('refuses a stamp naming any of the plugin’s own fields, the marker, ids or dates, or a value that isn’t plain, with nothing written', async () => {
    const before = await counts()
    const o = optionsOf(payload)
    const own = new Set<string>(['kitLines', 'kitFulfillment', 'tenant'])
    for (const c of kitCollections(o)) for (const f of topLevelFields(c.fields)) own.add(f.name)
    // A field from each collection the story writes, by name, besides every field the plugin adds.
    for (const name of ['status', 'code', 'lotNumber', 'type', 'actor', 'noticeKey', 'refundId', 'amountCents', 'tracking', 'operators', 'portalUsers', 'number', 'kitLines', 'kitFulfillment', 'tenant']) expect(own.has(name), name).toBe(true)
    for (const key of [...own, MARK, 'id', '_id', 'createdAt', 'updatedAt']) {
      await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: { [key]: 'made-up' }, req: await as(staffA) }), 'badStamp')
      await kitErr(removeKitRecords(payload, { ids: [], mark: MARK, stamp: { [key]: 'made-up' }, req: await as(staffA) }), 'badStamp')
    }
    for (const value of [{}, [], new Date(), null, undefined, '', Number.NaN, Number.POSITIVE_INFINITY, () => 'x', Symbol('x'), 10n]) {
      await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: { [BATCH]: value } as never, req: await as(staffA) }), 'badStamp')
      await kitErr(removeKitRecords(payload, { ids: [], mark: MARK, stamp: { [BATCH]: value } as never, req: await as(staffA) }), 'badStamp')
    }
    for (const stamp of [[], 'batch', 1, null, new Map(), Object.assign(Object.create({ inherited: 1 }), { [BATCH]: 'b' }), { 'not a field': 'b' }]) await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: stamp as never, req: await as(staffA) }), 'badStamp')
    // A field some collection the seed writes doesn't have: its records would quietly go unstamped.
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: { otherBatch: 'b' }, req: await as(staffA) }), 'badStamp')
    for (const context of [[], 'ctx', null, new Map()]) await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, context: context as never, req: await as(staffA) }), 'badContext')
    expect(await counts()).toEqual(before)
  })

  it('still needs allow() and the marker, stamped or not', async () => {
    const before = await counts()
    try {
      gate.answer = () => false
      await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: { [BATCH]: 'b' }, context: SITE, req: await as(staffA) }), 'seedNotAllowed')
      await kitErr(removeKitRecords(payload, { ids: [], mark: MARK, stamp: { [BATCH]: 'b' }, context: SITE, req: await as(staffA) }), 'seedNotAllowed')
    } finally {
      gate.answer = () => true
    }
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: '', stamp: { [BATCH]: 'b' }, context: SITE, req: await as(staffA) }), 'badMark')
    await kitErr(removeKitRecords(payload, { ids: [], mark: '', stamp: { [BATCH]: 'b' }, context: SITE, req: await as(staffA) }), 'badMark')
    await kitErr(seedKitStory(payload, { scope: 'A', people: people(), mark: MARK, stamp: { [BATCH]: 'b' }, context: SITE, req: await as(keeper) }), 'notStaff')
    expect(await counts()).toEqual(before)
  })

  it('stamps every record a story makes, shipment notices included, and passes the context on every write', async () => {
    const o = optionsOf(payload)
    const notify = o.notify
    o.notify = async () => undefined
    spy.seen = []
    spy.on = true
    let made: Awaited<ReturnType<typeof story>>
    try {
      made = await story({ [BATCH]: 'batch-ctx' }, SITE)
    } finally {
      spy.on = false
      o.notify = notify
    }
    const { tracked } = made
    expect(tracked.some((m) => m.collection === 'kit-notices')).toBe(true)
    for (const m of tracked) {
      const doc = (await payload.findByID({ collection: m.collection as never, id: m.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
      expect([doc[MARK], doc[BATCH]], `${m.collection} ${m.id}`).toEqual([true, 'batch-ctx'])
    }
    // Nothing of the plugin's collections made by the story is left unstamped.
    for (const c of KIT_COLLECTION_SLUGS) {
      const ids = tracked.filter((m) => m.collection === c).map((m) => m.id)
      const stamped = (await payload.count({ collection: c as never, where: { [BATCH]: { equals: 'batch-ctx' } }, overrideAccess: true })).totalDocs
      expect(stamped, c).toBe(ids.length)
    }
    // Every write the story made carried the site's context; its kits, trail, lots, orders and hub were all written.
    const written = new Set(spy.seen.map((s) => s.collection))
    for (const c of ['hubs', 'labs', 'kit-lots', 'kits', 'kit-events', 'lab-batches', 'orders', 'kit-notices']) expect(written.has(c), c).toBe(true)
    for (const s of spy.seen) expect(s.context.disableRevalidate, `${s.op} ${s.collection}`).toBe(true)
    // Every write is labeled a seed script's, with the plugin's own reason for it.
    for (const s of spy.seen) expect(s.context.audit, `${s.op} ${s.collection}`).toEqual({ origin: 'script', system: 'seed-world', reason: expect.stringMatching(/\S/) })
    expect(spy.seen.find((s) => s.collection === 'hubs' && s.op === 'create')?.context.audit).toEqual({ origin: 'script', system: 'seed-world', reason: 'seed hub' })
    expect(spy.seen.find((s) => s.collection === 'kit-notices')?.context.audit).toMatchObject({ reason: 'shipment notice recorded' })
    // Its deletes too.
    spy.seen = []
    spy.on = true
    try {
      const out = await removeKitRecords(payload, { ids: tracked, mark: MARK, stamp: { [BATCH]: 'batch-ctx' }, context: SITE, req: await as(staffA) })
      expect(out).toEqual({ removed: tracked.length, skipped: 0 })
    } finally {
      spy.on = false
    }
    const deletes = spy.seen.filter((s) => s.op === 'delete')
    expect(deletes).toHaveLength(tracked.length)
    for (const s of deletes) expect(s.context.disableRevalidate, s.collection).toBe(true)
    for (const s of deletes) expect(s.context.audit, s.collection).toEqual({ origin: 'script', system: 'seed-world', reason: 'seed record removed' })
  })

  it('lays the plugin’s own context keys over the caller’s, and never lets the caller set a guard’s', async () => {
    const pending: unknown[] = []
    let called = false
    const hostile = {
      ...SITE,
      // The caller's reason loses to the plugin's; a key the plugin doesn't use stays.
      audit: { ...SITE.audit, reason: 'made-up caller reason', note: 'kept' },
      [EVENT_WRITE_KEY]: EVENT_WRITE,
      [SKIP_LABEL_CANCEL]: true,
      [AFTER_COMMIT_KEY]: Object.assign(pending, { push: () => (called = true) }),
    }
    // The keys the plugin protects are the ones its code reads.
    expect(GUARD_CONTEXT_KEYS).toEqual([EVENT_WRITE_KEY, SKIP_LABEL_CANCEL, AFTER_COMMIT_KEY])
    expect(PLUGIN_CONTEXT_KEYS).toEqual([...GUARD_CONTEXT_KEYS, 'audit'])
    spy.seen = []
    spy.on = true
    let made: Awaited<ReturnType<typeof story>>
    try {
      made = await story({ [BATCH]: 'batch-hostile' }, hostile)
    } finally {
      spy.on = false
    }
    expect(made.out).toMatchObject({ orders: 4, kits: 13 })
    expect(called).toBe(false)
    for (const s of spy.seen) {
      const where = `${s.op} ${s.collection}`
      expect(s.context.disableRevalidate, where).toBe(true)
      expect(s.context[AFTER_COMMIT_KEY], where).not.toBe(pending)
      // Only the plugin's own kit-status writes carry its event mark, and only its kit saves skip label canceling.
      if (s.collection !== 'kits') expect([s.context[EVENT_WRITE_KEY], s.context[SKIP_LABEL_CANCEL]], where).toEqual([undefined, undefined])
      // The caller's origin and system, the plugin's reason.
      expect(s.context.audit, where).toEqual({ origin: 'script', system: 'seed-world', reason: expect.not.stringMatching(/made-up caller reason/), note: 'kept' })
    }
    // The story's own hub, and the kits' status writes by their events, keep the plugin's reason under the caller's origin and system.
    expect(spy.seen.find((s) => s.collection === 'hubs' && s.op === 'create')?.context.audit).toEqual({ origin: 'script', system: 'seed-world', reason: 'seed hub', note: 'kept' })
    expect(spy.seen.find((s) => s.collection === 'kits' && s.op === 'update' && s.context[EVENT_WRITE_KEY] === EVENT_WRITE)?.context.audit).toMatchObject({ origin: 'script', system: 'seed-world', reason: expect.stringMatching(/^kit /) })
    // The guard itself: a kit's status can't be written past its events by a carried context.
    const kitId = made.tracked.find((m) => m.collection === 'kits')!.id
    const carried = carry(await as(staffA), carriable(hostile))
    // Field by field: the caller's origin and system over the plugin's audit; the plugin's other keys over the caller's.
    const own = { origin: 'web', system: 'kits', reason: 'made-up', step: 2 }
    expect(sysReq(carried, { audit: own }).context.audit).toEqual({ origin: 'script', system: 'seed-world', reason: 'made-up', step: 2, note: 'kept' })
    expect(own).toEqual({ origin: 'web', system: 'kits', reason: 'made-up', step: 2 })
    // Any other key the plugin sets still wins whole.
    expect(sysReq(carried, { disableRevalidate: false }).context.disableRevalidate).toBe(false)
    for (const r of [sysReq(carried), sysReq(carried, { audit: { origin: 'web', system: 'kits', reason: 'made-up' } }), freshReq(carried)]) {
      expect(r.context[EVENT_WRITE_KEY]).toBeUndefined()
      expect(r.context[SKIP_LABEL_CANCEL]).toBeUndefined()
      expect(r.context.disableRevalidate).toBe(true)
      await expect(payload.update({ collection: 'kits', id: kitId, data: { status: 'complete' } as never, overrideAccess: true, req: r })).rejects.toThrow(/only through its events/)
    }
    await removeKitRecords(payload, { ids: made.tracked, mark: MARK, stamp: { [BATCH]: 'batch-hostile' }, req: await as(staffA) })
  })

  it('removes only one batch’s records when two share a marker; without a stamp, any marked record as before', async () => {
    const one = await story({ [BATCH]: 'batch-1' })
    const two = await story({ [BATCH]: 'batch-2' })
    expect(one.out.site.hub).not.toBe(two.out.site.hub)
    const plain = await payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up unstamped hub', [MARK]: true } as never, overrideAccess: true })
    const all = [...one.tracked, ...two.tracked, { collection: 'hubs', id: String(plain.id) }]
    const exists = async (m: { collection: string; id: string }) => (await payload.count({ collection: m.collection as never, where: { id: { equals: m.id } }, overrideAccess: true })).totalDocs === 1
    expect(await removeKitRecords(payload, { ids: all, mark: MARK, stamp: { [BATCH]: 'batch-1' }, req: await as(staffA) })).toEqual({ removed: one.tracked.length, skipped: two.tracked.length + 1 })
    for (const m of one.tracked) expect(await exists(m), `${m.collection} ${m.id}`).toBe(false)
    for (const m of two.tracked) expect(await exists(m), `${m.collection} ${m.id}`).toBe(true)
    expect(await exists({ collection: 'hubs', id: String(plain.id) })).toBe(true)
    // The other batch's stamp, or a field the collections don't have, removes nothing.
    expect(await removeKitRecords(payload, { ids: two.tracked, mark: MARK, stamp: { [BATCH]: 'batch-1' }, req: await as(staffA) })).toEqual({ removed: 0, skipped: two.tracked.length })
    await kitErr(removeKitRecords(payload, { ids: two.tracked, mark: MARK, stamp: { [BATCH]: 'batch-2', otherBatch: 'x' }, req: await as(staffA) }), 'badStamp')
    expect(await removeKitRecords(payload, { ids: two.tracked, mark: MARK, stamp: { [BATCH]: 'batch-2' }, req: await as(staffA) })).toEqual({ removed: two.tracked.length, skipped: 0 })
    // No stamp: as before, any marked record.
    expect(await removeKitRecords(payload, { ids: [{ collection: 'hubs', id: String(plain.id) }], mark: MARK, req: await as(staffA) })).toEqual({ removed: 1, skipped: 0 })
  })
})
