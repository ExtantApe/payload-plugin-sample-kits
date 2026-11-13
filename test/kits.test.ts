import { initTransaction, killTransaction, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { activateKit, addBuiltKit, createLot, findKit, hashSecret, issueSecret, KitError, markSampled, recallLot, receiveKit, recordKitEvent } from '../src/index.js'
import { reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Made-up people on two made-up sites, A and B. Nothing here is real.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, adminA: Person, maintA: Person, buyer: Person, stranger: Person, staffB: Person, keeperB: Person
let orderA: string
const LOT = '275864'
const c = (n: number) => `${LOT}${String(n).padStart(6, '0')}`
const flags = { failWrite: false, failCanSample: false, badAssign: false, writeThenThrow: false, slowSample: false }

const as = (u: Person | null) => reqAs(payload, u as never)
const api = (u: Person | null) => ({ overrideAccess: false as const, user: u ? ({ ...u, collection: 'users' } as never) : undefined })
async function kitErr(p: Promise<unknown>, code: string): Promise<KitError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `expected KitError ${code}`).toBeInstanceOf(KitError)
  expect((error as KitError).code).toBe(code)
  return error as KitError
}
const raw = async (code: string) => (await payload.db.collections.kits!.findOne({ code, tenant: 'A' }).lean()) as Record<string, unknown>
const kitOf = async (code: string) => (await payload.find({ collection: 'kits', where: { and: [{ code: { equals: code } }, { tenant: { equals: 'A' } }] }, overrideAccess: true, depth: 0 })).docs[0] as unknown as Record<string, unknown> & { id: string; status: string }
const eventsOf = async (code: string) =>
  (await payload.find({ collection: 'kit-events', where: { kit: { equals: (await kitOf(code)).id } }, sort: 'createdAt', pagination: false, overrideAccess: true, depth: 0 })).docs as unknown as { type: string; details?: Record<string, unknown>; note?: string; actor?: string }[]

/** Test setup only: what packing (phase 2) will do. Packs a kit for the buyer and gives it a secret. */
async function packed(code: string, forWhom: Person = buyer, site: 'A' | 'B' = 'A', staff = staffA) {
  const req = await as(staff)
  const kit = (await findKit(req, code, site))!
  await recordKitEvent(req, kit, { type: 'packed', order: orderA, set: { buyer: forWhom.id, order: orderA, suggestedKind: 'animal', suggestedId: 'a1' } })
  return (await issueSecret(await as(staff), { code })).secret
}
async function shipped(code: string) {
  const req = await as(staffA)
  await recordKitEvent(req, (await findKit(req, code, 'A'))!, { type: 'shipped' })
}

