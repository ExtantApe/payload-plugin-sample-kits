import { createLocalReq, type Field, type FieldAccess, type Payload, type PayloadRequest, type TypedUser } from 'payload'

import { buyerOrKeeper } from './access.js'
import type { AddressProblem, DropOffChoice, EventsAdapter, KitDoc, ResultAnswer, ResultsProvider, ResultView, KitLine, Label, LabelAddress, LabelShipping, ParcelSize, PaymentsProvider, Quote, RefundRecord, RefundStatus, Refusal, SampleKitsAccess, StoredAddress, SubjectRef, SubjectsProvider } from './types.js'

/**
 * Fake providers for tests and dry runs. Nothing here touches a real site: subjects live in memory,
 * and roles are read from a field on the made-up person. Never use these in production.
 */

export type FakeRole = 'staff' | 'admin' | 'maintainer'

/**
 * Access from a role on the person (`kitRole` by default): `'staff'`, `'admin'` or `'maintainer'`, and a
 * buyer reads the kits they bought or activated. Each check answers only for its own role; the
 * plugin lets a maintainer pass as admin and staff, and an admin as staff.
 */
export function fakeAccess({ roleOf = (user) => (user as { kitRole?: FakeRole | null }).kitRole ?? null }: { roleOf?: (user: TypedUser) => FakeRole | null } = {}): SampleKitsAccess {
  const is = (role: FakeRole) => (req: PayloadRequest) => Boolean(req.user) && roleOf(req.user as TypedUser) === role
  return { staff: is('staff'), admin: is('admin'), maintainer: is('maintainer'), buyerOf: buyerOrKeeper }
}

export type FakeSubject = { kind: string; id: string; owner: string; name: string }

/**
 * Subjects held in memory. Kits get four text fields: `suggestedKind`, `suggestedId` (what it was
 * bought for) and `subjectKind`, `subjectId` (what was sampled). A person may sample their own subjects.
 */
export function fakeSubjects(initial: FakeSubject[] = []): SubjectsProvider & { subjects: FakeSubject[]; add: (s: FakeSubject) => FakeSubject } {
  const subjects = [...initial]
  const find = (ref: SubjectRef) => subjects.find((s) => s.kind === ref.kind && s.id === ref.id)
  const idOf = (v: unknown) => String(v && typeof v === 'object' ? (v as { id: unknown }).id : (v ?? ''))
  const buyerOrStaff: FieldAccess = ({ req, doc }) =>
    Boolean(req.user) && (Boolean((req.user as { kitRole?: string }).kitRole) || idOf((doc as { buyer?: unknown } | undefined)?.buyer) === String(req.user!.id))
  const fields: Field[] = [
    // What it was bought for is the buyer's business: a kit given away doesn't show it.
    { name: 'suggestedKind', type: 'text', access: { read: buyerOrStaff } },
    { name: 'suggestedId', type: 'text', access: { read: buyerOrStaff } },
    { name: 'subjectKind', type: 'text' },
    { name: 'subjectId', type: 'text', index: true },
  ]
  const refOf = (kind: unknown, id: unknown): SubjectRef | null => (typeof kind === 'string' && typeof id === 'string' && kind && id ? { kind, id } : null)
  return {
    subjects,
    add: (s) => (subjects.push(s), s),
    fields,
    buyerFields: ['suggestedKind', 'suggestedId'],
    kinds: ['animal', 'group'],
    suggestedOf: (kit: KitDoc) => refOf(kit.suggestedKind, kit.suggestedId),
    sampledOf: (kit: KitDoc) => refOf(kit.subjectKind, kit.subjectId),
    assign: ({ ref }) => ({ subjectKind: ref.kind, subjectId: ref.id }),
    canSample: async ({ user, ref }): Promise<true | Refusal> => {
      const s = find(ref)
      return s && s.owner === String(user.id) ? true : { code: 'notYourSubject', message: 'Choose one of your own.' }
    },
    choices: async ({ user, kit }) => {
      const suggested = refOf(kit.suggestedKind, kit.suggestedId)
      return subjects
        .filter((s) => s.owner === String(user.id))
        .map((s) => ({ ref: { kind: s.kind, id: s.id }, label: s.name, suggested: Boolean(suggested && suggested.kind === s.kind && suggested.id === s.id) }))
        .sort((a, b) => Number(b.suggested) - Number(a.suggested))
    },
    label: async ({ ref }) => find(ref)?.name ?? null,
    // Order lines name their subjects by id; packing gives each kit the next one.
    lineFields: [{ name: 'subjectIds', type: 'text', hasMany: true }],
    packFor: ({ line, slot }: { line: KitLine; slot: number }) => {
      const id = Array.isArray(line.subjectIds) ? (line.subjectIds[slot] as string | undefined) : undefined
      if (line.kind === 'count' || !id) return {}
      return { set: { suggestedKind: line.kind, suggestedId: id }, label: find({ kind: line.kind, id })?.name ?? null }
    },
    lineFor: ({ kit }) => {
      const ref = refOf(kit.subjectKind, kit.subjectId) ?? refOf(kit.suggestedKind, kit.suggestedId)
      return ref ? { kind: ref.kind, subjectIds: [ref.id] } : null
    },
  }
}

