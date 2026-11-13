import type { PayloadRequest } from 'payload'

import { planBoxes } from './boxes.js'
import { normalizeKitCode } from './codes.js'
import { errName, afterCommit, audit, freshReq, idOf, inTransaction, isStaff, KitError, ONE, optionsOf, passes, personOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { labPortalOf, siteInfoFor } from './site.js'
import { findKit, recordKitEvent } from './kits.js'
import { recordNotices, sendNotices } from './notices.js'
import { CHECKABLE_IN } from './status.js'
import type { KitDoc, NoticeDelivery, ResolvedOptions } from './types.js'

/**
 * Hubs, labs and lab batches. Returned kits are checked in at a hub (kit staff, by scan or typed), go into a lab
 * batch, and the batch ships to its lab with a notice: tracking numbers and a kit list, kept on the batch and sent
 * through `notify` after the commit. The lab's portal users confirm receipt and upload results (`results.ts`).
 *
 * A lab sees kit codes, statuses and tests, and nothing else: never a buyer, a keeper, an address, a subject or a
 * result. Every change is a kit event, in one transaction.
 */

export type LabHubDoc = { id: string | number; name: string; operators?: unknown[] | null; defaultReturn?: boolean | null; active?: boolean | null; [field: string]: unknown }
export type LabDoc = {
  id: string | number
  name: string
  active?: boolean | null
  placeholder?: boolean | null
  batchSizes?: number[] | null
  fileNaming?: string | null
  portalUsers?: unknown[] | null
  contacts?: { name?: string | null; email: string; notices?: boolean | null }[] | null
  [field: string]: unknown
}
export type BatchStatus = 'assembling' | 'shipped' | 'received' | 'complete' | 'cancelled'
export type BatchDoc = {
  id: string | number
  title?: string | null
  number: number
  size: number
  lab: unknown
  hub?: unknown
  status: BatchStatus
  shippedAt?: string | null
  receivedAt?: string | null
  trackingNumbers?: string[] | null
  notice?: { delivery?: string | null; to?: string[] | null; subject?: string | null; text?: string | null; csv?: string | null; at?: string | null } | null
  [field: string]: unknown
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const notACode = () => new KitError('notACode', 'That isn’t a kit code. Kit codes are the 8 to 20 digits under the barcode.')

// ---------------------------------------------------------------- who works where

/**
 * The hub a person works at on this site: the one asked for, else the one listing them as an operator, else the
 * site's default return hub, else its first active hub.
 */
export async function hubOf(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, hubId?: string | null): Promise<LabHubDoc | null> {
  const hubs = (await req.payload.find({ collection: 'hubs', where: scoped(o, site, { active: { not_equals: false } }), sort: 'createdAt', ...READ, req })).docs as unknown as LabHubDoc[]
  if (hubId) return hubs.find((h) => String(h.id) === String(hubId)) ?? null
  const me = personOf(o, req)
  return hubs.find((h) => me && (h.operators ?? []).some((u) => idOf(u) === String(me.id))) ?? hubs.find((h) => h.defaultReturn) ?? hubs[0] ?? null
}

/**
 * May this request use the lab portal for `lab`? Kit staff (uploading for the lab), or a signed-in person listed on
 * the lab's `portalUsers` whom `scope.isLabUser` (when given) answers exactly `true` for.
 */
export async function canUseLab(o: ResolvedOptions, req: PayloadRequest, lab: LabDoc): Promise<boolean> {
  if (await isStaff(o, req)) return true
  const me = personOf(o, req)
  if (!me || !(lab.portalUsers ?? []).some((u) => idOf(u) === String(me.id))) return false
  if (!o.scope?.isLabUser) return true
  return passes((r) => o.scope!.isLabUser!(r, lab), req)
}

/** A lab on this site that this request may act for. The same answer for "no such lab", "another site's" and "not yours". */
async function labFor(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, labId: unknown): Promise<LabDoc> {
  const id = idOf(labId)
  const lab = id && ID.test(id) ? ((await req.payload.find({ collection: 'labs', where: scoped(o, site, { id: { equals: id } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))).docs[0] as unknown as LabDoc | undefined) : undefined
  if (!lab || !(await canUseLab(o, req, lab))) throw new KitError('notLab', 'Only this lab’s portal users can do this.')
  return lab
}
export { labFor as labForRequest }

/** The labs this request may use the portal for, on this site. */
export async function labsFor(req: PayloadRequest): Promise<{ id: string; name: string }[]> {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) return []
  const site = await siteOf(o, req)
  const labs = (await req.payload.find({ collection: 'labs', where: scoped(o, site, { active: { not_equals: false } }), sort: 'name', ...READ, req })).docs as unknown as LabDoc[]
  const out: { id: string; name: string }[] = []
  for (const lab of labs) if (await canUseLab(o, req, lab)) out.push({ id: String(lab.id), name: lab.name })
  return out
}

// ---------------------------------------------------------------- hub check-in

export type CheckInResult = { code: string; result: 'checked-in' | 'already'; hub: string; warnings: ('notSampled' | 'otherHub')[] }

/**
 * Check a returned kit in at the hub (kit staff), scanned or typed. Only kits a keeper activated can come back: an
 * unactivated kit isn't linked to a subject, so it's refused and set aside. A kit that wasn't marked sampled, or that
 * was meant for another hub, is taken with a warning. The keeper is told their sample arrived (`kit-arrived`, through
 * `notify` after the commit), once per kit.
 */
export async function checkInKit(req: PayloadRequest, input: { code: string; hub?: string }): Promise<CheckInResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw notACode()
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const hub = await hubOf(req, o, site, input?.hub ?? null)
    if (!hub) throw new KitError('noHub', input?.hub ? 'That hub isn’t on this site.' : 'Add a hub in the admin first.')
    const kit = await findKit(req, code, site)
    if (!kit) throw new KitError('unknownKit', `Kit ${code} isn’t in stock here. Receive it into stock first.`, { code })
    const keeper = idOf(kit.activatedBy)
    const arrivedKey = `kit:${kit.id}|arrived|keeper:${keeper ?? ''}`
    // The keeper's "your sample arrived", sent after the commit; a scan again sends one that failed before.
    afterCommit(req, () => sendNotices(req.payload, { noticeKey: { equals: arrivedKey } }))
    if (kit.status === 'returned') return { code, result: 'already' as const, hub: hub.name, warnings: [] }
    if (['in-stock', 'packed', 'shipped', 'delivered'].includes(kit.status))
      throw new KitError('notActivatedYet', `Kit ${code} was never activated, so it isn’t linked to what was sampled. Set it aside and contact the keeper.`, { code })
    if (!CHECKABLE_IN.includes(kit.status)) throw new KitError('cantCheckIn', `Kit ${code} can’t be checked in: it’s ${kit.status}.`, { code, status: kit.status })
    const warnings: CheckInResult['warnings'] = []
    if (kit.status === 'activated') warnings.push('notSampled')
    const meantFor = idOf(kit.hub)
    if (meantFor && meantFor !== String(hub.id)) warnings.push('otherHub')
    await recordKitEvent(req, kit, { type: 'returned', source: 'scan', hub: String(hub.id), note: warnings.length ? warnings.join(', ') : undefined, set: { hub: hub.id } })
    // Only the keeper hears it, never a gift's buyer: kit codes only, nothing about the hub, the subject or a result.
    if (keeper)
      await recordNotices(req, o, [{ key: arrivedKey, kind: 'kit-arrived', audience: 'keeper', user: keeper, toBuyer: idOf(kit.buyer) !== null && idOf(kit.buyer) === String(keeper), order: idOf(kit.order), site, tracking: null, kits: [String(kit.id)], data: { event: 'arrived', leg: 'return', kits: 1, codes: [kit.code] } }])
    return { code, result: 'checked-in' as const, hub: hub.name, warnings }
  })
}