beforeAll(async () => {
  h = await startPayload((o) => ({
    ...o,
    subjects: {
      ...o.subjects,
      assign: async (args) => {
        if (flags.writeThenThrow) {
          // A provider that writes in the caller's transaction, then fails.
          await args.req.payload.create({ collection: 'orders', data: { ref: 'provider-write' } as never, req: args.req })
          throw new Error('made-up provider failure')
        }
        return flags.badAssign ? { buyer: stranger.id } : o.subjects.assign(args)
      },
      canSample: async (args) => {
        if (flags.failCanSample) throw new Error('made-up provider failure')
        // Holds every racer after its read, so all of them read the kit before any writes it.
        if (flags.slowSample) await new Promise((r) => setTimeout(r, 60))
        return o.subjects.canSample(args)
      },
      fields: o.subjects.fields.map((f) =>
        'name' in f && f.name === 'subjectId'
          ? {
              ...f,
              hooks: {
                beforeChange: [
                  ({ value }: { value?: unknown }) => {
                    if (flags.failWrite && value) throw new Error('made-up provider failure')
                    return value
                  },
                ],
              },
            }
          : f,
      ) as never,
    },
  }))
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  adminA = await person(payload, 'A', 'admin')
  maintA = await person(payload, 'A', 'maintainer')
  buyer = await person(payload, 'A')
  stranger = await person(payload, 'A')
  staffB = await person(payload, 'B', 'staff')
  keeperB = await person(payload, 'B')
  h.subjects.add({ kind: 'animal', id: 'a1', owner: buyer.id, name: 'Made-up Shelly' })
  h.subjects.add({ kind: 'group', id: 'g1', owner: buyer.id, name: 'Made-up Group #1' })
  h.subjects.add({ kind: 'animal', id: 's1', owner: stranger.id, name: 'Made-up Pebble' })
  h.subjects.add({ kind: 'animal', id: 'b1', owner: keeperB.id, name: 'Made-up Rocky' })
  orderA = String((await payload.create({ collection: 'orders', data: { ref: 'made-up order', tenant: 'A' } as never })).id)
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 30 })
  await createLot(await as(staffB), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 3 })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('receiving built kits', () => {
  it('adds a lot with a serial range, scans more in, and refuses unknown lots and non-codes', async () => {
    expect((await kitOf(c(1))).status).toBe('in-stock')
    await createLot(await as(staffA), { lotNumber: '3141', expiresOn: '2099-01-01' })
    expect(await receiveKit(await as(staffA), '3141 0000 0001')).toEqual({ result: 'added', code: '314100000001', status: 'in-stock', lot: '3141' })
    expect(await receiveKit(await as(staffA), '314100000001')).toMatchObject({ result: 'already' })
    await kitErr(receiveKit(await as(staffA), '999999000001'), 'unknownLot')
    await kitErr(receiveKit(await as(staffA), 'abc'), 'notACode')
    await kitErr(createLot(await as(staffA), { lotNumber: LOT }), 'lotExists')
    expect((await eventsOf('314100000001')).map((e) => e.type)).toEqual(['received'])
    expect((await eventsOf('314100000001'))[0]!.actor).toBe(staffA.id)
  })

  it('adds a built kit inside the caller’s transaction, so the caller’s rollback takes it back', async () => {
    const req = await as(staffA)
    await initTransaction(req)
    expect(await addBuiltKit(req, '314100000002')).toMatchObject({ added: true })
    await killTransaction(req)
    expect(await kitOf('314100000002')).toBeUndefined()
  })
})