// ---------------------------------------------------------------- shipping

/** Shaped like Shipping's error: read by its `name` and `code`, as the plugin reads the real one. */
export class FakeCarrierError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CarrierError'
  }
}

type Action = 'quote' | 'buy' | 'refund'
const ZIP = /^\d{5}(-\d{4})?$/
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * A stand-in for Shipping's functions: nothing leaves the process, and every price is made up. `fail(action,
 * code, status)` makes the next call of that action throw a Shipping-shaped error (`MAYBE_BOUGHT`, `REFUSED`,
 * a 4xx refusal, …). `bought`, `refunds` and `quotes` record what was asked.
 */
export function fakeShipping() {
  const failures: Record<Action, FakeCarrierError[]> = { quote: [], buy: [], refund: [] }
  const bought: (Label & { reference: string })[] = []
  const refunds: string[] = []
  const quotes: { reference: string; parcel: unknown }[] = []
  const state = { refundAnswer: 'submitted' as RefundStatus }
  let n = 0
  const take = (action: Action) => {
    const e = failures[action].shift()
    if (e) throw e
  }
  const addressProblems = (a: StoredAddress | null | undefined, opts: { placeholder?: boolean | null } = {}): AddressProblem[] => {
    const out: AddressProblem[] = []
    if (opts.placeholder) out.push('placeholder')
    const kind = (a?.kind as string | null | undefined) ?? 'street'
    if (kind !== 'street' && !clean(a?.name)) out.push('name')
    if (kind === 'street' && !clean(a?.line1)) out.push('street')
    if (kind === 'po-box' && !/^\d{1,10}$/.test(clean(a?.poBox))) out.push('poBox')
    if (!clean(a?.city)) out.push('city')
    if (!/^[A-Z]{2}$/i.test(clean(a?.state))) out.push('state')
    if (!ZIP.test(clean(a?.postalCode))) out.push('zip')
    return out
  }
  const labelAddress = (a: StoredAddress | null | undefined, opts: { placeholder?: boolean | null } = {}): LabelAddress => {
    const problems = addressProblems(a, opts)
    if (problems.length) throw Object.assign(new Error(`The address can't go on a label: ${problems.join(', ')}.`), { problems })
    const kind = (a!.kind as string | null | undefined) ?? 'street'
    return { name: clean(a!.name) || clean(a!.company), company: clean(a!.company) || null, street1: kind === 'po-box' ? `PO BOX ${clean(a!.poBox)}` : kind === 'general-delivery' ? 'GENERAL DELIVERY' : clean(a!.line1), street2: clean(a!.line2) || null, city: clean(a!.city), state: clean(a!.state).toUpperCase(), zip: clean(a!.postalCode), country: 'US', phone: clean(a!.phone) || null }
  }
  const priceOf = (p: { weightOz: number; lengthIn?: number | null; widthIn?: number | null; heightIn?: number | null }) => 450 + Math.ceil(p.weightOz) * 10 + Math.round(((p.lengthIn ?? 6) * (p.widthIn ?? 6) * (p.heightIn ?? 2)) / 10)
  const quote: LabelShipping['quote'] = async (_payload, input) => {
    take('quote')
    quotes.push({ reference: input.reference, parcel: input.parcel })
    const cents = priceOf(input.parcel)
    return { shipmentId: `shp_fake${++n}`, rate: { id: `rate_fake${n}`, carrier: 'USPS', service: 'GroundAdvantage', rate: (cents / 100).toFixed(2), fake: true }, rateCents: cents, mode: 'test', fake: true, reference: input.reference } as Quote
  }
  const buy: LabelShipping['buy'] = async (_payload, q) => {
    take('buy')
    const label = { shipmentId: q.shipmentId, tracking: `9400${String(++n).padStart(18, '0')}`, carrier: q.rate.carrier, service: q.rate.service, rateCents: q.rateCents, labelUrl: `https://example.invalid/labels/${q.shipmentId}.pdf`, trackerUrl: null, mode: q.mode, fake: true, reference: String((q as { reference?: string }).reference ?? '') }
    bought.push(label)
    return label
  }
  const adapter: LabelShipping = {
    addressProblems,
    labelAddress,
    addressKey: (a) => [a.name, a.company ?? '', a.street1, a.street2 ?? '', a.city, a.state, a.zip].join('|').toUpperCase(),
    parcelFor: (box, contents) => {
      if (!box.outside) return null
      const [lengthIn, widthIn, heightIn] = [...box.outside].sort((a, b) => b - a) as [number, number, number]
      return { lengthIn, widthIn, heightIn, weightOz: Math.round(((box.emptyWeightOz ?? 0) + contents) * 10) / 10 }
    },
    mailability: (p: ParcelSize) => ({ mailable: p.weightOz <= 70 * 16, notes: [] }),
    quote,
    buy,
    quoteReturn: async (payload, input, req) => quote(payload, { from: input.customer, to: labelAddress(input.hub.address, { placeholder: input.hub.placeholder }), parcel: input.parcel, carrier: 'USPS', reference: input.reference }, req),
    buyReturn: async (payload, input, req) => buy(payload, await quote(payload, { from: input.customer, to: labelAddress(input.hub.address, { placeholder: input.hub.placeholder }), parcel: input.parcel, carrier: 'USPS', reference: input.reference }, req), req),
    refund: async (_payload, shipmentId) => {
      take('refund')
      refunds.push(shipmentId)
      return state.refundAnswer
    },
  }
  return {
    adapter,
    bought,
    refunds,
    quotes,
    state,
    fail: (action: Action, code: string, status = 0) => failures[action].push(new FakeCarrierError(status, code, `made-up ${code}`)),
    reset: () => {
      for (const k of Object.keys(failures) as Action[]) failures[k].length = 0
      state.refundAnswer = 'submitted'
    },
  }
}

