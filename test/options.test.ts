import type { CollectionConfig, Config, Field, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { activateKit, createLot, findKit, issueSecret, KitError, recallLot, receiveKit, recordKitEvent, sampleKits, type SampleKitsOptions } from '../src/index.js'
import { fakeAccess, fakeSubjects, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo } from './harness.js'

// Made-up people and kits only.
const base = (): Config =>
  ({
    secret: 'made-up-secret-for-tests',
    collections: [
      { slug: 'users', auth: true, fields: [] },
      { slug: 'orders', fields: [] },
      { slug: 'files', fields: [] },
    ],
  }) as unknown as Config
const good = (): SampleKitsOptions => ({ access: fakeAccess(), subjects: fakeSubjects(), tests: [{ label: 'Made-up test', value: 't' }] })
const start = (o: unknown, config = base()) => () => sampleKits(o as SampleKitsOptions)(config)

describe('start-up checks', () => {
  it('accepts good options and keeps them for the actions', () => {
    const config = start(good())() as Config
    expect(config.collections!.map((c) => c.slug)).toEqual(['users', 'orders', 'files', 'kit-lots', 'kits', 'kit-events', 'box-types', 'hubs', 'labs', 'lab-batches', 'return-labels', 'kit-refunds', 'kit-notices'])
    expect((config.custom as { sampleKits: { collections: unknown } }).sampleKits.collections).toEqual({ users: 'users', orders: 'orders', products: 'products', files: 'files' })
  })

  it('refuses bad options with a plain message', () => {
    const cases: [unknown, RegExp, Config?][] = [
      [undefined, /needs its options/],
      [{ ...good(), access: undefined }, /`access` is required/],
      [{ ...good(), access: { ...fakeAccess(), maintainer: true } }, /`access.maintainer` must be a function/],
      [{ ...good(), access: { ...fakeAccess(), buyerOf: { buyer: 1 } } }, /`access.buyerOf`/],
      [{ ...good(), subjects: undefined }, /`subjects` is required/],
      [{ ...good(), subjects: { ...fakeSubjects(), canSample: undefined } }, /`subjects.canSample` must be a function/],
      [{ ...good(), subjects: { ...fakeSubjects(), fields: [{ name: 'status', type: 'text' }] } }, /field "status", which kits already have/],
      [{ ...good(), subjects: { ...fakeSubjects(), kinds: [] } }, /`subjects.kinds`/],
      [{ ...good(), tests: [] }, /`tests` is required/],
      [{ ...good(), tests: [{ label: 'A', value: 'a' }, { label: 'B', value: 'a' }] }, /same `value`/],
      [{ ...good(), scope: { field: '', of: () => null } }, /`scope.field`/],
      [{ ...good(), scope: { field: 'tenant', of: () => null, isLabUser: true } }, /`scope.isLabUser` must be a function/],
      [{ ...good(), ensureIndexes: 'later' }, /`ensureIndexes` must be "startup" or "manual"/],
      [{ ...good(), preorders: { voteItems: '' } }, /`preorders` must be an object/],
      [{ ...good(), results: { accept: async () => ({ status: 'ready' }) } }, /`results.view` must be a function/],
      [{ ...good(), adapters: { events: {} } }, /`adapters.events.dropOffChoices` must be a function/],
      [{ ...good(), adapters: { events: { dropOffChoices: async () => [], dateOf: 'x' } } }, /`adapters.events.dateOf`/],
      [{ ...good(), overrides: { orders: (c: CollectionConfig) => c } }, /isn’t one of the plugin’s collections/],
      [{ ...good(), notify: 'email' }, /`notify` must be a function/],
      [{ ...good(), adapters: { shipping: { addressProblems: true } } }, /addressProblems/],
      [good(), /no "users" collection/, { collections: [{ slug: 'orders', fields: [] }, { slug: 'files', fields: [] }] } as unknown as Config],
      [good(), /isn’t a collection people sign in with/, { collections: [{ slug: 'users', fields: [] }, { slug: 'orders', fields: [] }, { slug: 'files', fields: [] }] } as unknown as Config],
      [good(), /no "orders" collection/, { collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'files', fields: [] }] } as unknown as Config],
      [{ ...good(), scope: { field: 'tenant', of: () => 'A' }, access: { ...fakeAccess(), staff: undefined } }, /`access.staff` must be a function/],
      [{ ...good(), subjects: { ...fakeSubjects(), buyerFields: ['nope'] } }, /`subjects.buyerFields` must name fields from `subjects.fields`/],
      [{ ...good(), results: { accept: async () => ({ status: 'ready' }), view: async () => null, verifyUpload: 'yes' } }, /`results.verifyUpload` must be a function/],
      [{ ...good(), results: { accept: async () => ({ status: 'ready' }), view: async () => null, maxBase64Bytes: -1 } }, /`results.maxBase64Bytes`/],
      [{ ...good(), site: { origin: 'https://kits.example.test/path' } }, /`site.origin` must be the site’s address with no path/],
      [{ ...good(), site: { origin: 'javascript:alert(1)' } }, /`site.origin`/],
      [{ ...good(), site: { name: '' } }, /`site.name`/],
      [{ ...good(), site: { labPortalPath: 'lab' } }, /`site.labPortalPath`/],
      [good(), /`secret` \(PAYLOAD_SECRET\) must be at least 16 characters/, { ...base(), secret: 'short-secret' } as unknown as Config],
      [good(), /`secret` \(PAYLOAD_SECRET\) must be at least 16 characters/, { ...base(), secret: undefined } as unknown as Config],
      [good(), /already has a "kits" collection/, { ...base(), collections: [...base().collections!, { slug: 'kits', fields: [] }] } as unknown as Config],
    ]
    for (const [o, message, config] of cases) expect(start(o, config), String(message)).toThrow(message)
  })

  it('refuses an override that removes a field, changes one, or renames the collection', () => {
    const drop = (name: string) => (c: CollectionConfig) => ({ ...c, fields: strip(c.fields).filter((f) => !('name' in f && f.name === name)) })
    expect(start({ ...good(), overrides: { kits: drop('status') } })).toThrow(/removed the field "status"/)
    expect(start({ ...good(), overrides: { kits: drop('secretHash') } })).toThrow(/removed the field "secretHash"/)
    expect(start({ ...good(), overrides: { 'kit-lots': drop('recalled') } })).toThrow(/removed the field "recalled"/)
    expect(start({ ...good(), overrides: { kits: (c: CollectionConfig) => ({ ...c, fields: [...strip(c.fields).filter((f) => !('name' in f && f.name === 'code')), { name: 'code', type: 'number' }] }) } })).toThrow(/changed the field "code"/)
    expect(start({ ...good(), overrides: { kits: (c: CollectionConfig) => ({ ...c, slug: 'tubes' }) } })).toThrow(/slug can’t change/)
  })
})