describe('access, with refusals', () => {
  it('lets only kit staff receive, make lots, issue secrets and recall', async () => {
    for (const who of [buyer, stranger, null]) {
      await kitErr(receiveKit(await as(who), c(29)), 'notStaff')
      await kitErr(createLot(await as(who), { lotNumber: '777777' }), 'notStaff')
      await kitErr(issueSecret(await as(who), { code: c(29) }), 'notStaff')
      await kitErr(recallLot(await as(who), { lotNumber: LOT, reason: 'made-up' }), 'notStaff')
    }
    for (const who of [adminA, maintA]) expect(await receiveKit(await as(who), c(29))).toMatchObject({ result: 'already' })
  })

  it('gives each role its collections, and refuses everyone else', async () => {
    // Lots: staff create, only admins delete.
    const lot = await payload.create({ collection: 'kit-lots', data: { lotNumber: '424242' } as never, ...api(staffA) })
    expect(lot.tenant).toBe('A') // stamped with the person's site
    for (const who of [buyer, stranger, null]) await expect(payload.create({ collection: 'kit-lots', data: { lotNumber: '434343' } as never, ...api(who) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'kit-lots', id: lot.id, ...api(staffA) })).rejects.toThrow()
    await payload.delete({ collection: 'kit-lots', id: lot.id, ...api(adminA) })
    // Hubs and labs: staff read, admins set up.
    await expect(payload.create({ collection: 'labs', data: { name: 'Made-up Lab' } as never, ...api(staffA) })).rejects.toThrow()
    await payload.create({ collection: 'labs', data: { name: 'Made-up Lab' } as never, ...api(adminA) })
    await payload.create({ collection: 'hubs', data: { name: 'Made-up Hub' } as never, ...api(maintA) })
    expect((await payload.find({ collection: 'labs', ...api(staffA) })).docs).toHaveLength(1)
    for (const who of [buyer, stranger, null]) {
      await expect(payload.find({ collection: 'labs', ...api(who) })).rejects.toThrow()
      await expect(payload.find({ collection: 'kit-events', ...api(who) })).rejects.toThrow()
      await expect(payload.find({ collection: 'kit-lots', ...api(who) })).rejects.toThrow()
    }
    // The custody trail: staff read it, nobody writes it through the API, only a maintainer deletes a row.
    const [event] = (await payload.find({ collection: 'kit-events', limit: 1, ...api(staffA) })).docs
    expect(event).toBeDefined()
    for (const who of [staffA, adminA, maintA]) await expect(payload.create({ collection: 'kit-events', data: { kit: event!.kit, type: 'released', at: new Date().toISOString() } as never, ...api(who) })).rejects.toThrow()
    await expect(payload.update({ collection: 'kit-events', id: event!.id, data: { note: 'changed' } as never, ...api(maintA) })).rejects.toThrow()
    await expect(payload.update({ collection: 'kit-events', id: event!.id, data: { note: 'changed' } as never, overrideAccess: true })).rejects.toThrow(/never edited/)
    await expect(payload.delete({ collection: 'kit-events', id: event!.id, ...api(adminA) })).rejects.toThrow()
    await payload.delete({ collection: 'kit-events', id: event!.id, ...api(maintA) })
  })

  it('shows a buyer their own kits only, a stranger none, and asks the signed-out to sign in', async () => {
    await packed(c(2))
    const codes = async (who: Person | null) => (await payload.find({ collection: 'kits', pagination: false, ...api(who) })).docs.map((k) => k.code)
    expect(await codes(buyer)).toEqual([c(2)])
    expect(await codes(stranger)).toEqual([])
    expect((await codes(staffA)).length).toBeGreaterThan(30)
    await expect(codes(null)).rejects.toThrow()
    const id = (await kitOf(c(2))).id
    await expect(payload.findByID({ collection: 'kits', id, ...api(stranger) })).rejects.toThrow()
    // Buyers read; they don't write.
    await expect(payload.update({ collection: 'kits', id, data: { notes: 'mine' } as never, ...api(buyer) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'kits', id, ...api(staffA) })).rejects.toThrow()
  })

  it('keeps each site’s kits to that site through the scope', async () => {
    // Site B has its own lot with the same number; B's staff never reach A's kits.
    expect(await receiveKit(await as(staffB), c(1))).toMatchObject({ result: 'already' })
    expect(await receiveKit(await as(staffB), c(10))).toMatchObject({ result: 'added' }) // B's own kit 10, beside A's
    const both = await payload.find({ collection: 'kits', where: { code: { equals: c(10) } }, overrideAccess: true, depth: 0 })
    expect(both.docs.map((k) => k.tenant).sort()).toEqual(['A', 'B'])
    const secret = await packed(c(3))
    const hashA = (await payload.db.collections.kits!.findOne({ code: c(3), tenant: 'A' }).lean() as { secretHash?: string }).secretHash
    // B's staff reach only B's kit 3, which is in stock; A's kit 3 is never touched.
    await kitErr(issueSecret(await as(staffB), { code: c(3) }), 'slipTooLate')
    expect(await payload.db.collections.kits!.findOne({ code: c(3), tenant: 'A' }).lean()).toMatchObject({ status: 'packed', secretHash: hashA })
    // A keeper on site B with A's secret gets the same answer as a wrong secret.
    await kitErr(activateKit(await as(keeperB), { code: c(3), secret, subject: { kind: 'animal', id: 'b1' } }), 'badSecret')
    // No site, no action.
    const nowhere = await person(payload, '')
    await kitErr(activateKit(await as(nowhere), { code: c(3), secret, subject: { kind: 'animal', id: 'a1' } }), 'noSite')
  })
})