// ---------------------------------------------------------------- lab batches (kit staff)

async function getBatch(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, batchId: unknown): Promise<BatchDoc> {
  const id = idOf(batchId)
  const batch = id && ID.test(id) ? ((await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { id: { equals: id } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))).docs[0] as unknown as BatchDoc | undefined) : undefined
  if (!batch) throw new KitError('noBatch', 'That batch wasn’t found.')
  return batch
}

const batchKits = async (req: PayloadRequest, o: ResolvedOptions, site: string | undefined, batchId: unknown) =>
  (await req.payload.find({ collection: 'kits', where: scoped(o, site, { labBatch: { equals: idOf(batchId) } }), sort: 'code', ...READ, req })).docs as unknown as KitDoc[]

const batchTitle = (n: number, lab: string) => `Batch ${n} · ${lab}`

/** A new, empty batch for a lab (kit staff), at the person's hub. `size` defaults to the lab's smallest accepted size. */
export async function createBatch(req: PayloadRequest, input: { lab: string; size?: number | null; hub?: string }): Promise<BatchDoc> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const id = idOf(input?.lab)
    const lab = id && ID.test(id) ? ((await req.payload.find({ collection: 'labs', where: scoped(o, site, { id: { equals: id } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))).docs[0] as unknown as LabDoc | undefined) : undefined
    if (!lab || lab.active === false) throw new KitError('noLab', 'Choose a lab.')
    const size = Number(input.size || Math.min(...(lab.batchSizes?.length ? lab.batchSizes : [24])))
    if (!Number.isInteger(size) || size < 1 || size > 500) throw new KitError('batchSize', 'A batch holds 1 to 500 kits.')
    const hub = await hubOf(req, o, site, input?.hub ?? null)
    // Numbers count up per site; the unique index on (site, number) stops two new batches taking one number.
    const last = (await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { number: { exists: true } }), sort: '-number', limit: 1, ...ONE, req })).docs[0] as unknown as BatchDoc | undefined
    const number = (last?.number ?? 0) + 1
    return (await req.payload.create({
      collection: 'lab-batches',
      data: { ...(o.scope ? { [o.scope.field]: site } : {}), number, title: batchTitle(number, lab.name), size, lab: lab.id, hub: hub?.id ?? null, status: 'assembling' } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('lab batch started')),
    })) as unknown as BatchDoc
  })
}

