import { randomInt } from 'node:crypto'

import { createLocalReq, type Payload, type PayloadRequest, type TypedUser } from 'payload'

import { activateKit, createLot, markSampled, recordKitEvent } from './kits.js'
import { kitCollections } from './collections.js'
import { audit, carriable, carry, mergeCarried, idOf, inTransaction, KitError, optionsOf, passes, READ, requireStaff, scoped, siteOf, sysReq, topLevelFields } from './internal.js'
import { batchKit, checkInKit, confirmBatchReceived, createBatch, shipBatch } from './lab.js'
import { ORDER_FIELD_NAMES } from './orderFields.js'
import { makeSlip, markShipped, packKit } from './packing.js'
import { recallLot } from './recall.js'
import { KIT_COLLECTION_SLUGS, type KitDoc, type ResolvedOptions } from './types.js'

/**
 * Made-up kit data for a site's demo or sandbox (the seed plugin), told through the plugin's own actions, so every status,
 * custody trail and notice is what the plugin itself makes. Nothing leaves the process: no labels are bought, no
 * payment is taken, and payment ids are stand-ins (`seed_pi_<16 digits>`). The site's subjects come through its
 * subject provider (`subjects.choices`). Records are marked (`mark`, a field set to true on every record made) and
 * reported to `track`, oldest first, so they can be removed again with `removeKitRecords`, which only ever removes
 * marked records.
 *
 * Both need kit staff (or an admin) on `req`, and only ever touch records of the request's own site.
 *
 * A `stamp` (extra fields, e.g. `{ sandboxBatch: 'b-1' }`) is set alongside the marker on every record made, and a
 * removal given the same stamp removes only records carrying it, so one batch never takes another's. A `context` is
 * passed on every write and delete, under the plugin's own context keys, which always win; it can't set the keys the
 * plugin's guards read.
 */

export type SeedPeople = {
  /** Buys and activates the kits. Needs something to sample (the subject provider's `choices`). */
  keeper: string
  /** Packs, ships, checks in and recalls. Kit staff on the site. */
  staff: string
  /** A lab portal user: with one, the story goes on to a lab batch the lab confirms. */
  lab?: string
}

export type SeedKitStoryArgs = {
  /** The site the story is for: must be the request's own site (`scope.of(req)`). Leave out on a single-site install. */
  scope?: string | number | null
  people: SeedPeople
  /** Told each record made, oldest first, once the story is done (e.g. the seed plugin's register). */
  track?: (collection: string, id: string) => void | Promise<void>
  /** A field set to true on every record made (the seed plugin's marker). Required: records without it are never removed. */
  mark: string
  /**
   * Extra fields set, with the marker, on every record made (e.g. `{ sandboxBatch: '<batch id>' }`). Each value is a
   * non-empty string, a finite number or true/false. Never one of the plugin's own fields, the marker, `id`, `createdAt` or
   * `updatedAt` (`badStamp`).
   */
  stamp?: SeedStamp
  /** Passed on every write the story makes, under the plugin's own context keys (which win). */
  context?: Record<string, unknown>
  req: PayloadRequest
}

export type SeedStamp = Record<string, string | number | boolean>

export type RemoveKitRecordsArgs = {
  ids: { collection: string; id: string }[]
  mark: string
  /** With a stamp, only records carrying every one of its fields (and the marker) are removed. */
  stamp?: SeedStamp
  /** Passed on every delete, under the plugin's own context keys (which win). */
  context?: Record<string, unknown>
  req: PayloadRequest
}

export type SeedSummary = { orders: number; kits: number; lots: string[]; records: number; site: { hub: string; lab: string | null } }

const MARK = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('')

/** A stand-in payment id for a made-up order: never a real payment service's. */
export const standInPaymentId = () => `seed_pi_${digits(16)}`

/**
 * The seed plugin's own `allow(req)` (`adapters.seed.allow`), asked before anything else: only an answer of exactly
 * `true` lets a seed or a removal run. Not configured, `false`, any other value, or a throw: refused, so production
 * can't be seeded from either side.
 */