describe('the secret rule', () => {
  it('activates only with the kit’s own secret, and every other way gets the same answer', async () => {
    const secret = await packed(c(4))
    const other = await packed(c(5))
    await shipped(c(4))
    const subject = { kind: 'animal', id: 'a1' }
    const tries = [
      { code: c(4), secret: 'AAAAA-AAAAA' }, // wrong
      { code: c(4), secret: '' }, // none
      { code: c(4), secret: undefined as unknown as string }, // missing
      { code: c(4), secret: c(4) }, // the code as its own secret
      { code: c(4), secret: c(4).slice(0, 10) }, // the code, cut to a secret's length
      { code: c(4), secret: other }, // another kit's secret
      { code: c(4), secret: `${secret}X` }, // too long
      { code: '999999000001', secret }, // no such kit
      { code: 'not-a-code', secret },
    ]
    const errors: KitError[] = []
    for (const t of tries) errors.push(await kitErr(activateKit(await as(buyer), { ...t, subject }), 'badSecret'))
    expect(new Set(errors.map((e) => `${e.code}|${e.message}|${JSON.stringify(e.vars)}`)).size).toBe(1)
    // Typed in lower case with spaces, the real one works, once.
    expect(await activateKit(await as(buyer), { code: c(4), secret: ` ${secret.toLowerCase()} `, subject })).toEqual({ code: c(4), label: 'Made-up Shelly' })
    await kitErr(activateKit(await as(buyer), { code: c(4), secret, subject }), 'badSecret')
    expect(await kitOf(c(4))).toMatchObject({ status: 'activated', activatedBy: buyer.id, subjectKind: 'animal', subjectId: 'a1' })
  })

  it('never activates with a code given as its secret, even if a hash for it were stored', async () => {
    // A 10-digit code made only of 2–9 has a secret's shape. Plant the hash of "code as secret".
    await createLot(await as(staffA), { lotNumber: '23456', expiresOn: '2099-01-01', serialDigits: 5, firstSerial: 78923, lastSerial: 78923 })
    const code = '2345678923'
    await packed(code)
    await payload.db.collections.kits!.updateOne({ code }, { $set: { secretHash: hashSecret(payload.config.secret, code, code) } })
    await kitErr(activateKit(await as(buyer), { code, secret: code, subject: { kind: 'animal', id: 'a1' } }), 'badSecret')
  })

  it('needs a person signed in, and a subject they may sample', async () => {
    const secret = await packed(c(6))
    await kitErr(activateKit(await as(null), { code: c(6), secret, subject: { kind: 'animal', id: 'a1' } }), 'signIn')
    // Signed in to another collection (a device, say) isn't a person here.
    await kitErr(activateKit(await reqAs(payload, { ...buyer, collection: 'devices' } as never), { code: c(6), secret, subject: { kind: 'animal', id: 'a1' } }), 'signIn')
    // The subject provider writes only its own fields.
    flags.badAssign = true
    await expect(activateKit(await as(buyer), { code: c(6), secret, subject: { kind: 'animal', id: 'a1' } })).rejects.toThrow(/only write the subject fields/)
    flags.badAssign = false
    await kitErr(activateKit(await as(stranger), { code: c(6), secret, subject: { kind: 'animal', id: 'a1' } }), 'notYourSubject')
    await kitErr(activateKit(await as(buyer), { code: c(6), secret, subject: { kind: 'plant', id: 'a1' } }), 'chooseSubject')
    await kitErr(activateKit(await as(buyer), { code: c(6), secret, subject: null as never }), 'chooseSubject')
    // A gift: whoever holds the slip activates it for their own subject and becomes its keeper.
    expect(await activateKit(await as(stranger), { code: c(6), secret, subject: { kind: 'animal', id: 's1' } })).toMatchObject({ code: c(6) })
    expect((await kitOf(c(6))).activatedBy).toBe(stranger.id)
  })

  it('stores only a hash, never readable through the API, and never in the trail', async () => {
    const secret = await packed(c(7))
    const stored = JSON.stringify(await payload.db.collections.kits!.find({}).lean())
    expect(stored).not.toContain(secret)
    expect(stored).not.toContain(secret.replace('-', ''))
    expect(JSON.stringify(await payload.db.collections['kit-events']!.find({}).lean())).not.toContain(secret.replace('-', ''))
    expect((await raw(c(7))).secretHash).toMatch(/^[a-f0-9]{64}$/)
    for (const who of [staffA, adminA, maintA, buyer]) {
      const doc = (await payload.find({ collection: 'kits', where: { code: { equals: c(7) } }, ...api(who) })).docs[0]!
      expect(doc).not.toHaveProperty('secretHash')
    }
    expect(await kitOf(c(7))).not.toHaveProperty('secretHash') // even with access overridden
    await expect(payload.update({ collection: 'kits', id: (await kitOf(c(7))).id, data: { secretHash: 'f'.repeat(64) } as never, ...api(maintA) })).resolves.toBeDefined()
    expect((await raw(c(7))).secretHash).not.toBe('f'.repeat(64)) // nobody writes it through the API
    // Issuing again cancels the old secret.
    const fresh = (await issueSecret(await as(staffA), { code: c(7) })).secret
    await kitErr(activateKit(await as(buyer), { code: c(7), secret, subject: { kind: 'animal', id: 'a1' } }), 'badSecret')
    await activateKit(await as(buyer), { code: c(7), secret: fresh, subject: { kind: 'animal', id: 'a1' } })
  })

  it('refuses secrets for kits that aren’t out with a buyer yet, or already used', async () => {
    await kitErr(issueSecret(await as(staffA), { code: c(8) }), 'slipTooLate') // in stock
    await kitErr(issueSecret(await as(staffA), { code: c(4) }), 'slipTooLate') // activated
    await kitErr(issueSecret(await as(staffA), { code: '999999000001' }), 'unknownKit')
  })
})