/** A field list with every access rule, hook and hidden flag taken off, and rows and collapsibles flattened. */
function strip(fields: Field[]): Field[] {
  return fields.flatMap((f) => {
    if (!('name' in f) && 'fields' in f) return strip(f.fields as Field[])
    const { access: _a, hooks: _h, hidden: _x, ...rest } = f as Field & { access?: unknown; hooks?: unknown; hidden?: unknown }
    return [rest as Field]
  })
}

describe('exactly true, or no', () => {
  let payload: Payload
  beforeAll(async () => {
    ;({ payload } = await startPayload((o) => ({
      ...o,
      access: {
        staff: (() => 1) as never,
        admin: (() => 'true') as never,
        maintainer: () => {
          throw new Error('made-up failure')
        },
        buyerOf: (() => true) as never,
      },
    })))
  }, 120_000)
  afterAll(async () => {
    await payload?.destroy()
  })

  it('refuses truthy answers that aren’t true, thrown errors, and a buyer rule that answers true', async () => {
    const someone = await person(payload, 'A', 'maintainer')
    const req = await reqAs(payload, someone as never)
    await expect(receiveKit(req, '275864000001')).rejects.toMatchObject({ code: 'notStaff' })
    const as = { overrideAccess: false as const, user: { ...someone, collection: 'users' } as never }
    await expect(payload.find({ collection: 'kits', ...as })).rejects.toThrow()
    await expect(payload.find({ collection: 'kit-lots', ...as })).rejects.toThrow()
    await expect(payload.create({ collection: 'hubs', data: { name: 'Made-up Hub' } as never, ...as })).rejects.toThrow()
  })
})

