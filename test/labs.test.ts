import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  batchKit,
  checkInKit,
  retryKitNotices,
  confirmBatchReceived,
  createBatch,
  createLot,
  fastaProblem,
  findKit,
  KitError,
  labPortal,
  labsFor,
  matchResults,
  receiveResult,
  recordKitEvent,
  resultView,
  sha256Hex,
  shipBatch,
  unbatchKit,
} from '../src/index.js'
import { fakeResults, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// Made-up people, hubs, labs and kits on two made-up sites, A and B. Nothing here is real.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let revokedLab: Person, staffA: Person, keeper: Person, otherKeeper: Person, buyer: Person, stranger: Person, labUser: Person, otherLabUser: Person, labUserB: Person, staffB: Person
let labA: string, labA2: string, hubA: string, hubA2: string
const res = fakeResults()
const notices: { kind: string; to: Record<string, unknown>; data: Record<string, unknown>; batchStatus?: string }[] = []
const flags = { notifyThrows: false, arrivedThrows: false }
/** The keepers' "your sample arrived" notices, kept apart from the lab's. */
const arrived: { kind: string; to: Record<string, unknown>; data: Record<string, unknown> }[] = []
const LOT = '626262'
const c = (n: number) => `${LOT}${String(n).padStart(6, '0')}`
const HUB_ADDRESS = { kind: 'street', name: 'Made-up Hub', line1: '1 Example Way', city: 'Testville', state: 'AZ', postalCode: '85000' }
let serial = 0

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
const fasta = (code: string, seq = 'ACGTACGTACGTNNACGT') => new TextEncoder().encode(`>${code} made-up\n${seq}\n`)

/** A kit the keeper activated (bought by `buyer`, a gift) for subject s1, sampled unless `sampled` is false. */
async function keptKit(opts: { sampled?: boolean; hub?: string } = {}) {
  const code = c(++serial)
  const k = await kit(code)
  const req = await as(staffA)
  await recordKitEvent(req, k, { type: 'activated', set: { buyer: buyer.id, activatedBy: keeper.id, activatedAt: new Date().toISOString(), subjectKind: 'animal', subjectId: 's1', ...(opts.hub ? { hub: opts.hub } : {}) } })
  if (opts.sampled !== false) await recordKitEvent(req, k, { type: 'sampled' })
  return code
}
/** A kit checked in at the hub. */
async function returnedKit() {
  const code = await keptKit()
  await checkInKit(await as(staffA), { code })
  return code
}
/** A batch for lab A with these kits, shipped. */
async function shippedBatch(codes: string[]) {
  const batch = await createBatch(await as(staffA), { lab: labA, size: codes.length })
  for (const code of codes) await batchKit(await as(staffA), { batch: String(batch.id), code })
  await shipBatch(await as(staffA), { batch: String(batch.id), tracking: ['9400 1000 0000 0000 0000 99'], oddSizeOk: true })
  return String(batch.id)
}

beforeAll(async () => {
  h = await startPayload((o) => ({
    ...o,
    // Per site, from the site's own data: never from the page.
    site: ({ site }) => (site === 'A' ? { name: 'Made-up Site', origin: 'https://kits.example.invalid' } : null),
    // A lab user is one of the site's people whose lab role hasn't been taken away (made up: `revokedLab` has lost it).
    scope: { ...o.scope!, isLabUser: (req, lab) => (req.user as { site?: string } | null)?.site === (lab as { tenant?: string }).tenant && String(req.user?.id) !== String(revokedLab?.id) },
    results: { ...res.results, check: fastaProblem },
    tests: [{ label: 'Made-up test A', value: 'test-a', marker: 'marker-a' }, { label: 'Made-up test B', value: 'test-b' }],
    notify: async ({ kind, to, data, req }) => {
      if (kind === 'kit-arrived') {
        if (flags.arrivedThrows) throw new Error('made-up notify failure')
        arrived.push({ kind, to: to as never, data })
        return
      }
      if (flags.notifyThrows) throw new Error('made-up notify failure')
      // Read without the action's transaction: the batch must already be committed as shipped.
      const batch = data.batch ? await req.payload.findByID({ collection: 'lab-batches', id: String(data.batch), overrideAccess: true, depth: 0 }) : null
      notices.push({ kind, to: to as never, data, batchStatus: (batch as { status?: string } | null)?.status })
    },
  }))
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  keeper = await person(payload, 'A')
  otherKeeper = await person(payload, 'A')
  buyer = await person(payload, 'A')
  stranger = await person(payload, 'A')
  labUser = await person(payload, 'A')
  otherLabUser = await person(payload, 'A')
  labUserB = await person(payload, 'B')
  revokedLab = await person(payload, 'A')
  staffB = await person(payload, 'B', 'staff')
  h.subjects.add({ kind: 'animal', id: 's1', owner: keeper.id, name: 'Made-up Pebble' })
  const sys = { overrideAccess: true } as const
  hubA = String((await payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up Hub', address: HUB_ADDRESS, defaultReturn: true, operators: [staffA.id] } as never, ...sys })).id)
  await payload.create({ collection: 'hubs', data: { tenant: 'B', name: 'Made-up Hub B', address: HUB_ADDRESS, defaultReturn: true } as never, ...sys })
  hubA2 = String((await payload.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up Hub Two', address: HUB_ADDRESS } as never, ...sys })).id)
  await payload.create({ collection: 'box-types', data: { tenant: 'A', name: 'Outer 4', kitsPerBox: 4 } as never, ...sys })
  labA = String((await payload.create({ collection: 'labs', data: { tenant: 'A', name: 'Made-up Lab', batchSizes: [24, 48], contacts: [{ email: 'lab-notices@example.invalid' }], portalUsers: [labUser.id, labUserB.id, revokedLab.id] } as never, ...sys })).id)
  labA2 = String((await payload.create({ collection: 'labs', data: { tenant: 'A', name: 'Made-up Other Lab', portalUsers: [otherLabUser.id] } as never, ...sys })).id)
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 80 })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

beforeEach(() => {
  Object.assign(flags, { notifyThrows: false, arrivedThrows: false })
  notices.length = 0
  arrived.length = 0
})

describe('hub check-in', () => {
  it('checks in activated kits only, scanned or typed, with warnings, for kit staff of the site', async () => {
    const neverActivated = c(++serial)
    await kitErr(checkInKit(await as(staffA), { code: neverActivated }), 'notActivatedYet')
    const sampled = await keptKit()
    // Typed with spaces, as from the tube.
    expect(await checkInKit(await as(staffA), { code: `${sampled.slice(0, 6)} ${sampled.slice(6)}` })).toMatchObject({ result: 'checked-in', warnings: [], hub: 'Made-up Hub' })
    expect(await checkInKit(await as(staffA), { code: sampled })).toMatchObject({ result: 'already' })
    expect((await kit(sampled)).status).toBe('returned')
    expect(String((await kit(sampled)).hub)).toBe(hubA)
    const notSampled = await keptKit({ sampled: false })
    expect(await checkInKit(await as(staffA), { code: notSampled })).toMatchObject({ result: 'checked-in', warnings: ['notSampled'] })
    const elsewhere = await keptKit({ hub: hubA2 })
    expect(await checkInKit(await as(staffA), { code: elsewhere })).toMatchObject({ warnings: ['otherHub'] })
    await kitErr(checkInKit(await as(staffA), { code: '999999000001' }), 'unknownKit')
    await kitErr(checkInKit(await as(staffA), { code: 'not a code' }), 'notACode')
    await kitErr(checkInKit(await as(staffA), { code: await keptKit(), hub: 'nope' }), 'noHub')
    // Refusals: only kit staff, and only their own site's kits.
    const waiting = await keptKit()
    for (const who of [keeper, buyer, stranger, labUser, null]) await kitErr(checkInKit(await as(who), { code: waiting }), 'notStaff')
    await kitErr(checkInKit(await as(staffB), { code: waiting }), 'unknownKit')
    // A kit already at the lab can't be checked in again.
    const atLab = await keptKit()
    await recordKitEvent(await as(staffA), await kit(atLab), { type: 'at-lab' })
    await kitErr(checkInKit(await as(staffA), { code: atLab }), 'cantCheckIn')
    expect((await kit(waiting)).status).toBe('sampled')
  })
})

describe('the keeper’s "your sample arrived"', () => {
  const rowsFor = async (code: string) => (await payload.find({ collection: 'kit-notices', where: { kits: { in: [(await kit(code)).id] } }, overrideAccess: true, depth: 0, pagination: false })).docs as unknown as Record<string, any>[]
  it('tells the keeper, not the gift’s buyer, once per kit, at the check-in scan, with the kit code only', async () => {
    const code = await keptKit()
    expect(arrived).toHaveLength(0)
    await checkInKit(await as(staffA), { code })
    expect(arrived).toEqual([{ kind: 'kit-arrived', to: { user: keeper.id, order: null }, data: { event: 'arrived', leg: 'return', kits: 1, codes: [code] } }])
    // Scanned again: nothing new.
    await checkInKit(await as(staffA), { code })
    expect(arrived).toHaveLength(1)
    expect(JSON.stringify(arrived)).not.toContain(String(buyer.id))
    expect(JSON.stringify(arrived)).not.toMatch(/Made-up Pebble|Example Way|Made-up Hub|marker-a/)
    expect((await rowsFor(code)).map((r) => [r.status, r.attempts, r.delivery])).toEqual([['sent', 1, 'sent']])
  })

  it('sends one that failed on the next scan, or the daily run, and never twice', async () => {
    const [one, two] = [await keptKit(), await keptKit()]
    flags.arrivedThrows = true
    await checkInKit(await as(staffA), { code: one })
    await checkInKit(await as(staffA), { code: two })
    expect(arrived).toHaveLength(0)
    expect((await rowsFor(one)).map((r) => [r.status, r.attempts])).toEqual([['failed', 1]])
    flags.arrivedThrows = false
    await checkInKit(await as(staffA), { code: one })
    expect(arrived.map((n) => n.data.codes)).toEqual([[one]])
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 1, failed: 0 })
    expect(arrived.map((n) => n.data.codes)).toEqual([[one], [two]])
    expect(await retryKitNotices(await as(null))).toEqual({ sent: 0, failed: 0 })
    expect(arrived).toHaveLength(2)
  })
})

describe('lab batches', () => {
  it('fills a batch by scan, ships it, and sends the lab’s notice only after the commit, with codes and markers only', async () => {
    const [a, b] = [await returnedKit(), await returnedKit()]
    const notIn = await keptKit()
    const batch = await createBatch(await as(staffA), { lab: labA, size: 2 })
    expect(batch).toMatchObject({ number: 1, size: 2, status: 'assembling', title: 'Batch 1 · Made-up Lab' })
    const id = String(batch.id)
    await kitErr(batchKit(await as(staffA), { batch: id, code: notIn }), 'notCheckedIn')
    await batchKit(await as(staffA), { batch: id, code: a })
    await kitErr(batchKit(await as(staffA), { batch: id, code: a }), 'alreadyInBatch')
    await unbatchKit(await as(staffA), { batch: id, code: a })
    await batchKit(await as(staffA), { batch: id, code: a })
    expect(await batchKit(await as(staffA), { batch: id, code: b })).toMatchObject({ count: 2, size: 2 })
    const second = await createBatch(await as(staffA), { lab: labA })
    expect(second).toMatchObject({ number: 2, size: 24 })
    await kitErr(batchKit(await as(staffA), { batch: String(second.id), code: b }), 'inOtherBatch')
    await kitErr(batchKit(await as(staffA), { batch: id, code: await returnedKit() }), 'batchFull')
    for (const who of [labUser, keeper, stranger, null]) {
      await kitErr(createBatch(await as(who), { lab: labA }), 'notStaff')
      await kitErr(batchKit(await as(who), { batch: id, code: a }), 'notStaff')
      await kitErr(shipBatch(await as(who), { batch: id, tracking: ['9400100000000000000001'] }), 'notStaff')
    }
    await kitErr(createBatch(await as(staffB), { lab: labA }), 'noLab')
    await kitErr(batchKit(await as(staffB), { batch: id, code: a }), 'noBatch')

    await kitErr(shipBatch(await as(staffA), { batch: id, tracking: [] }), 'noTracking')
    await kitErr(shipBatch(await as(staffA), { batch: id, tracking: ['9400 1000 0000 0000 0000 01'] }), 'oddSize')
    expect(notices).toHaveLength(0)
    expect(await shipBatch(await as(staffA), { batch: id, tracking: ['9400 1000 0000 0000 0000 01'], oddSizeOk: true })).toEqual({ kits: 2, delivery: 'sent' })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'lab-batch-shipped', to: { user: null, order: null, lab: labA, emails: ['lab-notices@example.invalid'] }, batchStatus: 'shipped' })
    const shipped = await payload.findByID({ collection: 'lab-batches', id, depth: 0, overrideAccess: true })
    expect(shipped).toMatchObject({ status: 'shipped', trackingNumbers: ['9400100000000000000001'], notice: { delivery: 'sent', to: ['lab-notices@example.invalid'] } })
    const notice = (shipped as unknown as { notice: { text: string; csv: string; subject: string } }).notice
    expect(notice.subject).toMatch(/^Made-up Site: batch 1 shipped, 2 samples/)
    expect(notice.text).toContain('https://kits.example.invalid/lab')
    expect(notice.csv.split('\n')).toEqual(['kit_code,marker,batch', `${a},marker-a,1`, `${b},marker-a,1`])
    // The lab learns kit codes and markers, never keepers, buyers, subjects or addresses.
    const said = JSON.stringify({ notice, data: notices[0]!.data })
    for (const secret of [keeper.id, keeper.email, buyer.id, buyer.email, 's1', 'Made-up Pebble', '1 Example Way']) expect(said).not.toContain(secret)
    await kitErr(batchKit(await as(staffA), { batch: id, code: await returnedKit() }), 'batchClosed')
    await kitErr(shipBatch(await as(staffA), { batch: id, tracking: ['9400100000000000000009'], oddSizeOk: true }), 'batchClosed')
    // Still "back at the hub" for the keeper until the lab confirms.
    expect((await kit(a)).status).toBe('returned')
  })

  it('records a failed notice or a lab with no contacts on the batch, and ships either way', async () => {
    flags.notifyThrows = true
    const failed = await createBatch(await as(staffA), { lab: labA, size: 1 })
    await batchKit(await as(staffA), { batch: String(failed.id), code: await returnedKit() })
    expect(await shipBatch(await as(staffA), { batch: String(failed.id), tracking: ['9400100000000000000002'], oddSizeOk: true })).toEqual({ kits: 1, delivery: 'failed' })
    expect(await payload.findByID({ collection: 'lab-batches', id: failed.id, depth: 0, overrideAccess: true })).toMatchObject({ status: 'shipped', notice: { delivery: 'failed' } })
    flags.notifyThrows = false
    const silent = await createBatch(await as(staffA), { lab: labA2, size: 1 })
    await batchKit(await as(staffA), { batch: String(silent.id), code: await returnedKit() })
    expect(await shipBatch(await as(staffA), { batch: String(silent.id), tracking: ['9400100000000000000003'], oddSizeOk: true })).toEqual({ kits: 1, delivery: 'no-contacts' })
    expect(notices).toHaveLength(0)
  })
})

describe('the lab portal', () => {
  it('lets only the lab’s own portal users and kit staff act for it, and shows them codes, statuses and markers only', async () => {
    const codes = [await returnedKit(), await returnedKit()]
    const batch = await shippedBatch(codes)
    expect(await labsFor(await as(labUser))).toEqual([{ id: labA, name: 'Made-up Lab' }])
    expect(await labsFor(await as(otherLabUser))).toEqual([{ id: labA2, name: 'Made-up Other Lab' }])
    expect(await labsFor(await as(stranger))).toEqual([])
    // Listed on the lab, but from site B: scope.isLabUser says no.
    expect(await labsFor(await as(labUserB))).toEqual([])
    // Listed on the lab and on its site, but scope.isLabUser says no.
    expect(await labsFor(await as(revokedLab))).toEqual([])
    for (const who of [otherLabUser, labUserB, revokedLab, keeper, stranger, null]) {
      await kitErr(confirmBatchReceived(await as(who), { batch }), 'notLab')
      await kitErr(labPortal(await as(who), { lab: labA }), 'notLab')
      await kitErr(matchResults(await as(who), { lab: labA, items: [] }), 'notLab')
    }
    // Another site's staff, and a batch that doesn't exist: the same answer.
    await kitErr(confirmBatchReceived(await as(staffB), { batch }), 'notLab')
    await kitErr(confirmBatchReceived(await as(labUser), { batch: '000000000000000000000000' }), 'notLab')
    await kitErr(labPortal(await as(staffB), { lab: labA }), 'notLab')
    const unshipped = await createBatch(await as(staffA), { lab: labA, size: 1 })
    await kitErr(confirmBatchReceived(await as(labUser), { batch: String(unshipped.id) }), 'batchNotShipped')
    expect(await confirmBatchReceived(await as(labUser), { batch })).toEqual({ kits: 2, already: false })
    expect(await confirmBatchReceived(await as(labUser), { batch })).toEqual({ kits: 0, already: true })
    expect((await kit(codes[0]!)).status).toBe('at-lab')
    const view = await labPortal(await as(labUser), { lab: labA })
    const mine = view.batches.find((b) => b.id === batch)!
    expect(mine.kits).toEqual(codes.map((code) => ({ code, status: 'at-lab', marker: 'marker-a' })))
    // Only this lab's batches: none sent to the other lab.
    const elsewhere = (await payload.find({ collection: 'lab-batches', where: { lab: { equals: labA2 } }, overrideAccess: true, depth: 0 })).docs.map((b) => String(b.id))
    expect(elsewhere.length).toBeGreaterThan(0)
    expect(view.batches.filter((b) => elsewhere.includes(b.id))).toEqual([])
    const seen = JSON.stringify(view)
    for (const secret of [keeper.id, keeper.email, buyer.id, buyer.email, 's1', 'Made-up Pebble', '1 Example Way', 'lab-notices@example.invalid']) expect(seen).not.toContain(secret)
  })

  it('refuses a lab user every kit record through the API: kits, the trail, batches, labs, hubs and refunds', async () => {
    const req = await as(labUser)
    const user = { ...labUser, collection: 'users' }
    expect((await payload.find({ collection: 'kits', overrideAccess: false, user, req, depth: 0 })).docs).toHaveLength(0)
    for (const collection of ['kit-events', 'lab-batches', 'labs', 'hubs', 'kit-lots', 'return-labels', 'kit-refunds', 'kit-notices'] as const)
      await expect(payload.find({ collection, overrideAccess: false, user, req, depth: 0 })).rejects.toThrow(/not allowed/i)
  })
})

describe('results', () => {
  it('matches files by name or header, and previews without writing anything', async () => {
    const [a, b] = [await returnedKit(), await returnedKit()]
    const notSent = await returnedKit()
    await shippedBatch([a, b])
    const events = async () => (await payload.count({ collection: 'kit-events', overrideAccess: true })).totalDocs
    const before = await events()
    const m = await matchResults(await as(labUser), {
      lab: labA,
      items: [
        { name: `${a}.fasta`, header: '>sample 1' },
        { name: 'well-B7.fasta', header: `>${b} made-up` },
        { name: `${a}.fasta`, header: `>${b}` },
        { name: '999999000001.fa', header: null },
        { name: 'notes.fasta', header: '>no code here' },
        { name: `${a}.pdf`, header: null },
        { name: `${notSent}.fasta`, header: null },
        { name: `${b}-again.fasta`, header: null },
        { name: `${a}.fasta`, header: null, size: 2_000_000 },
      ],
    })
    expect(m.map((x) => [x.code, x.outcome, x.reason ?? null])).toEqual([
      [a, 'ready', null],
      [b, 'ready', null],
      [null, 'unmatched', 'conflict'],
      ['999999000001', 'unmatched', 'notThisLab'],
      [null, 'unmatched', 'noCode'],
      [null, 'unmatched', 'fileType'],
      [notSent, 'unmatched', 'notThisLab'],
      [b, 'rerun', null],
      [null, 'unmatched', 'tooBig'],
    ])
    // Another lab's portal user can't see this lab's kits at all.
    expect((await matchResults(await as(otherLabUser), { lab: labA2, items: [{ name: `${a}.fasta` }] }))[0]).toMatchObject({ outcome: 'unmatched', reason: 'notThisLab' })
    expect(await events()).toBe(before)
    // A kit sent to this lab but lost since can't take a result.
    await recordKitEvent(await as(staffA), await kit(b), { type: 'lost' })
    expect((await matchResults(await as(labUser), { lab: labA, items: [{ name: `${b}.fasta` }] }))[0]).toMatchObject({ outcome: 'unmatched', reason: 'notReady', status: 'lost' })
  })

  it('takes a result through results.accept, records it, and treats repeats, re-runs and refusals right', async () => {
    const [a, b] = [await returnedKit(), await returnedKit()]
    const batch = await shippedBatch([a, b])
    const data = fasta(a)
    expect(await receiveResult(await as(labUser), { lab: labA, name: 'run1.fasta', data })).toEqual({ result: 'received', code: a, rerun: false })
    expect((await kit(a)).status).toBe('results-in')
    // One of two kits has a result: the batch isn't complete yet.
    expect((await payload.findByID({ collection: 'lab-batches', id: batch, depth: 0, overrideAccess: true })).status).toBe('shipped')
    const ev = (await payload.find({ collection: 'kit-events', where: { and: [{ kit: { equals: (await kit(a)).id } }, { type: { in: ['at-lab', 'results-in'] } }] }, sort: 'createdAt', overrideAccess: true, depth: 0 })).docs
    expect(ev.map((e) => e.type)).toEqual(['at-lab', 'results-in'])
    expect(ev[1]).toMatchObject({ source: 'portal', details: { sha256: sha256Hex(data), rerun: false, status: 'ready' } })
    expect(String(ev[1]!.actor)).toBe(labUser.id)
    expect(res.files.filter((f) => f.sha256 === sha256Hex(data))).toHaveLength(1)
    // The same file again: nothing more. Another file for the same kit: a re-run.
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${a}.fasta`, data })).toEqual({ result: 'already', code: a })
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${a}.fasta`, data: fasta(a, 'ACGTTTTTACGT') })).toEqual({ result: 'received', code: a, rerun: true })
    // Refusals are recorded on the kit for the lab and staff, and never reach results.accept.
    const before = res.files.length
    const two = new TextEncoder().encode(`>${b}\nACGT\n>${b} again\nACGT\n`)
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${b}.fasta`, data: two })).toMatchObject({ result: 'refused', code: b, message: expect.stringMatching(/2 records/) })
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${b}.fasta`, data: new Uint8Array() })).toMatchObject({ result: 'refused', message: 'The file is empty.' })
    expect(res.files.length).toBe(before)
    // results.accept answering "failed" is a refusal too.
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${b}.fasta`, data: new TextEncoder().encode(`>${b} MADE-UP-FAIL\nACGT\n`) })).toMatchObject({ result: 'refused', message: 'The made-up check refused this file.' })
    const refusals = await payload.count({ collection: 'kit-events', where: { and: [{ kit: { equals: (await kit(b)).id } }, { type: { equals: 'result-refused' } }] }, overrideAccess: true })
    expect(refusals.totalDocs).toBe(3)
    expect((await kit(b)).status).toBe('returned')
    // Other people can't upload for this lab.
    for (const who of [otherLabUser, labUserB, keeper, stranger, null]) await kitErr(receiveResult(await as(who), { lab: labA, name: `${b}.fasta`, data: fasta(b) }), 'notLab')
    // The batch is complete once every kit in it has a result.
    expect(await receiveResult(await as(labUser), { lab: labA, name: `${b}.fasta`, data: fasta(b) })).toMatchObject({ result: 'received' })
    expect((await payload.findByID({ collection: 'lab-batches', id: batch, depth: 0, overrideAccess: true })).status).toBe('complete')
  })

  it('writes nothing when results.accept throws', async () => {
    const a = await returnedKit()
    await shippedBatch([a])
    const trail = async () => (await payload.count({ collection: 'kit-events', where: { kit: { equals: (await kit(a)).id } }, overrideAccess: true })).totalDocs
    const before = await trail()
    res.throwNext()
    await expect(receiveResult(await as(labUser), { lab: labA, name: `${a}.fasta`, data: fasta(a) })).rejects.toThrow(/made-up results failure/)
    expect(await trail()).toBe(before)
    expect((await kit(a)).status).toBe('returned')
  })

  it('shows a result to the keeper and kit staff only: never a stranger, another keeper, the gift’s buyer, a lab or another site', async () => {
    const a = await returnedKit()
    await shippedBatch([a])
    await receiveResult(await as(labUser), { lab: labA, name: `${a}.fasta`, data: fasta(a) })
    // A made-up hash stored on the kit, as an issued secret would be.
    await payload.db.updateOne({ collection: 'kits', id: (await kit(a)).id, data: { secretHash: 'made-up-hash' } } as never)
    const asked = res.state.views
    for (const who of [stranger, otherKeeper, buyer, labUser, staffB, null]) expect(await resultView(await as(who), { code: a })).toBeNull()
    // The provider wasn't even asked for them.
    expect(res.state.views).toBe(asked)
    expect(await resultView(await as(keeper), { code: a })).toMatchObject({ status: 'ready', summary: `made-up result for kit ${a}` })
    expect(await resultView(await as(staffA), { code: a })).toMatchObject({ status: 'ready' })
    // The provider never gets the kit's secret hash.
    expect(res.state.lastKitFields).toContain('code')
    expect(res.state.lastKitFields).not.toContain('secretHash')
    expect(await resultView(await as(keeper), { code: '999999000001' })).toBeNull()
  })

  it('never hands a lab user a keeper’s name or a result, whatever it asks', async () => {
    const a = await returnedKit()
    const batch = await shippedBatch([a])
    const req = async () => as(labUser)
    const said = JSON.stringify([
      await labPortal(await req(), { lab: labA }),
      await matchResults(await req(), { lab: labA, items: [{ name: `${a}.fasta` }] }),
      await confirmBatchReceived(await req(), { batch }),
      await receiveResult(await req(), { lab: labA, name: `${a}.fasta`, data: fasta(a) }),
      await resultView(await req(), { code: a }),
    ])
    for (const secret of [keeper.id, keeper.email, buyer.id, buyer.email, 's1', 'Made-up Pebble', 'made-up result']) expect(said).not.toContain(secret)
  })
})
