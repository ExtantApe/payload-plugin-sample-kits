import type { PayloadRequest } from 'payload'

import { activationLink, codesInRange, hashSecret, lotForCode, newSecret, normalizeKitCode, normalizeLotNumber, normalizeSecret, secretMatches } from './codes.js'
import { busy, isWriteConflict, audit, EVENT_WRITE, EVENT_WRITE_KEY, idOf, inTransaction, KitError, ONE, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq, topLevelFields } from './internal.js'
import { siteInfoFor } from './site.js'
import { ACTIVATABLE, KIT_EVENT_TYPES, type KitEventType, type KitStatus, statusAfter } from './status.js'
import type { KitDoc, ResolvedOptions, SubjectRef } from './types.js'

/**
 * The life of a kit, phase 1: lots, receiving built kits, the secret, activation and sampling. Every
 * change writes a kit event (the custody trail) and moves the kit's status with it, in one
 * transaction: the caller's when there is one, else a new one. Each action checks who may do it.
 */

export type LotDoc = { id: string | number; lotNumber: string; expiresOn?: string | null; recalled?: boolean | null; serialDigits?: number | null; recallReason?: string | null; [field: string]: unknown }

export type KitEvent = {
  type: KitEventType
  /** Who did it. Default: the request's person, if any. */
  actor?: { id: string | number } | null
  source?: 'scan' | 'admin' | 'customer' | 'portal' | 'carrier' | 'system'
  order?: string | null
  hub?: string | null
  lab?: string | null
  labBatch?: string | null
  file?: string | null
  note?: string
  details?: Record<string, unknown>
  /** Other kit fields to write with the event. Never `status`: that follows the event's type. */
  set?: Record<string, unknown>
}

/**
 * Writes one row of a kit's custody trail and moves the kit's status to match, in the caller's
 * transaction. The only way a kit's status changes. No access check: the action calling it checks.
 */
export async function recordKitEvent(req: PayloadRequest, kit: Pick<KitDoc, 'id'> & Record<string, unknown>, event: KitEvent): Promise<string> {
  const o = optionsOf(req.payload)
  if (!(KIT_EVENT_TYPES as readonly string[]).includes(event.type)) throw new Error(`"${event.type}" isn’t a kit event type.`)
  if (event.set && 'status' in event.set) throw new Error('A kit event can’t set the status: it follows the event’s type.')
  const at = new Date().toISOString()
  const actor = event.actor === undefined ? (personOf(o, req)?.id ?? null) : (event.actor?.id ?? null)
  const site = o.scope ? { [o.scope.field]: idOf(kit[o.scope.field]) } : {}
  await req.payload.create({
    collection: 'kit-events',
    data: {
      ...site,
      kit: kit.id,
      type: event.type,
      at,
      actor,
      source: event.source ?? 'admin',
      order: event.order ?? null,
      hub: event.hub ?? null,
      lab: event.lab ?? null,
      labBatch: event.labBatch ?? null,
      file: event.file ?? null,
      note: event.note?.slice(0, 300),
      details: event.details,
    } as never,
    overrideAccess: true,
    depth: 0,
    req: sysReq(req, audit(`kit ${event.type}`)),
  })
  const status = statusAfter(event.type)
  if (status || event.set)
    await req.payload.update({
      collection: 'kits',
      id: kit.id,
      data: { ...(event.set ?? {}), ...(status ? { status } : {}) } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, { ...audit(`kit ${event.type}`), [EVENT_WRITE_KEY]: EVENT_WRITE }),
    })
  return at
}

/** A kit by its code, on the request's site, with its secret hash (for the plugin's own checks only). */
export async function findKit(req: PayloadRequest, code: string, site?: string): Promise<KitDoc | null> {
  const o = optionsOf(req.payload)
  const normalized = normalizeKitCode(code)
  if (!normalized) return null
  const { docs } = await req.payload.find({ collection: 'kits', where: scoped(o, site, { code: { equals: normalized } }), limit: 1, showHiddenFields: true, ...READ, req })
  return (docs[0] as unknown as KitDoc) ?? null
}