describe('overrides can’t remove the plugin’s rules', () => {
  let payload: Payload
  const strippedEverything = (c: CollectionConfig): CollectionConfig => ({
    ...c,
    // Everything off, everything open, and a hook that tries to move the status behind the trail's back.
    access: { read: () => true, create: () => true, update: () => true, delete: () => true },
    hooks: {
      beforeChange: [
        ({ data }) => {
          if (data?.notes === 'sneak') data.status = 'released'
          return data
        },
      ],
    },
    fields: [...strip(c.fields), { name: 'siteNumber', type: 'text' }],
  })
  beforeAll(async () => {
    ;({ payload } = await startPayload((o) => ({
      ...o,
      overrides: { kits: strippedEverything, 'kit-lots': strippedEverything, 'kit-events': strippedEverything },
    })))
  }, 120_000)
  afterAll(async () => {
    await payload?.destroy()
    await stopMongo()
  })

  it('keeps status, code, secret, recall, the trail and kit access as the plugin set them', async () => {
    const staff = await person(payload, 'A', 'staff')
    const buyer = await person(payload, 'A')
    const stranger = await person(payload, 'A')
    const api = (u: { id: string } | null) => ({ overrideAccess: false as const, user: u ? ({ ...u, collection: 'users' } as never) : undefined })
    const req = async () => reqAs(payload, staff as never)
    await createLot(await req(), { lotNumber: '275864', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 3 })
    const k1 = (await findKit(await req(), '275864000001', 'A'))!
    // The site's own field is there.
    expect((await payload.update({ collection: 'kits', id: k1.id, data: { siteNumber: 'K-1' } as never, ...api(staff) })).siteNumber).toBe('K-1')

    // Status: an API write is dropped, a direct write and the override's hook are refused.
    expect((await payload.update({ collection: 'kits', id: k1.id, data: { status: 'released' } as never, ...api(staff) })).status).toBe('in-stock')
    await expect(payload.update({ collection: 'kits', id: k1.id, data: { notes: 'sneak' } as never, overrideAccess: true })).rejects.toThrow(/only through its events/)
    // Code.
    await expect(payload.update({ collection: 'kits', id: k1.id, data: { code: '275864999999' } as never, overrideAccess: true })).rejects.toThrow(/can’t change/)
    // Kit access was only narrowed: a stranger still sees nothing, the signed-out are refused.
    await recordKitEvent(await req(), k1, { type: 'packed', set: { buyer: buyer.id } })
    const secret = (await issueSecret(await req(), { code: k1.code })).secret
    await recordKitEvent(await req(), k1, { type: 'shipped' })
    expect((await payload.find({ collection: 'kits', ...api(stranger) })).docs).toHaveLength(0)
    expect((await payload.find({ collection: 'kits', ...api(buyer) })).docs.map((k) => k.code)).toEqual([k1.code])
    await expect(payload.find({ collection: 'kits', ...api(null) })).rejects.toThrow()
    // The secret stays unreadable, even to staff.
    expect((await payload.find({ collection: 'kits', ...api(staff) })).docs.every((k) => !('secretHash' in k))).toBe(true)
    expect((await payload.find({ collection: 'kits', overrideAccess: true })).docs.every((k) => !('secretHash' in k))).toBe(true)
    // The trail is never edited, and only staff read it.
    const [event] = (await payload.find({ collection: 'kit-events', limit: 1, overrideAccess: true })).docs
    await expect(payload.update({ collection: 'kit-events', id: event!.id, data: { note: 'changed' } as never, overrideAccess: true })).rejects.toThrow(/never edited/)
    await expect(payload.find({ collection: 'kit-events', ...api(stranger) })).rejects.toThrow()
    // A recall still sets kits aside, and staff still can't lift it.
    await recallLot(await req(), { lotNumber: '275864', reason: 'Made-up' })
    expect((await findKit(await req(), '275864000002', 'A'))!.status).toBe('recalled')
    const lot = (await payload.find({ collection: 'kit-lots', overrideAccess: true })).docs[0]!
    await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: false } as never, ...api(staff) })).rejects.toThrow(/can’t be lifted/)
    await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { lotNumber: '111111' } as never, overrideAccess: true })).rejects.toThrow(/can’t change/)
    // And the recalled, secret-bearing kit can't be activated.
    const err = await activateKit(await reqAs(payload, buyer as never), { code: k1.code, secret, subject: { kind: 'animal', id: 'x' } }).catch((e: KitError) => e)
    expect(err).toMatchObject({ code: 'recalledCustomer' })
  })
})