export type BatchScanResult = { code: string; count: number; size: number }

/** Scan a checked-in kit into a batch that's still being filled (kit staff). */
export async function batchKit(req: PayloadRequest, input: { batch: string; code: string }): Promise<BatchScanResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw notACode()
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const batch = await getBatch(req, o, site, input.batch)
    if (batch.status !== 'assembling') throw new KitError('batchClosed', 'This batch has already shipped.')
    const kit = await findKit(req, code, site)
    if (!kit) throw new KitError('unknownKit', `Kit ${code} isn’t in stock here. Receive it into stock first.`, { code })
    if (idOf(kit.labBatch) === String(batch.id)) throw new KitError('alreadyInBatch', `Kit ${code} is already in this batch.`, { code })
    if (kit.labBatch) throw new KitError('inOtherBatch', `Kit ${code} is already in another batch.`, { code })
    if (kit.status !== 'returned') throw new KitError('notCheckedIn', `Check kit ${code} in at the hub first: it’s ${kit.status}.`, { code, status: kit.status })
    const count = (await batchKits(req, o, site, batch.id)).length
    if (count >= batch.size) throw new KitError('batchFull', `This batch already has all ${batch.size} kits.`, { size: batch.size })
    // Claimed only if no other batch has it, so two people can't put one kit in two batches.
    const claimed = await req.payload.update({
      collection: 'kits',
      where: { and: [{ id: { equals: kit.id } }, { or: [{ labBatch: { exists: false } }, { labBatch: { equals: null } }] }] },
      data: { labBatch: batch.id } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('kit batched')),
    })
    if (claimed.docs.length !== 1) throw new KitError('inOtherBatch', `Kit ${code} is already in another batch.`, { code })
    await recordKitEvent(req, kit, { type: 'batched', source: 'scan', lab: idOf(batch.lab), labBatch: String(batch.id) })
    return { code, count: count + 1, size: batch.size }
  })
}

/** Take a kit back out of a batch before it ships (kit staff). */
export async function unbatchKit(req: PayloadRequest, input: { batch: string; code: string }): Promise<{ code: string }> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw notACode()
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const batch = await getBatch(req, o, site, input.batch)
    if (batch.status !== 'assembling') throw new KitError('batchClosed', 'This batch has already shipped.')
    const kit = await findKit(req, code, site)
    if (!kit || idOf(kit.labBatch) !== String(batch.id)) throw new KitError('notInBatch', `Kit ${code} isn’t in this batch.`, { code })
    await recordKitEvent(req, kit, { type: 'unbatched', source: 'scan', labBatch: String(batch.id), set: { labBatch: null } })
    return { code }
  })
}

/** The lab's name for a kit's test. */
export const markerOf = (o: ResolvedOptions, test: string | null | undefined) => {
  const t = o.tests.find((x) => x.value === (test ?? o.tests[0]!.value))
  return t?.marker ?? t?.value ?? test ?? ''
}

/**
 * The notice for the lab: plain text and a CSV kit list. Kit codes and tests only: nothing about buyers, keepers,
 * subjects, addresses or results.
 */