describe('status only through events', () => {
  it('ignores a status sent through the API and refuses one written straight to the collection', async () => {
    const kit = await kitOf(c(9))
    const updated = await payload.update({ collection: 'kits', id: kit.id, data: { status: 'released', notes: 'checked' } as never, ...api(maintA) })
    expect(updated).toMatchObject({ status: 'in-stock', notes: 'checked' })
    await expect(payload.update({ collection: 'kits', id: kit.id, data: { status: 'released' } as never, overrideAccess: true })).rejects.toThrow(/only through its events/)
    await expect(payload.create({ collection: 'kits', data: { code: '314100000009', lot: kit.lot, status: 'released', tenant: 'A' } as never, overrideAccess: true })).rejects.toThrow(/only through its events/)
    await expect(recordKitEvent(await as(staffA), kit, { type: 'note', set: { status: 'released' } })).rejects.toThrow(/can’t set the status/)
    await expect(recordKitEvent(await as(staffA), kit, { type: 'made-up' as never })).rejects.toThrow()
    expect((await kitOf(c(9))).status).toBe('in-stock')
    expect((await eventsOf(c(9))).map((e) => e.type)).toEqual(['received'])
  })

  it('moves the status with each event, so the trail explains it', async () => {
    const secret = await packed(c(11))
    await shipped(c(11))
    await activateKit(await as(buyer), { code: c(11), secret, subject: { kind: 'group', id: 'g1' } })
    await markSampled(await as(buyer), { code: c(11), confirmed: { steps: ['swab', 'seal'], at: '2026-11-10T12:00:00Z' } })
    expect((await eventsOf(c(11))).map((e) => e.type)).toEqual(['received', 'packed', 'slip-made', 'shipped', 'activated', 'sampled'])
    expect(await kitOf(c(11))).toMatchObject({ status: 'sampled', subjectKind: 'group', subjectId: 'g1', identifierLabel: 'Made-up Group #1' })
    expect((await eventsOf(c(11))).at(-1)!.details).toEqual({ confirmed: { steps: ['swab', 'seal'], at: '2026-11-10T12:00:00Z' } })
  })

  it('lets only the keeper mark an activated kit sampled, with a confirmed record that’s plain JSON', async () => {
    const secret = await packed(c(12))
    await kitErr(markSampled(await as(buyer), { code: c(12) }), 'notYourKit') // not activated yet
    await activateKit(await as(buyer), { code: c(12), secret, subject: { kind: 'animal', id: 'a1' } })
    await kitErr(markSampled(await as(stranger), { code: c(12) }), 'notYourKit')
    await kitErr(markSampled(await as(null), { code: c(12) }), 'signIn')
    await kitErr(markSampled(await as(buyer), { code: c(12), confirmed: ['not', 'a', 'record'] as never }), 'badConfirmed')
    await kitErr(markSampled(await as(buyer), { code: c(12), confirmed: { big: 'x'.repeat(30_000) } }), 'badConfirmed')
    // The subject provider is asked again: a subject the keeper no longer has can't be sampled.
    h.subjects.subjects.find((s) => s.id === 'a1')!.owner = stranger.id
    await kitErr(markSampled(await as(buyer), { code: c(12) }), 'notYourSubject')
    h.subjects.subjects.find((s) => s.id === 'a1')!.owner = buyer.id
    await markSampled(await as(buyer), { code: c(12) })
    await kitErr(markSampled(await as(buyer), { code: c(12) }), 'notActivated')
  })
})