const startOfToday = () => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** Why a lot can't be used right now, or null. */
export function lotProblem(lot: Pick<LotDoc, 'expiresOn' | 'recalled' | 'lotNumber'>): KitError | null {
  if (lot.recalled) return new KitError('recalled', `Lot ${lot.lotNumber} is recalled. Set this kit aside.`, { lot: lot.lotNumber })
  if (lot.expiresOn && new Date(lot.expiresOn) < startOfToday()) return new KitError('expired', `Lot ${lot.lotNumber} expired on ${lot.expiresOn.slice(0, 10)}. Set this kit aside.`, { lot: lot.lotNumber, date: lot.expiresOn.slice(0, 10) })
  return null
}

/** Refuses when any of these kits' lots is recalled or expired. Reads the lots again, so it holds even when a recall's processing didn't run. */
export async function assertLotsUsable(req: PayloadRequest, kits: Pick<KitDoc, 'lot'>[]) {
  const ids = [...new Set(kits.map((k) => idOf(k.lot)).filter(Boolean))] as string[]
  if (!ids.length) return
  const lots = (await req.payload.find({ collection: 'kit-lots', where: { id: { in: ids } }, ...READ, req })).docs as unknown as LotDoc[]
  if (lots.length !== ids.length) throw new KitError('recalled', 'A kit’s lot couldn’t be found. Set the kits aside and check them.', { lot: '?' })
  for (const lot of lots) {
    const problem = lotProblem(lot)
    if (problem) throw problem
  }
}

// ---------------------------------------------------------------- stock

export type LotInput = {
  lotNumber: string
  manufacturer?: string | null
  model?: string | null
  expiresOn?: string | null
  quantity?: number | null
  serialDigits?: number | null
  firstSerial?: number | null
  lastSerial?: number | null
}

/** Most kits added in one go (a lot is usually 50 to a few hundred). */
export const MAX_RANGE = 1000

/** A new lot (kit staff), and its kits when a serial range is given. Codes that already exist are skipped. */
export async function createLot(req: PayloadRequest, input: LotInput): Promise<{ lot: LotDoc; added: number }> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const lotNumber = normalizeLotNumber(input?.lotNumber)
  if (!lotNumber) throw new KitError('lotNumber', 'A lot number is 3 to 12 digits: the start of every kit code in the lot.')
  const serialDigits = Number(input.serialDigits ?? 6)
  const range = input.firstSerial != null && input.lastSerial != null ? codesInRangeChecked(lotNumber, Number(input.firstSerial), Number(input.lastSerial), serialDigits) : []
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const existing = await req.payload.find({ collection: 'kit-lots', where: scoped(o, site, { lotNumber: { equals: lotNumber } }), limit: 1, ...READ, req })
    if (existing.docs.length) throw new KitError('lotExists', `Lot ${lotNumber} is already here. Add kits to it by scanning them.`, { lot: lotNumber })
    const lot = (await req.payload.create({
      collection: 'kit-lots',
      data: {
        ...(o.scope ? { [o.scope.field]: site } : {}),
        lotNumber,
        manufacturer: input.manufacturer?.trim() || undefined,
        model: input.model?.trim() || undefined,
        expiresOn: input.expiresOn || undefined,
        receivedOn: new Date().toISOString(),
        quantity: input.quantity ?? (range.length || undefined),
        serialDigits,
      } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('lot added')),
    })) as unknown as LotDoc
    let added = 0
    for (const code of range) if ((await addKit(req, o, site, lot, code, 'admin')).added) added++
    return { lot, added }
  })
}

function codesInRangeChecked(lot: string, from: number, to: number, digits: number) {
  if (to - from + 1 > MAX_RANGE) throw new KitError('rangeTooBig', `Add at most ${MAX_RANGE} kits at a time.`, { max: MAX_RANGE })
  try {
    return codesInRange(lot, from, to, digits)
  } catch (error) {
    throw new KitError('range', (error as Error).message)
  }
}