// ---------------------------------------------------------------- payments

/** Payments in memory: refunds and credits recorded, a repeat key answered with the first record. `fail()` throws once. */
export function fakePayments() {
  const refunds: { key: string; amountCents: number; reason: string; record: RefundRecord }[] = []
  const credits: { key: string; kit: string; reason: string }[] = []
  const state = { failNext: false, timeoutNext: false }
  const payments: PaymentsProvider = {
    refund: async ({ amountCents, reason, key }) => {
      if (state.failNext) {
        // A clear refusal: nothing was refunded.
        state.failNext = false
        throw Object.assign(new Error('made-up payment refusal'), { refused: true as const })
      }
      const seen = refunds.find((r) => r.key === key)
      if (seen) return seen.record
      const record = { id: `re_fake${refunds.length + 1}`, amountCents, status: 'succeeded' }
      refunds.push({ key, amountCents, reason, record })
      if (state.timeoutNext) {
        // The refund went through, but the answer never came back.
        state.timeoutNext = false
        throw Object.assign(new Error('made-up timeout'), { name: 'TimeoutError' })
      }
      return record
    },
    creditBack: async ({ kit, reason, key }) => {
      if (state.failNext) {
        state.failNext = false
        throw new Error('made-up payment failure')
      }
      credits.push({ key, kit: String(kit.id), reason })
      return { id: `cr_fake${credits.length}` }
    },
  }
  return { payments, refunds, credits, fail: () => (state.failNext = true), timeoutAfterSuccess: () => (state.timeoutNext = true) }
}