describe('lots and codes that can’t change', () => {
  it('keeps a kit’s code and a lot’s number once set, and normalizes them', async () => {
    const kit = await kitOf(c(13))
    await expect(payload.update({ collection: 'kits', id: kit.id, data: { code: '275864999999' } as never, ...api(staffA) })).rejects.toThrow(/can’t change/)
    await expect(payload.update({ collection: 'kits', id: kit.id, data: { code: '275864999999' } as never, overrideAccess: true })).rejects.toThrow(/can’t change/)
    await expect(payload.create({ collection: 'kits', data: { code: '12', lot: kit.lot } as never, overrideAccess: true })).rejects.toThrow(/8 to 20 digits/)
    const lot = await payload.create({ collection: 'kit-lots', data: { lotNumber: ' 5150-52 ' } as never, ...api(staffA) })
    expect(lot.lotNumber).toBe('515052')
    await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { lotNumber: '515053' } as never, ...api(maintA) })).rejects.toThrow(/can’t change/)
    await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { lotNumber: '515053' } as never, overrideAccess: true })).rejects.toThrow(/can’t change/)
    await expect(payload.create({ collection: 'kit-lots', data: { lotNumber: '12' } as never, ...api(staffA) })).rejects.toThrow(/3 to 12 digits/)
    expect((await payload.update({ collection: 'kit-lots', id: lot.id, data: { notes: 'made-up' } as never, ...api(staffA) })).lotNumber).toBe('515052')
  })
})

describe('recall (fails closed)', () => {
  const R = '616161'
  const r = (n: number) => `${R}${String(n).padStart(6, '0')}`

  it('sets stock aside, takes packed kits out of their order, marks sold kits and notes sampled ones', async () => {
    await createLot(await as(staffA), { lotNumber: R, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 5 })
    await packed(r(1)) // packed, with a secret
    const s2 = await packed(r(2))
    await shipped(r(2)) // shipped, not used
    const s3 = await packed(r(3))
    await shipped(r(3))
    await activateKit(await as(buyer), { code: r(3), secret: s3, subject: { kind: 'animal', id: 'a1' } })
    await markSampled(await as(buyer), { code: r(3) }) // sampled before the recall
    // r(4), r(5): in stock

    await kitErr(recallLot(await as(staffA), { lotNumber: R, reason: '  ' }), 'recallReason')
    await recallLot(await as(staffA), { lotNumber: R, reason: 'Made-up contamination.' })
    await kitErr(recallLot(await as(staffA), { lotNumber: R, reason: 'again' }), 'alreadyRecalled')

    expect((await kitOf(r(4))).status).toBe('recalled')
    expect(await raw(r(1))).toMatchObject({ status: 'recalled', order: null, buyer: null, secretHash: null, secretIssuedAt: null, suggestedKind: null, suggestedId: null })
    expect((await kitOf(r(2))).status).toBe('recalled')
    expect((await kitOf(r(2))).buyer).toBe(buyer.id) // sold: kept, for a replacement
    await kitErr(activateKit(await as(buyer), { code: r(2), secret: s2, subject: { kind: 'animal', id: 'a1' } }), 'recalledCustomer')
    expect((await kitOf(r(3))).status).toBe('sampled')
    const note = (await eventsOf(r(3))).find((e) => e.type === 'note')
    expect(note?.note).toMatch(/recalled: Made-up contamination, after this kit was sampled/)
    expect((await eventsOf(r(4))).at(-1)).toMatchObject({ type: 'recalled', actor: staffA.id })
  })

  it('refuses activation when the lot was recalled behind the kit’s back', async () => {
    const S = '717171'
    const { lot } = await createLot(await as(staffA), { lotNumber: S, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    const secret = await packed(`${S}000001`)
    await payload.db.collections['kit-lots']!.updateOne({ _id: lot.id }, { $set: { recalled: true } })
    expect((await kitOf(`${S}000001`)).status).toBe('packed')
    await kitErr(activateKit(await as(buyer), { code: `${S}000001`, secret, subject: { kind: 'animal', id: 'a1' } }), 'recalledCustomer')
    await kitErr(issueSecret(await as(staffA), { code: `${S}000001` }), 'recalled')
  })

  it('refuses an expired lot', async () => {
    const E = '818181'
    const { lot } = await createLot(await as(staffA), { lotNumber: E, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 1 })
    const secret = await packed(`${E}000001`)
    await payload.update({ collection: 'kit-lots', id: lot.id, data: { expiresOn: '2020-01-01' } as never, overrideAccess: true })
    await kitErr(activateKit(await as(buyer), { code: `${E}000001`, secret, subject: { kind: 'animal', id: 'a1' } }), 'expiredCustomer')
  })

  it('can’t be lifted by staff or admins, or by a script with no person; a maintainer can, and kits stay recalled', async () => {
    const lot = (await payload.find({ collection: 'kit-lots', where: { and: [{ lotNumber: { equals: R } }, { tenant: { equals: 'A' } }] }, overrideAccess: true })).docs[0]!
    for (const who of [staffA, adminA]) await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: false } as never, ...api(who) })).rejects.toThrow(/can’t be lifted/)
    await expect(payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: false } as never, overrideAccess: true })).rejects.toThrow(/can’t be lifted/)
    expect((await payload.findByID({ collection: 'kit-lots', id: lot.id, overrideAccess: true })).recalled).toBe(true)
    await payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: false } as never, ...api(maintA) })
    expect((await payload.findByID({ collection: 'kit-lots', id: lot.id, overrideAccess: true })).recalled).toBe(false)
    expect((await kitOf(r(4))).status).toBe('recalled')
  })

  it('applies a recall ticked in the admin in the same save', async () => {
    const T = '919191'
    const { lot } = await createLot(await as(staffA), { lotNumber: T, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 2 })
    await payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: true, recallReason: 'Made-up' } as never, ...api(staffA) })
    expect([(await kitOf(`${T}000001`)).status, (await kitOf(`${T}000002`)).status]).toEqual(['recalled', 'recalled'])
  })
})