async function addKit(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, lot: LotDoc, code: string, source: 'scan' | 'admin') {
  const existing = await findKit(req, code, site)
  if (existing) return { added: false, kit: existing }
  const kit = (await req.payload.create({
    collection: 'kits',
    data: { ...(o.scope ? { [o.scope.field]: site } : {}), code, lot: lot.id, test: o.tests[0]!.value } as never,
    overrideAccess: true,
    depth: 0,
    req: sysReq(req, audit('kit added to stock')),
  })) as unknown as KitDoc
  await recordKitEvent(req, kit, { type: 'received', source })
  return { added: true, kit: { ...kit, status: 'in-stock' as KitStatus } }
}

/**
 * One built kit into stock by its code (kit staff), inside the caller's transaction. The seam for
 * Kitting's `onBuild`: a kit exists once it's assembled. Its lot comes from the code.
 */
export async function addBuiltKit(req: PayloadRequest, input: string) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code. Kit codes are the 8 to 20 digits under the barcode.')
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const lots = (await req.payload.find({ collection: 'kit-lots', where: scoped(o, site, { id: { exists: true } }), ...READ, req })).docs as unknown as LotDoc[]
    const lot = lotForCode(code, lots)
    if (!lot) throw new KitError('unknownLot', `No lot matches ${code}. Add its lot first (usually the first 6 digits: ${code.slice(0, 6)}).`, { code, prefix: code.slice(0, 6) })
    const { added, kit } = await addKit(req, o, site, lot, code, 'scan')
    return { added, kit, code, lot: lot.lotNumber }
  })
}

export type ReceiveResult = { result: 'added' | 'already'; code: string; status: KitStatus; lot: string }

/** Scan a kit into stock (kit staff). An unknown lot asks the person to add it first. */
export async function receiveKit(req: PayloadRequest, input: string): Promise<ReceiveResult> {
  const { added, kit, code, lot } = await addBuiltKit(req, input)
  return { result: added ? 'added' : 'already', code, status: kit.status, lot }
}

// ---------------------------------------------------------------- the secret

export type IssuedSecret = { code: string; secret: string; link: string | null }

/**
 * A new one-time activation secret for a kit (kit staff), returned once and stored only as a hash.
 * Issuing again cancels the old one. Packing and the order slip (phase 2) call this for each kit.
 */
export async function issueSecret(req: PayloadRequest, input: { code: string }): Promise<IssuedSecret> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code.')
  const site = await siteOf(o, req)
  // The link's address comes from the plugin's options (`site.origin`), never from a page.
  const { origin } = await siteInfoFor(o, req, site)
  return inTransaction(req, async (req) => {
    const kit = await findKit(req, code, site)
    if (!kit) throw new KitError('unknownKit', `Kit ${code} isn’t here.`, { code })
    if (!ACTIVATABLE.includes(kit.status)) throw new KitError('slipTooLate', `Kit ${code} is ${kit.status}, so it can’t get a new secret.`, { code, status: kit.status })
    await assertLotsUsable(req, [kit])
    const secret = newSecret()
    await recordKitEvent(req, kit, { type: 'slip-made', order: idOf(kit.order), set: { secretHash: hashSecret(req.payload.config.secret, code, normalizeSecret(secret)!), secretIssuedAt: new Date().toISOString() } })
    return { code, secret, link: origin ? activationLink(origin, code, secret) : null }
  })
}

// ---------------------------------------------------------------- the keeper

const badSecret = () => new KitError('badSecret', 'That code and secret don’t match a kit. Check both against the order slip.')

const isRef = (v: unknown): v is SubjectRef =>
  Boolean(v) && typeof v === 'object' && typeof (v as SubjectRef).kind === 'string' && typeof (v as SubjectRef).id === 'string' && (v as SubjectRef).id.length > 0

