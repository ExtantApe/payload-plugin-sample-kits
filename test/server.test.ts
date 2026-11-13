import type { Config, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLot, findKit, KIT_COLLECTION_SLUGS, recordKitEvent, seedKitStory } from '../src/index.js'
import {
  activatePage,
  batchesPage,
  batchPage,
  getReturnLabel,
  kitsHomePage,
  labPage,
  myKitPage,
  myOrderPage,
  myTestsPage,
  packingPage,
  packOrderPage,
  previewResultFiles,
  returnsPage,
  scanBatch,
  scanCheckIn,
  scanLookup,
  scanPack,
  scanReceive,
  submitActivation,
  submitBatchReceived,
  submitHelp,
  submitLot,
  submitNewBatch,
  submitRecall,
  serve,
  submitResultFile,
  submitSampled,
  submitShip,
  submitSlip,
  type ServerResult,
} from '../src/server/index.js'
import { fakeResults, fakeShipping, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// The pages' server functions on Payload with an in-memory MongoDB. A made-up seed story on made-up site A gives the
// data; people, subjects and addresses are all made up.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, staffB: Person, keeper: Person, otherKeeper: Person, labPerson: Person, stranger: Person, giftBuyer: Person, giftKeeper: Person
let lots: string[] = []
const res = fakeResults()
const ship = fakeShipping()
const flags = { viewThrows: false, translate: false }
const MARK = 'seeded'
const as = (u: Person | null) => reqAs(payload, u as never)
const code = (lot: string, n: number) => `${lot}${String(n).padStart(6, '0')}`
let giftCode = ''
let bareGiftCode = ''
let packedForCode = ''
let giftOrder = ''

const addMarker = (config: Config): Config => ({
  ...config,
  collections: (config.collections ?? []).map((c) => ((KIT_COLLECTION_SLUGS as readonly string[]).includes(c.slug) || c.slug === 'orders' ? { ...c, fields: [...c.fields, { name: MARK, type: 'checkbox', index: true }] } : c)),
})

function ok<T>(r: ServerResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  // Every answer must survive JSON unchanged: pages can only take plain data.
  expect(JSON.parse(JSON.stringify(r.data))).toEqual(r.data)
  return r.data
}
function refused<T>(r: ServerResult<T>, code: string) {
  expect(r.ok, `expected refusal ${code}`).toBe(false)
  if (r.ok) throw new Error('unreachable')
  expect(r.error.code).toBe(code)
  expect(r.error.message.length).toBeGreaterThan(10)
  return r.error
}

beforeAll(async () => {
  h = await startPayload(
    (o) => ({
      ...o,
      adapters: { seed: { allow: () => true }, shipping: ship.adapter },
      site: { name: 'Made-up Site', origin: 'https://kits.example.test' },
      results: {
        ...res.results,
        view: async (args) => {
          if (flags.viewThrows) throw new Error('made-up provider failure with private details: keeper@example.test')
          return res.results.view(args)
        },
      },
      i18n: { t: (key) => (flags.translate && key === 'sampleKits.errors.notStaff' ? 'Translated: staff only.' : key) },
    }),
    { plugins: [addMarker] },
  )
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  keeper = await person(payload, 'A')
  otherKeeper = await person(payload, 'A')
  labPerson = await person(payload, 'A')
  stranger = await person(payload, 'A')
  giftBuyer = await person(payload, 'A')
  giftKeeper = await person(payload, 'A')
  h.subjects.add({ kind: 'animal', id: 's1', owner: String(keeper.id), name: 'Made-up Tortoise Pebble' })
  h.subjects.add({ kind: 'animal', id: 's2', owner: String(keeper.id), name: 'Made-up Skink Dot' })
  h.subjects.add({ kind: 'animal', id: 'g1', owner: String(giftKeeper.id), name: 'Made-up Gecko Fern' })
  h.subjects.add({ kind: 'animal', id: 'b1', owner: String(giftBuyer.id), name: 'Made-up Boa Pip' })
  const summary = await seedKitStory(payload, { scope: 'A', people: { keeper: String(keeper.id), staff: String(staffA.id), lab: String(labPerson.id) }, mark: MARK, req: await as(staffA) })
  lots = summary.lots
  // A gift: bought by one person for their own animal, activated by another for theirs.
  await createLot(await as(staffA), { lotNumber: '383838', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 3 })
  giftCode = code('383838', 1)
  const g = (await findKit(await as(staffA), giftCode, 'A'))!
  giftOrder = String((await payload.create({ collection: 'orders', data: { tenant: 'A', customer: giftBuyer.id, kitLines: [{ kind: 'count', quantity: 1, test: 'test-a' }], kitFulfillment: { status: 'shipped', shippedAt: '2026-11-02T00:00:00.000Z', trackingNumbers: ['9400 0000 0000 0000 0000 77'] } } as never, overrideAccess: true })).id)
  await recordKitEvent(await as(staffA), g, { type: 'activated', set: { buyer: giftBuyer.id, order: giftOrder, activatedBy: giftKeeper.id, activatedAt: new Date().toISOString(), subjectKind: 'animal', subjectId: 'g1', suggestedKind: 'animal', suggestedId: 'b1', identifierLabel: 'Made-up Boa Pip' } })
  // Made up to test the guards' second layer: a gift's keeper with no sampled subject on the kit, only the buyer's suggestion.
  bareGiftCode = code('383838', 2)
  const bare = (await findKit(await as(staffA), bareGiftCode, 'A'))!
  await recordKitEvent(await as(staffA), bare, { type: 'activated', set: { buyer: giftBuyer.id, activatedBy: giftKeeper.id, activatedAt: new Date().toISOString(), suggestedKind: 'animal', suggestedId: 'b1', identifierLabel: 'Made-up Boa Pip' } })
  // A kit packed for the buyer's own animal, not yet activated.
  packedForCode = code('383838', 3)
  const packedFor = (await findKit(await as(staffA), packedForCode, 'A'))!
  await recordKitEvent(await as(staffA), packedFor, { type: 'packed', set: { buyer: giftBuyer.id, suggestedKind: 'animal', suggestedId: 'b1' } })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('staff pages', () => {
  it('refuse anyone who isn’t kit staff, with a plain answer and nothing thrown', async () => {
    for (const who of [keeper, stranger, labPerson, null]) {
      refused(await kitsHomePage(await as(who)), 'notStaff')
      refused(await packingPage(await as(who)), 'notStaff')
      refused(await returnsPage(await as(who)), 'notStaff')
      refused(await batchesPage(await as(who)), 'notStaff')
      refused(await scanLookup(await as(who), { code: code(lots[0]!, 1) }), 'notStaff')
      refused(await scanReceive(await as(who), { code: code(lots[0]!, 9) }), 'notStaff')
      refused(await packOrderPage(await as(who), { order: giftOrder }), 'notStaff')
      refused(await batchPage(await as(who), { batch: '000000000000000000000000' }), 'notStaff')
    }
  })

  it('show staff only their own site', async () => {
    const a = ok(await kitsHomePage(await as(staffA)))
    expect(a.counts.inStock).toBeGreaterThan(0)
    expect(a.lots.map((l) => l.lotNumber)).toEqual(expect.arrayContaining(lots))
    expect(a.lots.find((l) => l.lotNumber === lots[1])).toMatchObject({ recalled: true })
    const b = ok(await kitsHomePage(await as(staffB)))
    expect(b.counts).toEqual({ preorders: 0, inStock: 0, toPack: 0, packed: 0 })
    expect(b.lots).toEqual([])
    // Another site's kit is "unknown" to staff B, the same as a code that doesn't exist.
    expect(refused(await scanLookup(await as(staffB), { code: code(lots[0]!, 1) }), 'unknownKit').message).toContain(code(lots[0]!, 1))
  })

  it('look a kit up without saying who has it', async () => {
    const r = ok(await scanLookup(await as(staffA), { code: code(lots[0]!, 1) }))
    expect(r).toMatchObject({ outcome: 'done', lot: lots[0] })
    const json = JSON.stringify(r)
    expect(json).not.toContain(String(keeper.id))
    expect(json).not.toContain('Pebble')
    refused(await scanLookup(await as(staffA), { code: 'not a code' }), 'notACode')
  })

  it('receive, pack, slip and ship through the scan and packing functions', async () => {
    const n = code(lots[0]!, 10)
    // Received already by the seed's lot: "already", said in words.
    const again = ok(await scanReceive(await as(staffA), { code: n }))
    expect(again.outcome).toBe('already')
    expect(again.message).toMatch(/already received/)
    const queue = ok(await packingPage(await as(staffA))).orders
    const open = queue.find((q) => q.status === 'to-pack' && q.packed === 0 && q.kits === 1)!
    expect(open).toBeTruthy()
    const before = ok(await packOrderPage(await as(staffA), { order: open.id }))
    expect(before).toMatchObject({ total: 1, packed: 0, canShip: false, dropOff: null })
    const packed = ok(await scanPack(await as(staffA), { order: open.id, code: n }))
    expect(packed).toMatchObject({ code: n, packed: 1, total: 1 })
    refused(await submitShip(await as(staffA), { order: open.id, tracking: '9400 1000 0000 0000 0000 11' }), 'noSlip')
    const slip = ok(await submitSlip(await as(staffA), { order: open.id, origin: 'https://evil.example.test' } as never))
    expect(slip.kits).toHaveLength(1)
    expect(slip.kits[0]!.secret.length).toBeGreaterThan(5)
    // The link's address is the plugin's `site.origin`: an origin sent by the page is ignored.
    expect(slip.kits[0]!.link!.startsWith('https://kits.example.test/')).toBe(true)
    expect(slip.kits[0]!.link).not.toContain('evil')
    // The secret travels in the link's fragment, never its query.
    expect(slip.kits[0]!.link).toContain('#')
    expect(new URL(slip.kits[0]!.link!).search).not.toContain(slip.kits[0]!.secret)
    expect(ok(await packOrderPage(await as(staffA), { order: open.id })).canShip).toBe(true)
    const shipped = ok(await submitShip(await as(staffA), { order: open.id, tracking: '9400 1000 0000 0000 0000 11' }))
    expect(shipped.kits).toBe(1)
    // A stranger's order id, a junk id and another site's staff all get the same "not found".
    refused(await packOrderPage(await as(staffB), { order: open.id }), 'noOrder')
    refused(await packOrderPage(await as(staffA), { order: '$where' }), 'noOrder')
  })

  it('recall only with the box ticked', async () => {
    refused(await submitRecall(await as(staffA), { lotNumber: lots[0]!, reason: 'Made-up reason', confirm: false }), 'confirmRecall')
    refused(await submitRecall(await as(staffA), { lotNumber: lots[0]!, reason: 'Made-up reason', confirm: 'yes' as never }), 'confirmRecall')
    expect(ok(await kitsHomePage(await as(staffA))).lots.find((l) => l.lotNumber === lots[0])).toMatchObject({ recalled: false })
  })

  it('add a lot, and refuse a bad one in plain words', async () => {
    const r = ok(await submitLot(await as(staffA), { lotNumber: '494949', expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 2 }))
    expect(r).toMatchObject({ lotNumber: '494949', added: 2 })
    expect(refused(await submitLot(await as(staffA), { lotNumber: 'x' }), 'lotNumber').message).toMatch(/3 to 12 digits/)
  })

  it('make, fill and list batches, and check kits in', async () => {
    const page = ok(await batchesPage(await as(staffA)))
    expect(page.batches.length).toBeGreaterThan(0)
    expect(page.labs.length).toBe(1)
    const made = ok(await submitNewBatch(await as(staffA), { lab: page.labs[0]!.id, size: 24 }))
    // The seed's third kit was activated, not checked in: checking it in warns it wasn't marked sampled.
    const checked = ok(await scanCheckIn(await as(staffA), { code: code(lots[0]!, 3) }))
    expect(checked.outcome).toBe('warning')
    expect(checked.message).toMatch(/Warning/)
    expect(ok(await scanCheckIn(await as(staffA), { code: code(lots[0]!, 3) })).outcome).toBe('already')
    ok(await scanBatch(await as(staffA), { batch: made.id, code: code(lots[0]!, 3) }))
    const one = ok(await batchPage(await as(staffA), { batch: made.id }))
    expect(one.kitList).toEqual([{ code: code(lots[0]!, 3), status: 'returned' }])
    refused(await batchPage(await as(staffB), { batch: made.id }), 'noBatch')
    refused(await batchPage(await as(staffA), { batch: '{"$ne":1}' }), 'noBatch')
    const returns = ok(await returnsPage(await as(staffA)))
    expect(returns.hubs.length).toBeGreaterThan(0)
    expect(returns.labelsEnabled).toBe(true)
    expect(Array.isArray(returns.staleLabels)).toBe(true)
  })

  it('translate refusals through the site’s i18n.t, and fall back to English when a key is missing', async () => {
    flags.translate = true
    try {
      expect(refused(await kitsHomePage(await as(keeper)), 'notStaff').message).toBe('Translated: staff only.')
      expect(refused(await scanLookup(await as(staffA), { code: 'nope' }), 'notACode').message).toMatch(/kit code/)
    } finally {
      flags.translate = false
    }
  })
})

describe('the lab page', () => {
  it('shows a lab its batches as codes, statuses and markers only: never a buyer, keeper, address, subject or result', async () => {
    const page = ok(await labPage(await as(labPerson)))
    expect(page.lab).toBeTruthy()
    expect(page.batches.length).toBeGreaterThan(0)
    expect(page.batches[0]!.kits[0]).toEqual({ code: expect.any(String), status: expect.any(String), marker: expect.any(String) })
    // Upload a result, then look again: the lab sees that it went, never what it says.
    const kit = code(lots[0]!, 1)
    const data = Buffer.from(`>${kit} made-up\nACGTACGTACGT\n`).toString('base64')
    const up = ok(await submitResultFile(await as(labPerson), { lab: page.lab!.id, name: `${kit}.fasta`, data }))
    expect(up).toMatchObject({ result: 'received', code: kit })
    const json = JSON.stringify(ok(await labPage(await as(labPerson))))
    for (const secret of [String(keeper.id), keeper.email, 'Pebble', 'Skink', 'Exampleton', 'Sam Example', 'Made-up Returns', 'made-up result', 'customer', 'buyer', 'activatedBy', 'subject'])
      expect(json, secret).not.toContain(secret)
  })

  it('previews files without writing, and refuses anyone who isn’t the lab’s', async () => {
    const page = ok(await labPage(await as(labPerson)))
    const r = ok(await previewResultFiles(await as(labPerson), { lab: page.lab!.id, items: [{ name: 'no-code.fasta', size: 10 }, { name: 'notes.pdf', size: 10 }] }))
    expect(r.matches.map((m) => m.reason)).toEqual(['noCode', 'fileType'])
    expect(r.matches[0]!.explanation).toMatch(/Rename the file/)
    for (const who of [keeper, stranger, staffB, null]) refused(await labPage(await as(who)), 'notLab')
    refused(await previewResultFiles(await as(stranger), { lab: page.lab!.id, items: [] }), 'notLab')
    refused(await submitResultFile(await as(stranger), { lab: page.lab!.id, name: 'x.fasta', data: Buffer.from('>x\nACGT\n').toString('base64') }), 'notLab')
    refused(await submitBatchReceived(await as(stranger), { batch: page.batches[0]!.id }), 'notLab')
    refused(await submitResultFile(await as(labPerson), { lab: page.lab!.id, name: 'x.fasta', data: '' }), 'noFile')
  })
})

describe('keeper pages', () => {
  it('list only the person’s own orders and kits', async () => {
    const mine = ok(await myTestsPage(await as(keeper)))
    expect(mine.orders.length).toBe(4)
    expect(mine.orders.flatMap((o) => o.kits.map((k) => k.code))).toContain(code(lots[0]!, 1))
    expect(JSON.stringify(mine)).not.toContain(giftCode)
    const other = ok(await myTestsPage(await as(otherKeeper)))
    expect(other).toMatchObject({ orders: [], otherKits: [] })
    refused(await myTestsPage(await as(null)), 'signIn')
    // An order query that's too loose is checked again by the buyer rule.
    const o = (payload.config.custom as { sampleKits: { orders?: Record<string, unknown> } }).sampleKits
    const saved = o.orders
    o.orders = { ...saved, buyerWhere: () => ({ id: { exists: true } }) }
    try {
      expect(ok(await myTestsPage(await as(otherKeeper))).orders).toEqual([])
    } finally {
      o.orders = saved
    }
  })

  it('show a gift’s keeper the kit without its buyer, and its buyer the kit without the keeper or their animal', async () => {
    const keeperView = ok(await myKitPage(await as(giftKeeper), { code: giftCode }))
    expect(keeperView).toMatchObject({ role: 'keeper', subject: 'Made-up Gecko Fern', trackingNumbers: [] })
    expect(keeperView.dates.map((d) => d.step)).toEqual(['activated'])
    const kJson = JSON.stringify(keeperView)
    for (const secret of [String(giftBuyer.id), giftBuyer.email, 'Boa Pip']) expect(kJson).not.toContain(secret)
    const buyerView = ok(await myKitPage(await as(giftBuyer), { code: giftCode }))
    expect(buyerView).toMatchObject({ role: 'buyer', subject: null, result: null })
    const bJson = JSON.stringify(buyerView)
    for (const secret of [String(giftKeeper.id), giftKeeper.email, 'Gecko Fern']) expect(bJson).not.toContain(secret)
    expect(buyerView.dates.map((d) => d.step)).toEqual(['ordered', 'shipped'])
    // With no sampled subject on the kit, the keeper still never sees what the buyer bought it for.
    const bare = ok(await myKitPage(await as(giftKeeper), { code: bareGiftCode }))
    expect(bare).toMatchObject({ role: 'keeper', subject: null })
    expect(JSON.stringify(bare)).not.toContain('Boa Pip')
    // The keeper's list shows it among kits someone else bought.
    expect(ok(await myTestsPage(await as(giftKeeper))).otherKits.map((k) => k.code).sort()).toEqual([giftCode, bareGiftCode].sort())
  })

  it('give a stranger exactly the same answer as a kit that doesn’t exist', async () => {
    const missing = refused(await myKitPage(await as(stranger), { code: code('383838', 3) + '9' }), 'kitNotFound')
    const notTheirs = refused(await myKitPage(await as(stranger), { code: giftCode }), 'kitNotFound')
    const inStock = refused(await myKitPage(await as(stranger), { code: code('383838', 2) }), 'kitNotFound')
    expect(notTheirs).toEqual(missing)
    expect(inStock).toEqual(missing)
    expect(refused(await myKitPage(await as(staffB), { code: giftCode }), 'kitNotFound')).toEqual(missing)
    // A label for someone else's kit: the same.
    // A label for someone else's kit: the same answer as for a kit that doesn't exist.
    expect(refused(await getReturnLabel(await as(stranger), { code: code('383838', 3) + '9' }), 'kitNotFound')).toEqual(missing)
    expect(refused(await getReturnLabel(await as(stranger), { code: giftCode }), 'kitNotFound')).toEqual(missing)
  })

  it('show a result only to its keeper', async () => {
    const kit = code(lots[0]!, 1)
    const views = res.state.views
    const keeperView = ok(await myKitPage(await as(keeper), { code: kit }))
    expect(keeperView.result).toMatchObject({ status: 'ready', summary: expect.stringContaining('made-up result') })
    expect(res.state.views).toBe(views + 1)
    // The gift's buyer: no result, and the provider isn't even asked.
    const before = res.state.views
    expect(ok(await myKitPage(await as(giftBuyer), { code: giftCode })).result).toBeNull()
    expect(res.state.views).toBe(before)
  })

  it('show an order’s help only to its buyer, the same "not found" to anyone else', async () => {
    const orders = ok(await myTestsPage(await as(keeper))).orders
    const page = ok(await myOrderPage(await as(keeper), { order: orders[0]!.id }))
    expect(page.options.reasons.length).toBeGreaterThan(0)
    expect(JSON.stringify(page)).not.toContain('decidedBy')
    const missing = refused(await myOrderPage(await as(stranger), { order: '000000000000000000000000' }), 'noOrder')
    expect(refused(await myOrderPage(await as(stranger), { order: orders[0]!.id }), 'noOrder')).toEqual(missing)
    expect(refused(await submitHelp(await as(stranger), { order: orders[0]!.id, reasons: ['other'] }), 'noOrder')).toEqual(missing)
  })

  it('answer an unexpected failure with the general message, and log only the error’s name', async () => {
    const logged: unknown[] = []
    const error = payload.logger.error.bind(payload.logger)
    payload.logger.error = ((obj: unknown) => void logged.push(obj)) as never
    flags.viewThrows = true
    try {
      const e = refused(await myKitPage(await as(keeper), { code: code(lots[0]!, 1) }), 'generic')
      expect(e.message).toMatch(/try again/)
      expect(e.message).not.toContain('keeper@example.test')
      expect(JSON.stringify(logged)).not.toContain('keeper@example.test')
      expect(logged).toEqual([{ name: 'Error' }])
    } finally {
      flags.viewThrows = false
      payload.logger.error = error
    }
  })
})

describe('activation', () => {
  it('suggests nothing about a code before its secret is checked, unless the person bought it', async () => {
    const r = ok(await activatePage(await as(stranger), { code: code(lots[0]!, 4) }))
    expect(r).toMatchObject({ choices: [], guided: false, code: code(lots[0]!, 4) })
    const mine = ok(await activatePage(await as(keeper), { code: 'not a code' }))
    expect(mine.code).toBeNull()
    expect(mine.choices!.map((c) => c.label).sort()).toEqual(['Made-up Skink Dot', 'Made-up Tortoise Pebble'])
    refused(await activatePage(await as(null), {}), 'signIn')
  })

  it('marks what a kit was bought for only for its buyer, and says "sample next" only to its own keeper', async () => {
    const original = h.subjects.choices!
    // A provider that offers the kit's suggestion to anyone: the plugin must not pass a stranger the real kit.
    h.subjects.choices = async ({ kit }) => (kit.suggestedId ? [{ ref: { kind: 'animal', id: String(kit.suggestedId) }, label: 'Made-up suggestion', suggested: true }] : [])
    try {
      expect(ok(await activatePage(await as(giftBuyer), { code: packedForCode })).choices).toEqual([{ ref: { kind: 'animal', id: 'b1' }, label: 'Made-up suggestion', suggested: true }])
      const strangerView = ok(await activatePage(await as(stranger), { code: packedForCode }))
      expect(strangerView.choices).toEqual([])
      expect(JSON.stringify(strangerView)).not.toContain('b1')
      // A provider that marks a suggestion on its own still can't mark one for someone who didn't buy the kit.
      h.subjects.choices = async () => [{ ref: { kind: 'animal', id: 'x1' }, label: 'Made-up any', suggested: true }]
      expect(ok(await activatePage(await as(stranger), { code: packedForCode })).choices).toEqual([{ ref: { kind: 'animal', id: 'x1' }, label: 'Made-up any', suggested: false }])
      expect(ok(await activatePage(await as(giftBuyer), { code: packedForCode })).choices![0]!.suggested).toBe(true)
    } finally {
      h.subjects.choices = original
    }
    expect(ok(await activatePage(await as(giftKeeper), { code: giftCode })).stage).toBe('sample')
    expect(ok(await activatePage(await as(stranger), { code: giftCode })).stage).toBe('activate')
    expect(ok(await activatePage(await as(giftBuyer), { code: giftCode })).stage).toBe('activate')
  })

  it('activates with the secret, and gives a wrong secret the same answer as a missing kit', async () => {
    const orders = ok(await packingPage(await as(staffA))).orders
    const packed = orders.find((o) => o.status === 'packed' && o.packed === 1)!
    const slip = ok(await submitSlip(await as(staffA), { order: packed.id }))
    const { code: kit, secret } = slip.kits[0]!
    const subject = { kind: 'animal', id: 's2' }
    const wrong = refused(await submitActivation(await as(keeper), { code: kit, secret: 'WRONGSECRET1', subject }), 'badSecret')
    const missing = refused(await submitActivation(await as(keeper), { code: '999999000001', secret, subject }), 'badSecret')
    expect(wrong).toEqual(missing)
    refused(await submitActivation(await as(keeper), { code: kit, secret, subject: null as never }), 'chooseSubject')
    // Without the secret, the code alone never activates.
    refused(await submitActivation(await as(keeper), { code: kit, secret: kit, subject }), 'badSecret')
    const done = ok(await submitActivation(await as(keeper), { code: kit, secret, subject }))
    expect(done).toMatchObject({ code: kit, label: 'Made-up Skink Dot' })
    expect(done.message).toContain('Skink Dot')
    const sampled = ok(await submitSampled(await as(keeper), { code: kit, confirmed: { steps: 'made-up' } }))
    expect(sampled.code).toBe(kit)
    refused(await submitSampled(await as(stranger), { code: kit }), 'notYourKit')
  })
})

describe('lost races', () => {
  it('answer busy in plain words, never the general error', async () => {
    const conflict = Object.assign(new Error('made-up WriteConflict'), { code: 112, codeName: 'WriteConflict', errorLabels: ['TransientTransactionError'] })
    const r = await serve(await as(staffA), async () => {
      throw conflict
    })
    expect(refused(r, 'busy').message).toBe('Someone else just did this; refresh and check.')
    expect(refused(await serve(await as(staffA), async () => {
      throw new Error('made-up other failure')
    }), 'generic').message).toMatch(/Something went wrong/)
  })
})