describe('a provider that throws rolls the whole action back', () => {
  it('leaves no event and no change when a subject field’s hook throws mid-activation', async () => {
    const secret = await packed(c(14))
    flags.failWrite = true
    await expect(activateKit(await as(buyer), { code: c(14), secret, subject: { kind: 'animal', id: 'a1' } })).rejects.toThrow(/made-up provider failure/)
    flags.failWrite = false
    expect((await eventsOf(c(14))).map((e) => e.type)).toEqual(['received', 'packed', 'slip-made'])
    expect(await raw(c(14))).toMatchObject({ status: 'packed' })
    expect((await raw(c(14))).secretHash).toMatch(/^[a-f0-9]{64}$/) // the secret still works
    await activateKit(await as(buyer), { code: c(14), secret, subject: { kind: 'animal', id: 'a1' } })
  })

  it('takes back a provider’s own writes when it throws after making them', async () => {
    const secret = await packed(c(17))
    flags.writeThenThrow = true
    await expect(activateKit(await as(buyer), { code: c(17), secret, subject: { kind: 'animal', id: 'a1' } })).rejects.toThrow(/made-up provider failure/)
    flags.writeThenThrow = false
    expect((await payload.find({ collection: 'orders', where: { ref: { equals: 'provider-write' } }, overrideAccess: true })).totalDocs).toBe(0)
    expect(await raw(c(17))).toMatchObject({ status: 'packed' })
  })

  it('leaves the kit as it was when canSample throws', async () => {
    flags.failCanSample = true
    await expect(markSampled(await as(buyer), { code: c(14) })).rejects.toThrow(/made-up provider failure/)
    flags.failCanSample = false
    expect((await kitOf(c(14))).status).toBe('activated')
    expect((await eventsOf(c(14))).map((e) => e.type)).not.toContain('sampled')
  })

  it('runs in the caller’s transaction, so the caller’s rollback undoes an activation', async () => {
    const secret = await packed(c(15))
    const req = await as(buyer)
    await initTransaction(req)
    await activateKit(req, { code: c(15), secret, subject: { kind: 'animal', id: 'a1' } })
    await killTransaction(req)
    expect(await raw(c(15))).toMatchObject({ status: 'packed' })
    expect((await raw(c(15))).activatedBy ?? null).toBeNull()
    expect((await eventsOf(c(15))).map((e) => e.type)).not.toContain('activated')
  })
})