async function seedAllowed(o: ResolvedOptions, req: PayloadRequest) {
  const allow = o.adapters?.seed?.allow
  if (typeof allow !== 'function' || !(await passes(allow, req))) throw new KitError('seedNotAllowed', 'Seed data can’t be made or removed here: the seed plugin doesn’t allow it on this site.')
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Names a stamp can never use: the records' own ids and dates, and the database's. */
const NOT_STAMPS = new Set(['id', '_id', 'createdAt', 'updatedAt', '_status'])
const ownFields = new WeakMap<ResolvedOptions, Set<string>>()
/** The plugin's own field names, on every collection it adds and on the site's orders, plus the site's scope field. */
function pluginFieldNames(o: ResolvedOptions): Set<string> {
  let names = ownFields.get(o)
  if (!names) {
    names = new Set<string>([...ORDER_FIELD_NAMES, ...(o.scope ? [o.scope.field] : [])])
    for (const c of kitCollections(o)) for (const f of topLevelFields(c.fields)) names.add(f.name)
    ownFields.set(o, names)
  }
  return names
}

/** The collections a seed writes and a removal deletes from: the plugin's and the site's orders. */
const seedCollections = (o: ResolvedOptions): string[] => [...KIT_COLLECTION_SLUGS, o.collections.orders]

/**
 * A seed's stamp, checked before anything is written: field names the plugin doesn't own, that every collection the
 * seed writes has (or a record would quietly go unstamped), and plain values.
 */
function stampOf(payload: Payload, o: ResolvedOptions, stamp: unknown, mark: string): SeedStamp {
  if (stamp === undefined) return {}
  const bad = (why: string) => new KitError('badStamp', `The seed’s stamp can’t be used: ${why}`)
  if (!isPlain(stamp)) throw bad('it must be a plain object of field names and values.')
  const own = pluginFieldNames(o)
  const out: SeedStamp = {}
  for (const [key, value] of Object.entries(stamp)) {
    if (!MARK.test(key)) throw bad(`“${key.slice(0, 64)}” isn’t a field name.`)
    if (key === mark) throw bad(`“${key}” is the marker.`)
    if (NOT_STAMPS.has(key) || own.has(key)) throw bad(`“${key}” is one of the records’ own fields.`)
    const missing = seedCollections(o).find((slug) => {
      const fields = payload.config.collections.find((c) => c.slug === slug)?.fields
      return !fields || !topLevelFields(fields).some((f) => f.name === key)
    })
    if (missing) throw bad(`“${key}” isn’t a field on ${missing}: add it to every collection the seed writes.`)
    const plain = (typeof value === 'string' && value !== '') || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    if (!plain) throw bad(`“${key}” needs a string, a number or true/false (never empty or null: those would match unstamped records).`)
    out[key] = value as SeedStamp[string]
  }
  return out
}

/** A caller's context, checked and made safe to carry (the plugin's guard keys dropped). */
function contextOf(context: unknown) {
  if (context === undefined) return carriable({})
  if (!isPlain(context)) throw new KitError('badContext', 'The seed’s context must be a plain object.')
  return carriable(context)
}

/** The seed and the removal: the seed plugin's allow(), then kit staff or an admin, on their own site. */
async function guard(o: ResolvedOptions, req: PayloadRequest, scope: unknown): Promise<string | undefined> {
  await seedAllowed(o, req)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  if (o.scope && (scope === undefined || scope === null || String(scope) !== site)) throw new KitError('wrongSite', 'Seed data can only be made or removed on your own site.')
  return site
}

type Made = { collection: string; id: string; at: string }

/**
 * One keeper's story: a lot, an order packed, slipped, shipped, activated and sampled, the kits checked in at the hub
 * and (with a lab person) sent to the lab and received; an order packed and waiting; a second lot recalled, taking a
 * packed kit back out of its order and setting one aside; and a new order not packed yet.
 */
export async function seedKitStory(payload: Payload, args: SeedKitStoryArgs): Promise<SeedSummary> {
  const o = optionsOf(payload)
  const req = args?.req
  if (!req) throw new KitError('notStaff', 'Only kit staff can do that.')
  const site = await guard(o, req, args.scope)
  if (!args.mark || !MARK.test(String(args.mark))) throw new KitError('badMark', 'The seed needs a marker, a field name: unmarked records could never be removed.')
  const stamped = stampOf(payload, o, args.stamp, args.mark)
  const context = contextOf(args.context)
  const people = args.people ?? ({} as SeedPeople)
  const made: Made[] = []
  /** What every record made carries: the stamp, then the marker. */
  const mark = { ...stamped, [args.mark]: true }
  /** The story's own write requests: the caller's context under the plugin's, carried on to anything they write. */
  const sys = (own: Record<string, unknown>) => carry(sysReq(req, mergeCarried(context, own)), context)
  /** Records the story makes directly: marked as they're made. */
  const create = async (collection: string, data: Record<string, unknown>, why: string) => {
    const doc = (await payload.create({ collection: collection as never, data: { ...data, ...mark } as never, overrideAccess: true, depth: 0, req: sys(audit(why)) })) as unknown as { id: string | number; createdAt?: string }
    made.push({ collection, id: String(doc.id), at: String(doc.createdAt ?? new Date().toISOString()) })
    return String(doc.id)
  }

  // Each person acts with a request of their own, sharing the caller's headers and transaction.
  const userOf = async (id: unknown, role: string) => {
    const doc = id ? await payload.findByID({ collection: o.collections.users as never, id: String(id), depth: 0, overrideAccess: true, disableErrors: true, req }) : null
    if (!doc) throw new KitError('seedPeople', `The seed needs a ${role}.`)
    return { ...(doc as object), collection: o.collections.users } as unknown as TypedUser
  }
  const as = async (user: TypedUser) => {
    const r = await createLocalReq({ user, context: { ...context }, req: { headers: req.headers } as never }, payload)
    if (req.transactionID) r.transactionID = req.transactionID
    return carry(r, context)
  }
  const keeper = await as(await userOf(people.keeper, 'keeper'))
  const staff = await as(await userOf(people.staff, 'kit staff member'))
  const lab = people.lab ? await as(await userOf(people.lab, 'lab person')) : null
  if (!(await staffOf(o, staff))) throw new KitError('seedPeople', 'The seed’s staff member isn’t kit staff on this site.')
  if (o.scope && (await siteOf(o, staff)) !== site) throw new KitError('wrongSite', 'Seed data can only be made or removed on your own site.')

  // ------------------------------------------------------------ the site's kit setup: one hub and one lab, found again by the marker (and stamp)
  const markedWhere = Object.entries(mark).map(([k, v]) => ({ [k]: { equals: v } }))
  const found = async (collection: 'hubs' | 'labs', name: string) =>
    ((await payload.find({ collection, where: scoped(o, site, { and: [{ name: { equals: name } }, ...markedWhere] }), limit: 1, ...READ, req })).docs[0]?.id as string | undefined) ?? null
  const stamp = o.scope ? { [o.scope.field]: site } : {}
  const hub =
    (await found('hubs', 'Returns hub (made up)')) ??
    (await create('hubs', { ...stamp, name: 'Returns hub (made up)', address: { kind: 'general-delivery', name: 'Sam Example', company: 'Made-up Returns', city: 'Exampleton', state: 'KS', postalCode: '66999-9999' }, operators: [staff.user!.id], defaultReturn: false, active: true }, 'seed hub'))
  const labId = !lab
    ? null
    : ((await found('labs', 'Made-up Genetics Lab')) ??
      (await create('labs', { ...stamp, name: 'Made-up Genetics Lab', contacts: [{ name: 'Lab desk', email: 'samples@lab.example', notices: false }], batchSizes: [24, 48, 96], portalUsers: [lab.user!.id], active: true }, 'seed lab')))

  // ------------------------------------------------------------ lots, new to this site
  const newLot = async () => {
    for (;;) {
      const n = `27${digits(4)}`
      if (!(await payload.count({ collection: 'kit-lots', where: scoped(o, site, { lotNumber: { equals: n } }), overrideAccess: true, req })).totalDocs) return n
    }
  }
  const useBy = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const mainLot = await newLot()
  await createLot(staff, { lotNumber: mainLot, model: 'Made-up swab tube', expiresOn: useBy(400), firstSerial: 1, lastSerial: 10 })
  const laterLot = await newLot()
  await createLot(staff, { lotNumber: laterLot, model: 'Made-up swab tube', expiresOn: useBy(300), firstSerial: 1, lastSerial: 3 })
  const code = (lot: string, n: number) => `${lot}${String(n).padStart(6, '0')}`

  // ------------------------------------------------------------ orders: the site's own fields from `orders.seeded`
  const order = async (kits: number) => {
    const paymentId = standInPaymentId()
    const own = o.orders?.seeded ? await o.orders.seeded({ buyer: String(keeper.user!.id), kits, paymentId, req }) : { customer: keeper.user!.id }
    return create(o.collections.orders, { ...own, ...stamp, kitLines: [{ kind: 'count', quantity: kits, test: o.tests[0]!.value }], kitFulfillment: { status: 'to-pack' } }, 'seed order')
  }
  const tracking = () => `9400${digits(18)}`

  // An order of three, all the way to the lab.
  const first = await order(3)
  for (let n = 1; n <= 3; n++) await packKit(staff, { order: first, code: code(mainLot, n) })
  const slip = await makeSlip(staff, { order: first })
  await markShipped(staff, { order: first, tracking: [tracking()] })
  const keeperUser = keeper.user!
  for (const [i, s] of slip.entries()) {
    const kit = (await payload.find({ collection: 'kits', where: scoped(o, site, { code: { equals: s.code } }), limit: 1, ...READ, req })).docs[0] as unknown as KitDoc
    const choices = (await o.subjects.choices?.({ user: keeperUser, kit, req: keeper })) ?? []
    const subject = choices[i % Math.max(1, choices.length)]?.ref
    if (!subject) throw new KitError('seedSubjects', 'The keeper has nothing to sample: give them something first.')
    await activateKit(keeper, { code: s.code, secret: s.secret, subject })
    if (i < 2) {
      // With Wizards wired, the guided steps' answers can't be made up, so the sample is recorded as seeded.
      if (o.adapters?.wizards) await recordKitEvent(staff, kit, { type: 'sampled', actor: keeperUser, source: 'customer', details: { seeded: true }, set: { sampledAt: new Date().toISOString() } })
      else await markSampled(keeper, { code: s.code, confirmed: { seeded: true } })
    }
  }
  for (const s of slip.slice(0, 2)) await checkInKit(staff, { code: s.code, hub })
  let batchId: string | null = null
  if (lab && labId) {
    const batch = await createBatch(staff, { lab: labId, size: 24, hub })
    batchId = String(batch.id)
    for (const s of slip.slice(0, 2)) await batchKit(staff, { batch: String(batch.id), code: s.code })
    await shipBatch(staff, { batch: String(batch.id), tracking: [tracking()], oddSizeOk: true })
    await confirmBatchReceived(lab, { batch: String(batch.id) })
  }

  // An order of one, packed and waiting.
  const second = await order(1)
  await packKit(staff, { order: second, code: code(mainLot, 4) })

  // Two kits from the later lot: one packed into an order, then the lot is recalled.
  const third = await order(2)
  await packKit(staff, { order: third, code: code(laterLot, 1) })
  await recallLot(staff, { lotNumber: laterLot, reason: 'Made-up: a faulty seal on some tubes' })

  // A new order, not packed yet.
  await order(1)

  // ------------------------------------------------------------ what the actions made: found by the story's own new lots
  // The plugin's actions make lots, kits, their trail and the batch; each is found from the lots this story made, so
  // nothing else on the site is ever picked up. They're marked straight in the database (the trail can't be updated).
  const at = (d: { id: unknown; createdAt?: unknown }) => ({ id: String(d.id), at: String(d.createdAt ?? '') })
  const lots = (await payload.find({ collection: 'kit-lots', where: scoped(o, site, { lotNumber: { in: [mainLot, laterLot] } }), ...READ, req })).docs.map(at)
  const kits = (await payload.find({ collection: 'kits', where: scoped(o, site, { lot: { in: lots.map((l) => l.id) } }), ...READ, req })).docs.map(at)
  const events = kits.length ? (await payload.find({ collection: 'kit-events', where: scoped(o, site, { kit: { in: kits.map((k) => k.id) } }), ...READ, req })).docs.map(at) : []
  const batches = batchId ? [{ id: batchId, at: String(((await payload.findByID({ collection: 'lab-batches', id: batchId, ...READ, req })) as { createdAt?: string }).createdAt ?? '') }] : []
  // Shipment notices (only with `notify`): found by the story's own orders.
  const orderIds = made.filter((m) => m.collection === o.collections.orders).map((m) => m.id)
  const notices = orderIds.length ? (await payload.find({ collection: 'kit-notices', where: scoped(o, site, { order: { in: orderIds } }), ...READ, req })).docs.map(at) : []
  const byActions: [string, { id: string; at: string }[]][] = [['kit-lots', lots], ['kits', kits], ['kit-events', events], ['lab-batches', batches], ['kit-notices', notices]]
  for (const [collection, docs] of byActions) {
    if (docs.length) await payload.db.updateMany({ collection: collection as never, where: { id: { in: docs.map((d) => d.id) } }, data: { ...mark }, req: sys({}), returning: false })
    made.push(...docs.map((d) => ({ collection, ...d })))
  }
  const kept = made.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  for (const m of kept) await args.track?.(m.collection, m.id)
  return {
    orders: kept.filter((m) => m.collection === o.collections.orders).length,
    kits: kept.filter((m) => m.collection === 'kits').length,
    lots: [mainLot, laterLot],
    records: kept.length,
    site: { hub, lab: labId },
  }
}

const staffOf = async (o: ResolvedOptions, req: PayloadRequest) => {
  try {
    await requireStaff(o, req)
    return true
  } catch {
    return false
  }
}

/**
 * Removes records a seed made, newest first: only those of the plugin's collections (and the site's orders) that
 * carry the marker (and, given a stamp, every field of it) and belong to the request's site. Anything unmarked,
 * stamped otherwise, on another site, or in another collection is left alone and counted as skipped. Kit staff or an
 * admin, in one transaction (the caller's when there is one).
 */
export async function removeKitRecords(payload: Payload, args: RemoveKitRecordsArgs): Promise<{ removed: number; skipped: number }> {
  const o = optionsOf(payload)
  const req = args?.req
  if (!req) throw new KitError('notStaff', 'Only kit staff can do that.')
  await seedAllowed(o, req)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  if (!args.mark || !MARK.test(String(args.mark))) throw new KitError('badMark', 'Removal needs the marker: only marked records are ever removed.')
  const stamped = stampOf(payload, o, args.stamp, args.mark)
  const context = contextOf(args.context)
  const marked = Object.entries({ ...stamped, [args.mark]: true }).map(([k, v]) => ({ [k]: { equals: v } }))
  const allowed = new Set<string>(seedCollections(o))
  const ids = Array.isArray(args.ids) ? args.ids : []
  return inTransaction(req, async (req) => {
    let removed = 0
    let skipped = 0
    for (const m of [...ids].reverse()) {
      const id = idOf(m?.id)
      if (!m || !allowed.has(String(m.collection)) || !id) {
        skipped++
        continue
      }
      const where = scoped(o, site, { and: [{ id: { equals: id } }, ...marked] })
      const { docs } = await req.payload.find({ collection: m.collection as never, where, limit: 1, ...READ, req })
      if (!docs.length) {
        skipped++
        continue
      }
      await req.payload.delete({ collection: m.collection as never, id, overrideAccess: true, depth: 0, req: carry(sysReq(req, mergeCarried(context, audit('seed record removed'))), context) })
      removed++
    }
    return { removed, skipped }
  })
}