/** Asks the subject provider; only exactly `true` passes, and a refusal keeps its own words. */
async function mustSample(o: ResolvedOptions, req: PayloadRequest, user: NonNullable<ReturnType<typeof personOf>>, ref: SubjectRef, kit: KitDoc) {
  const answer = await o.subjects.canSample({ user, ref, kit, req })
  if (answer === true) return
  const refusal = answer && typeof answer === 'object' ? answer : null
  throw new KitError(typeof refusal?.code === 'string' ? refusal.code : 'notYourSubject', typeof refusal?.message === 'string' ? refusal.message : 'Choose one of your own.')
}

/**
 * Activate a kit with its code and its secret, for a subject the person may sample. Whoever activates
 * becomes the kit's keeper, so kits can be given away with their slip. The secret is always needed: a
 * code alone, or a code given as its own secret, never activates. A missing kit, a wrong secret, a
 * used secret and a malformed one all get the same answer, so codes can't be probed.
 */
export async function activateKit(req: PayloadRequest, input: { code: string; secret: string; subject: SubjectRef }): Promise<{ code: string; label: string | null }> {
  const o = optionsOf(req.payload)
  const user = personOf(o, req)
  if (!user) throw new KitError('signIn', 'Sign in to activate a kit.')
  const code = normalizeKitCode(input?.code)
  const secret = typeof input?.secret === 'string' ? input.secret : ''
  if (!code || !normalizeSecret(secret)) throw badSecret()
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const kit = await findKit(req, code, site)
    if (!kit || !secretMatches(req.payload.config.secret, code, secret, kit.secretHash)) throw badSecret()
    // The lot first: a recalled kit should say so, not "already activated".
    const lot = (await req.payload.findByID({ collection: 'kit-lots', id: idOf(kit.lot)!, ...ONE, req })) as unknown as LotDoc
    if (lot.recalled || kit.status === 'recalled') throw new KitError('recalledCustomer', 'This kit can’t be used: its batch was recalled. We’ll send a replacement; please contact us.')
    if (!ACTIVATABLE.includes(kit.status))
      throw new KitError(idOf(kit.activatedBy) === String(user.id) ? 'alreadyYours' : 'alreadyActivated', idOf(kit.activatedBy) === String(user.id) ? 'You’ve already activated this kit.' : 'This kit has already been activated.')
    if (lotProblem(lot)) throw new KitError('expiredCustomer', 'This kit is past its use-by date. Please contact us for a replacement.')
    const ref = input.subject
    if (!isRef(ref) || (o.subjects.kinds && !o.subjects.kinds.includes(ref.kind))) throw new KitError('chooseSubject', 'Choose what you’re sampling.')
    await mustSample(o, req, user, ref, kit)
    const assigned = await o.subjects.assign({ kit, ref, req })
    const allowed = new Set(topLevelFields(o.subjects.fields).map((f) => f.name))
    if (!assigned || typeof assigned !== 'object' || Object.keys(assigned).some((k) => !allowed.has(k))) throw new Error('subjects.assign may only write the subject fields it brought.')
    const label = kit.identifierLabel || (await o.subjects.label?.({ ref, req })) || null
    // The claim: only where the kit can still be activated and its secret is still the one read above. Atomic in the
    // database, so it holds without transactions too: of two activations at once, one wins and the other is `busy`.
    const claimed = await req.payload.db
      .updateOne({
        collection: 'kits',
        where: { and: [{ id: { equals: kit.id } }, { status: { in: [...ACTIVATABLE] } }, { secretHash: { equals: kit.secretHash } }] },
        data: { secretHash: null, updatedAt: new Date().toISOString() },
        req,
      } as never)
      .catch((error: unknown) => {
        if (isWriteConflict(error)) throw busy()
        throw error
      })
    if (!claimed) throw busy()
    await recordKitEvent(req, kit, {
      type: 'activated',
      actor: user,
      source: 'customer',
      // The secret has done its job: it can't activate anything again.
      set: { ...assigned, activatedBy: user.id, activatedAt: new Date().toISOString(), secretHash: null, identifierLabel: label },
    })
    return { code, label }
  })
}

/** Most of a confirmed record kept on the event, as JSON. */
const MAX_CONFIRMED = 20_000