// ---------------------------------------------------------------- results

/**
 * Results in memory. `accept` keeps each file and answers `ready`, or `failed` for a file whose text contains
 * "MADE-UP-FAIL"; `throwNext()` makes the next call throw. `view` gives the kit's latest result. `views` counts
 * how often the provider was asked, so tests can prove it wasn't.
 */
export function fakeResults() {
  const files: { kit: string; name: string; sha256: string; rerun: boolean }[] = []
  const state = { throwNext: false, views: 0, lastKitFields: [] as string[] }
  const results: ResultsProvider = {
    accept: async ({ kit, file, rerun }): Promise<ResultAnswer> => {
      if (state.throwNext) {
        state.throwNext = false
        throw new Error('made-up results failure')
      }
      if (file.text?.includes('MADE-UP-FAIL')) return { status: 'failed', summary: 'The made-up check refused this file.' }
      files.push({ kit: String(kit.id), name: file.name, sha256: file.sha256, rerun })
      return { status: 'ready', summary: `made-up result for kit ${kit.code}` }
    },
    view: async ({ kit }): Promise<ResultView | null> => {
      state.views++
      state.lastKitFields = Object.keys(kit)
      const mine = files.filter((f) => f.kit === String(kit.id))
      return mine.length ? { status: 'ready', summary: `made-up result for kit ${kit.code}` } : null
    },
  }
  return { results, files, state, throwNext: () => (state.throwNext = true) }
}

// ---------------------------------------------------------------- events

/** Event dates in memory, for drop-off: `dates` can be changed (moved, canceled, removed) by a test. */
export function fakeEvents(dates: (DropOffChoice & { zips: string[]; canceled?: boolean })[] = []) {
  const state = { throwNext: false }
  const events: EventsAdapter = {
    dropOffChoices: async ({ postalCode, now }) => {
      if (state.throwNext) {
        state.throwNext = false
        throw new Error('made-up events failure')
      }
      return dates.filter((d) => !d.canceled && d.zips.includes(postalCode) && Date.parse(d.starts) > now.getTime()).map(({ zips: _z, canceled: _c, ...c }) => c)
    },
    dateOf: async ({ dateId }) => {
      const d = dates.find((x) => x.dateId === dateId)
      return d ? { starts: d.starts, timezone: d.timezone, canceled: Boolean(d.canceled) } : null
    },
  }
  return { events, dates, state }
}

/** A request as this person (or signed out), for calling the actions from a test or a script. */
export const reqAs = (payload: Payload, user: (TypedUser & { collection?: string }) | null, collection = 'users'): Promise<PayloadRequest> =>
  createLocalReq({ user: user ? ({ ...user, collection: user.collection ?? collection } as TypedUser) : undefined }, payload)

// ---------------------------------------------------------------- kitting

/** Shaped like Kitting's refusal: read by its `code`, as the plugin reads the real one. */
export class FakeKittingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'KittingError'
  }
}

type KittingCall = 'assignUnits' | 'swapUnit' | 'release' | 'shipUnits' | 'voidUnit'
type UnitDoc = { id: string; externalId: string; status: 'ready' | 'assigned' | 'shipped' | 'void'; assignedTo?: string | null; assignedAt?: string | null; tenant?: string | null }

/**
 * A stand-in for Kitting's units, with Kitting's export shapes and refusal codes: `collection` is a small
 * `assembled-units` collection to add to a test config, and `adapter` goes in `adapters.kitting`. Like Kitting, every
 * call writes through the `req` it's given, so it joins that transaction. `build(codes, scope)` makes ready units;
 * `failNext(call, code?)` makes the next call of that kind throw (a Kitting-shaped refusal, or a crash without a code).
 * Build requests are kept in memory (`queued`), not in the database. Never use it in production.
 */