export function labNotice(input: { site: string; lab: string; batch: number; shippedOn: string; tracking: string[]; kits: { code: string; marker: string }[]; portal: string | null; fileNaming?: string | null }) {
  const subject = `${input.site}: batch ${input.batch} shipped, ${input.kits.length} samples, tracking ${input.tracking.join(', ')}`
  const text = [
    `Hello ${input.lab},`,
    '',
    `Batch ${input.batch} from ${input.site} shipped on ${input.shippedOn}.`,
    `Tracking: ${input.tracking.join(', ')}`,
    `Samples: ${input.kits.length}. The kit list is attached as a CSV and repeated below.`,
    '',
    ...input.kits.map((k) => `${k.code}  ${k.marker}`),
    '',
    input.portal ? `Please confirm receipt and upload results at ${input.portal}` : 'Please confirm receipt and upload results in the lab portal.',
    `Name each result file with the kit code${input.fileNaming ? ` (${input.fileNaming.trim()})` : ', e.g. 275864000115.fasta'}, or put the kit code at the start of the FASTA header.`,
    '',
    'Thank you.',
  ].join('\n')
  const csv = ['kit_code,marker,batch', ...input.kits.map((k) => `${k.code},${k.marker},${input.batch}`)].join('\n')
  return { subject, text, csv }
}

export type BatchDelivery = NoticeDelivery | 'no-contacts'
export type ShipBatchResult = { kits: number; delivery: BatchDelivery | 'pending' }

const TRACKING = /^[A-Z0-9]{8,40}$/

/**
 * Ship a batch to its lab (kit staff), with the tracking numbers from its label. A size the lab doesn't list needs
 * `oddSizeOk`. The notice is kept on the batch in the same transaction, and sent through `notify` after the commit;
 * how that went is recorded on the batch. `delivery` is `'pending'` when the caller holds the transaction.
 */
export async function shipBatch(req: PayloadRequest, input: { batch: string; tracking: string[]; oddSizeOk?: boolean }): Promise<ShipBatchResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const tracking = (Array.isArray(input?.tracking) ? input.tracking : []).map((t) => String(t).replace(/\s/g, '').toUpperCase()).filter((t) => TRACKING.test(t)).slice(0, 20)
  if (!tracking.length) throw new KitError('noTracking', 'Enter the tracking number from the label.')
  const site = await siteOf(o, req)
  // The site's name and portal address come from the plugin's options, never from the page.
  const info = await siteInfoFor(o, req, site)
  const outer = req
  const state: { delivery: BatchDelivery | 'pending' } = { delivery: 'pending' }
  const result = await inTransaction(req, async (req) => {
    const batch = await getBatch(req, o, site, input.batch)
    if (batch.status !== 'assembling') throw new KitError('batchClosed', 'This batch has already shipped.')
    const kits = await batchKits(req, o, site, batch.id)
    if (!kits.length) throw new KitError('batchEmpty', 'Scan kits into the batch first.')
    const lab = (await req.payload.findByID({ collection: 'labs', id: idOf(batch.lab)!, ...ONE, req })) as unknown as LabDoc
    const sizes = lab.batchSizes ?? []
    if (sizes.length && !sizes.includes(kits.length) && !input.oddSizeOk)
      throw new KitError('oddSize', `The lab takes batches of ${sizes.join(', ')}; this one has ${kits.length}. Tick the box to ship it anyway.`, { sizes: sizes.join(', '), n: kits.length })
    const boxTypes = (await req.payload.find({ collection: 'box-types', where: scoped(o, site, { active: { not_equals: false } }), ...READ, req })).docs.map((b) => ({
      id: String(b.id),
      name: String(b.name),
      kitsPerBox: Number(b.kitsPerBox),
      emptyWeightOz: (b as { emptyWeightOz?: number | null }).emptyWeightOz ?? null,
    }))
    const at = new Date().toISOString()
    const notice = labNotice({
      site: info.name?.trim().slice(0, 100) || 'Sample Kits',
      lab: lab.name,
      batch: batch.number,
      shippedOn: at.slice(0, 10),
      tracking,
      kits: kits.map((k) => ({ code: k.code, marker: markerOf(o, k.test) })),
      portal: labPortalOf(info),
      fileNaming: lab.placeholder ? null : lab.fileNaming,
    })
    const to = (lab.contacts ?? []).filter((c) => c.notices !== false && c.email).map((c) => c.email)
    for (const kit of kits) await recordKitEvent(req, kit, { type: 'sent-to-lab', lab: String(lab.id), labBatch: String(batch.id), details: { tracking } })
    const delivery: BatchDelivery | null = !to.length ? 'no-contacts' : o.notify ? null : 'not-sent-side-effects-off'
    await req.payload.update({
      collection: 'lab-batches',
      id: batch.id,
      data: { status: 'shipped', shippedAt: at, trackingNumbers: tracking, plan: planBoxes(kits.length, boxTypes), notice: { ...notice, to, delivery, at } } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('lab batch shipped')),
    })
    if (delivery) state.delivery = delivery
    else afterCommit(outer, () => tellLab(outer, o, String(batch.id), String(lab.id), to, notice, state))
    return { kits: kits.length }
  })
  return { kits: result.kits, delivery: state.delivery }
}