/** The guided activation flow registered with Wizards: find the kit, choose the subject, the safety steps, sampled. */
export const KIT_ACTIVATION_FLOW = 'kit-activation'

const STEP_PROBLEMS: Record<string, [string, string]> = {
  changed: ['stepsChanged', 'The steps changed while you were reading them. Read the new wording and confirm again.'],
  noSteps: ['stepsUnavailable', 'The safety steps aren’t set up yet, so a sample can’t be recorded. Please contact us.'],
  unknownFlow: ['stepsUnavailable', 'The safety steps aren’t set up yet, so a sample can’t be recorded. Please contact us.'],
}

/**
 * The keeper says the sample is in the tube.
 * - With Wizards wired (`adapters.wizards`), the guided steps' `answers` (and the `locale` they were read in) are
 *   checked here, on the server, with Wizards' own `answersFor`; anything but ok is refused, so a client can't skip a
 *   gate. The record it returns is kept on the event's details as `confirmed`. A `confirmed` sent by the client is
 *   refused: only the server's record counts.
 * - Without Wizards, `confirmed` is whatever record the site's own steps made, kept as plain JSON.
 */
export async function markSampled(req: PayloadRequest, input: { code: string; confirmed?: Record<string, unknown>; answers?: unknown; locale?: string }): Promise<{ code: string }> {
  const o = optionsOf(req.payload)
  const user = personOf(o, req)
  if (!user) throw new KitError('signIn', 'Sign in to do that.')
  const code = normalizeKitCode(input?.code)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code.')
  const wizards = o.adapters?.wizards
  if (wizards && input.confirmed !== undefined) throw new KitError('badConfirmed', 'The confirmed steps come from the server here. Send the answers instead.')
  let confirmed: Record<string, unknown> | undefined
  if (!wizards && input.confirmed !== undefined) {
    const json = (() => {
      try {
        return JSON.stringify(input.confirmed)
      } catch {
        return null
      }
    })()
    if (!json || json.length > MAX_CONFIRMED || typeof input.confirmed !== 'object' || input.confirmed === null || Array.isArray(input.confirmed))
      throw new KitError('badConfirmed', 'The confirmed steps couldn’t be recorded.')
    confirmed = JSON.parse(json) as Record<string, unknown>
  }
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const kit = await findKit(req, code, site)
    if (!kit || idOf(kit.activatedBy) !== String(user.id)) throw new KitError('notYourKit', 'That kit isn’t one you’ve activated.')
    if (kit.status !== 'activated') throw new KitError('notActivated', 'Only an activated kit can be marked as sampled.')
    const ref = o.subjects.sampledOf(kit)
    if (!isRef(ref)) throw new KitError('notYourSubject', 'This kit has no subject to sample.')
    await mustSample(o, req, user, ref, kit)
    if (wizards) {
      const locale = typeof input.locale === 'string' && input.locale ? input.locale : undefined
      const checked = await wizards.answersFor(req.payload, { flow: KIT_ACTIVATION_FLOW, answers: input.answers, ...(locale ? { locale } : {}) }).catch(() => ({ ok: false as const, problem: 'unknownFlow', key: undefined as string | undefined }))
      // Only exactly ok passes: a thrown error, a missing record or anything else refuses.
      if (!checked || checked.ok !== true || !checked.record || typeof checked.record !== 'object') {
        const problem = checked && checked.ok === false ? String(checked.problem) : 'badAnswers'
        const [kitCode, message] = STEP_PROBLEMS[problem] ?? ['stepsIncomplete', 'Go through every step, and confirm each one, before marking the sample taken.']
        throw new KitError(kitCode, message, { problem, ...(checked && checked.ok === false && checked.key ? { step: checked.key } : {}) })
      }
      confirmed = JSON.parse(JSON.stringify(checked.record)) as Record<string, unknown>
    }
    await recordKitEvent(req, kit, { type: 'sampled', actor: user, source: 'customer', details: confirmed ? { confirmed } : undefined, set: { sampledAt: new Date().toISOString() } })
    return { code }
  })
}