export function fakeKitting({ scopeField = 'tenant' }: { scopeField?: string } = {}) {
  const slug = 'assembled-units'
  const queued = new Map<string, number>()
  const failures: Partial<Record<KittingCall, Error[]>> = {}
  const calls: { call: KittingCall; joined: boolean }[] = []
  const alerts = { sent: 0 }
  const collection = {
    slug,
    fields: [
      { name: 'externalId', type: 'text', index: true },
      { name: 'status', type: 'select', options: ['ready', 'assigned', 'shipped', 'void'], defaultValue: 'ready' },
      { name: 'assignedTo', type: 'text' },
      { name: 'assignedAt', type: 'date' },
      { name: 'voidNote', type: 'text' },
      { name: scopeField, type: 'text', index: true },
    ],
  } as const
  type Req = Partial<PayloadRequest> | undefined
  const sys = (req: Req) => ({ overrideAccess: true, depth: 0, req: req as PayloadRequest })
  const start = (call: KittingCall, req: Req) => {
    calls.push({ call, joined: Boolean(req?.transactionID) })
    const e = failures[call]?.shift()
    if (e) throw e
  }
  const find = async (payload: Payload, req: Req, where: Record<string, unknown>) =>
    (await payload.find({ collection: slug as never, where: where as never, sort: 'createdAt', pagination: false, ...sys(req) })).docs as unknown as UnitDoc[]
  const set = (payload: Payload, req: Req, id: string, data: Partial<UnitDoc>) => payload.update({ collection: slug as never, id, data: data as never, ...sys(req) })
  const scopeOf = (scope: unknown) => (scope === undefined || scope === null ? [] : [{ [scopeField]: { equals: String(scope) } }])
  const byExternal = async (payload: Payload, req: Req, take: { id: string | number } | { externalId: string }, scope?: unknown) => {
    const docs = 'id' in take ? await find(payload, req, { id: { equals: take.id } }) : await find(payload, req, { and: [{ externalId: { equals: take.externalId } }, ...scopeOf(scope)] })
    if (!docs[0]) throw new FakeKittingError('unitNotFound', `${'externalId' in take ? take.externalId : 'That unit'} hasn’t been built.`)
    return docs[0]
  }
  const adapter = {
    recipe: { key: 'sample-kit' },
    assignUnits: async (payload: Payload, _recipe: unknown, count: number, context: { reference: string; scope?: string | number; req?: Req }) => {
      start('assignUnits', context.req)
      const held = await find(payload, context.req, { and: [{ assignedTo: { equals: context.reference } }, { status: { in: ['assigned', 'shipped'] } }, ...scopeOf(context.scope)] })
      const want = count - held.length - (queued.get(context.reference) ?? 0)
      const ready = want > 0 ? (await find(payload, context.req, { and: [{ status: { equals: 'ready' } }, ...scopeOf(context.scope)] })).slice(0, want) : []
      for (const u of ready) await set(payload, context.req, u.id, { status: 'assigned', assignedTo: context.reference, assignedAt: new Date().toISOString() })
      const short = Math.max(0, want - ready.length)
      if (short) queued.set(context.reference, (queued.get(context.reference) ?? 0) + short)
      return { assigned: ready.length, short }
    },
    swapUnit: async (payload: Payload, args: { reference: string; take: { id: string | number } | { externalId: string }; scope?: string | number; req?: Req }) => {
      start('swapUnit', args.req)
      const unit = await byExternal(payload, args.req, args.take, args.scope)
      if (unit.status === 'assigned' && unit.assignedTo === args.reference) return { taken: unit, released: null }
      if (unit.status !== 'ready') throw new FakeKittingError('unitStatus', `${unit.externalId} is ${unit.status === 'assigned' ? `kept for ${unit.assignedTo}` : unit.status}, so it can’t go to ${args.reference}.`)
      if ((queued.get(args.reference) ?? 0) > 0) {
        queued.set(args.reference, queued.get(args.reference)! - 1)
        await set(payload, args.req, unit.id, { status: 'assigned', assignedTo: args.reference, assignedAt: new Date().toISOString() })
        return { taken: unit, released: null }
      }
      const held = await find(payload, args.req, { and: [{ assignedTo: { equals: args.reference } }, { status: { equals: 'assigned' } }, ...scopeOf(args.scope)] })
      const out = held.at(-1)
      if (!out) throw new FakeKittingError('nothingReserved', `${args.reference} has no kits kept for it.`)
      await set(payload, args.req, out.id, { status: 'ready', assignedTo: null, assignedAt: null })
      await set(payload, args.req, unit.id, { status: 'assigned', assignedTo: args.reference, assignedAt: new Date().toISOString() })
      return { taken: unit, released: out }
    },
    release: async (payload: Payload, args: { reference: string; unit?: { id: string | number } | { externalId: string }; scope?: string | number; req?: Req }) => {
      start('release', args.req)
      if (args.unit) {
        const unit = await byExternal(payload, args.req, args.unit, args.scope)
        if (unit.assignedTo !== args.reference || unit.status !== 'assigned') throw new FakeKittingError('unitStatus', `${unit.externalId} isn’t kept for ${args.reference}.`)
        await set(payload, args.req, unit.id, { status: 'ready', assignedTo: null, assignedAt: null })
        return { released: [unit], cancelledRequests: [] }
      }
      const units = await find(payload, args.req, { and: [{ assignedTo: { equals: args.reference } }, { status: { equals: 'assigned' } }, ...scopeOf(args.scope)] })
      for (const u of units) await set(payload, args.req, u.id, { status: 'ready', assignedTo: null, assignedAt: null })
      queued.delete(args.reference)
      return { released: units, cancelledRequests: [] }
    },
    shipUnits: async (payload: Payload, ids: (string | number)[], options: { req?: Req } = {}) => {
      start('shipUnits', options.req)
      for (const id of ids) {
        const [unit] = await find(payload, options.req, { id: { equals: id } })
        if (!unit) throw new FakeKittingError('unitNotFound', 'That unit doesn’t exist.')
        if (unit.status !== 'assigned') throw new FakeKittingError('unitStatus', `${unit.externalId} is ${unit.status}, so it can’t be shipped.`)
        await set(payload, options.req, unit.id, { status: 'shipped' })
      }
      return []
    },
    voidUnit: async (payload: Payload, unitID: string | number, args: { reason: string; note?: string; req?: Req }) => {
      start('voidUnit', args.req)
      const [unit] = await find(payload, args.req, { id: { equals: unitID } })
      if (!unit) throw new FakeKittingError('unitNotFound', 'That unit doesn’t exist.')
      if (unit.status === 'shipped') throw new FakeKittingError('unitShipped', `${unit.externalId} has shipped, so it can’t be voided.`)
      await set(payload, args.req, unit.id, { status: 'void', voidNote: args.note ?? null } as never)
      return unit
    },
    sendPendingAlerts: async () => {
      alerts.sent++
    },
  }
  return {
    collection,
    adapter,
    queued,
    calls,
    alerts,
    /** Ready units with these codes, as a build would make them. */
    build: async (payload: Payload, codes: string[], scope?: string) => {
      for (const externalId of codes) await payload.create({ collection: slug as never, data: { externalId, status: 'ready', ...(scope ? { [scopeField]: scope } : {}) } as never, overrideAccess: true })
    },
    unit: async (payload: Payload, externalId: string) => (await find(payload, undefined, { externalId: { equals: externalId } }))[0] ?? null,
    failNext: (call: KittingCall, code?: string) => (failures[call] ??= []).push(code ? new FakeKittingError(code, `made-up ${code}`) : new Error('made-up Kitting crash')),
    reset: () => {
      for (const k of Object.keys(failures) as KittingCall[]) failures[k] = []
      calls.length = 0
    },
  }
}