const DELIVERIES: NoticeDelivery[] = ['sent', 'not-sent-side-effects-off', 'not-sent-test-addresses', 'no-address', 'failed']

/** After the commit: the lab's notice through `notify`, and a record on the batch of how it went. */
async function tellLab(req: PayloadRequest, o: ResolvedOptions, batch: string, lab: string, to: string[], notice: { subject: string; text: string; csv: string }, state: { delivery: BatchDelivery | 'pending' }) {
  let delivery: NoticeDelivery
  try {
    const answer = await o.notify!({ kind: 'lab-batch-shipped', to: { user: null, order: null, lab, emails: to }, data: { batch, ...notice }, req })
    delivery = answer && DELIVERIES.includes(answer) ? answer : 'sent'
  } catch (error) {
    req.payload.logger.warn({ err: errName(error), batch }, 'Sample Kits: the lab notice failed')
    delivery = 'failed'
  }
  state.delivery = delivery
  await inTransaction(freshReq(req), async (r) => {
    const fresh = (await r.payload.findByID({ collection: 'lab-batches', id: batch, ...ONE, req: r })) as unknown as BatchDoc
    await r.payload.update({ collection: 'lab-batches', id: batch, data: { notice: { ...(fresh.notice ?? {}), delivery: delivery === 'no-address' ? 'no-contacts' : delivery, at: new Date().toISOString() } } as never, overrideAccess: true, depth: 0, req: sysReq(r, audit(`lab notice ${delivery}`)) })
  })
}

// ---------------------------------------------------------------- the lab's portal

/** The lab confirms a shipped batch arrived (its portal users, or kit staff): its kits move to "at the lab". */
export async function confirmBatchReceived(req: PayloadRequest, input: { batch: string }): Promise<{ kits: number; already: boolean }> {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('notLab', 'Only this lab’s portal users can do this.')
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    // The same answer for "no such batch" and "not your lab's".
    const batch = await getBatch(req, o, site, input?.batch).catch(() => {
      throw new KitError('notLab', 'Only this lab’s portal users can do this.')
    })
    await labFor(req, o, site, batch.lab)
    if (batch.status === 'received' || batch.status === 'complete') return { kits: 0, already: true }
    if (batch.status !== 'shipped') throw new KitError('batchNotShipped', 'This batch hasn’t shipped yet.')
    const kits = await batchKits(req, o, site, batch.id)
    let moved = 0
    for (const kit of kits)
      if (kit.status === 'returned') {
        await recordKitEvent(req, kit, { type: 'at-lab', source: 'portal', lab: idOf(batch.lab), labBatch: String(batch.id) })
        moved++
      }
    await req.payload.update({ collection: 'lab-batches', id: batch.id, data: { status: 'received', receivedAt: new Date().toISOString() } as never, overrideAccess: true, depth: 0, req: sysReq(req, audit('lab batch received')) })
    return { kits: moved, already: false }
  })
}

export type PortalBatch = { id: string; number: number; title: string | null; status: BatchStatus; shippedAt: string | null; receivedAt: string | null; trackingNumbers: string[]; kits: { code: string; status: string; marker: string }[] }

/**
 * The lab portal's view of one lab (its portal users, or kit staff): batches sent to it, newest first, with each
 * kit's code, status and marker. Nothing else about a kit is read out.
 */
export async function labPortal(req: PayloadRequest, input: { lab: string }): Promise<{ lab: { id: string; name: string; fileNaming: string | null }; batches: PortalBatch[] }> {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('notLab', 'Only this lab’s portal users can do this.')
  const site = await siteOf(o, req)
  const lab = await labFor(req, o, site, input?.lab)
  const batches = (await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { and: [{ lab: { equals: lab.id } }, { status: { in: ['shipped', 'received', 'complete'] } }] }), sort: '-number', limit: 50, ...ONE, req })).docs as unknown as BatchDoc[]
  const out: PortalBatch[] = []
  for (const b of batches) {
    const kits = await batchKits(req, o, site, b.id)
    out.push({
      id: String(b.id),
      number: b.number,
      title: b.title ?? null,
      status: b.status,
      shippedAt: b.shippedAt ?? null,
      receivedAt: b.receivedAt ?? null,
      trackingNumbers: b.trackingNumbers ?? [],
      kits: kits.map((k) => ({ code: k.code, status: k.status, marker: markerOf(o, k.test) })),
    })
  }
  return { lab: { id: String(lab.id), name: lab.name, fileNaming: lab.placeholder ? null : (lab.fileNaming ?? null) }, batches: out }
}