describe('activation races (security read of fee0a58)', () => {
  async function race(code: string) {
    const secret = await packed(code)
    const racers = await Promise.all([1, 2, 3, 4].map(async (n) => {
      const p = await person(payload, 'A')
      h.subjects.add({ kind: 'animal', id: `race-${code}-${n}`, owner: p.id, name: `Made-up Racer ${n}` })
      return p
    }))
    flags.slowSample = true
    try {
      const results = await Promise.allSettled(racers.map(async (p, n) => activateKit(await as(p), { code, secret, subject: { kind: 'animal', id: `race-${code}-${n + 1}` } })))
      return { racers, results }
    } finally {
      flags.slowSample = false
    }
  }

  it('gives exactly one keeper when several activate at once, even with transactions off', async () => {
    const db = payload.db as unknown as { beginTransaction: () => Promise<unknown> }
    const real = db.beginTransaction
    db.beginTransaction = async () => null
    try {
      const { racers, results } = await race(c(21))
      const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [racers[i]!] : []))
      expect(won).toHaveLength(1)
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(KitError)
        expect(((r as PromiseRejectedResult).reason as KitError).code).toBe('busy')
        expect(((r as PromiseRejectedResult).reason as KitError).message).toBe('Someone else just did this; refresh and check.')
      }
      expect(idOfKeeper(await raw(c(21)))).toBe(String(won[0]!.id))
      expect((await eventsOf(c(21))).filter((e) => e.type === 'activated')).toHaveLength(1)
    } finally {
      db.beginTransaction = real
    }
  })

  it('gives the losers busy, not a general error, with transactions on', async () => {
    const { racers, results } = await race(c(22))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((r) => r.status === 'rejected')) expect(((r as PromiseRejectedResult).reason as KitError).code).toBe('busy')
    const winner = racers[results.findIndex((r) => r.status === 'fulfilled')]!
    expect(idOfKeeper(await raw(c(22)))).toBe(String(winner.id))
    expect((await eventsOf(c(22))).filter((e) => e.type === 'activated')).toHaveLength(1)
  })
})
const idOfKeeper = (doc: Record<string, unknown>) => String(doc.activatedBy)

describe('no leaks to a stranger', () => {
  it('says nothing about a kit’s buyer, secret or subject to someone who isn’t its keeper', async () => {
    // The stranger holds a kit given to them (kit 6), so they read that one, without who bought it.
    const secret = await packed(c(16))
    await activateKit(await as(buyer), { code: c(16), secret, subject: { kind: 'animal', id: 'a1' } })
    const seen: unknown[] = []
    seen.push((await payload.find({ collection: 'kits', pagination: false, ...api(stranger) })).docs)
    seen.push(await payload.findByID({ collection: 'kits', id: (await kitOf(c(16))).id, ...api(stranger) }).catch((e: Error) => e.message))
    seen.push(await payload.find({ collection: 'kit-events', ...api(stranger) }).catch((e: Error) => e.message))
    for (const run of [
      async () => activateKit(await as(stranger), { code: c(16), secret: 'AAAAA-AAAAA', subject: { kind: 'animal', id: 's1' } }),
      async () => activateKit(await as(stranger), { code: c(16), secret, subject: { kind: 'animal', id: 's1' } }),
      async () => markSampled(await as(stranger), { code: c(16) }),
    ])
      seen.push(await run().catch((e: KitError) => ({ code: e.code, message: e.message, vars: e.vars })))
    const text = JSON.stringify(seen)
    for (const secretThing of [buyer.id, buyer.email, 'Made-up Shelly', '"a1"', secret, orderA]) expect(text).not.toContain(secretThing)
    // A stranger's own activation with the same (used) secret gets the same answer as a wrong one.
    expect(seen[3]).toEqual(seen[4])
  })
})
