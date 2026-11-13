import type { PayloadRequest } from 'payload'

import { normalizeKitCode } from './codes.js'
import { audit, idOf, inTransaction, KitError, ONE, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { findKit, lotProblem, type LotDoc, recordKitEvent } from './kits.js'
import { helpReasons } from './orderHelp.js'
import { replacedReason, saveFulfillment, type ReplaceReason } from './packing.js'
import type { KitStatus } from './status.js'
import type { KitDoc, KitOrder, ResolvedOptions } from './types.js'

/**
 * Replacements and credits back. A replacement is a free kit order for the same buyer and subject, carrying
 * the kit it replaces, so it goes through the packing queue like any order and never counts as a paid kit.
 * - lost, expired or damaged: one free replacement per subject (a second is refused). `damaged` only when the site
 *   turns it on (`orderHelp.reasons.damaged`; damaged kits are replaced, never refunded); a replacement for it closes the order's open damaged request;
 * - recalled: always replaced, and it doesn't use up the free one;
 * - failed: a new kit for each free retest (`policy.freeRetests`, default 1); after the last, a test goes back
 *   to the buyer through `payments.creditBack` (`policy.afterLastRetest: 'credit'`, the default), once per kit.
 */

export const REPLACE_REASONS: readonly ReplaceReason[] = ['lost', 'expired', 'recalled', 'failed', 'damaged']
/** The reasons that share one free replacement per subject. */
const ONE_FREE: readonly ReplaceReason[] = ['lost', 'expired', 'damaged']

/** Where a kit must be for each reason. */
const REPLACEABLE: Record<ReplaceReason, readonly KitStatus[]> = {
  lost: ['shipped', 'delivered', 'activated', 'sampled', 'lost'],
  expired: ['shipped', 'delivered', 'expired'],
  recalled: ['recalled'],
  failed: ['returned', 'at-lab', 'sequencing', 'results-in', 'analysis', 'failed'],
  // Arrived damaged: before a sample was taken.
  damaged: ['shipped', 'delivered', 'activated'],
}

export type ReplaceOutcome = { outcome: 'replacement'; code: string; order: string } | { outcome: 'credit'; code: string } | { outcome: 'none'; code: string }

/** Replace a sold kit, or give a test back after the last free retest (kit staff). */
export async function replaceKit(req: PayloadRequest, input: { code: string; reason: string; note?: string }): Promise<ReplaceOutcome> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const code = normalizeKitCode(input?.code)
  if (!code) throw new KitError('notACode', 'That isn’t a kit code.')
  const reason = input.reason as ReplaceReason
  if (!REPLACE_REASONS.includes(reason) || (reason === 'damaged' && !helpReasons(o).includes('damaged'))) throw new KitError('chooseReason', 'Choose why the kit needs replacing.')
  const note = input.note?.trim().slice(0, 300) || undefined
  const site = await siteOf(o, req)
  const freeRetests = Math.max(0, Math.floor(o.policy?.freeRetests ?? 1))
  const after = o.policy?.afterLastRetest ?? 'credit'
  return inTransaction(req, async (req) => {
    const kit = (await findKit(req, code, site)) as (KitDoc & { attempt?: number | null; replacementOf?: unknown }) | null
    if (!kit) throw new KitError('noKit', `Kit ${code} isn’t here.`, { code })
    if (kit.status === 'replaced') throw new KitError('alreadyReplaced', `Kit ${code} has already been replaced.`, { code })
    if (!kit.buyer || !kit.order) throw new KitError('notSold', `Kit ${code} wasn’t sold, so there’s nothing to replace.`, { code })
    if (!REPLACEABLE[reason].includes(kit.status)) throw new KitError('cantReplace', `Kit ${code} is ${kit.status}, so it can’t be replaced for that reason.`, { code, status: kit.status })
    if (reason === 'expired' && kit.status !== 'expired') {
      const lot = (await req.payload.findByID({ collection: 'kit-lots', id: idOf(kit.lot)!, ...ONE, req })) as unknown as LotDoc
      if (lotProblem({ ...lot, recalled: false })?.code !== 'expired') throw new KitError('notExpired', `Kit ${code}’s lot hasn’t expired.`, { code })
    }
    if (ONE_FREE.includes(reason)) {
      // One free replacement per subject for a lost, expired or damaged kit: look back along the replacements.
      let back = idOf(kit.replacementOf)
      for (let hops = 0; back && hops < 20; hops++) {
        const why = await replacedReason(req, back)
        if (why && ONE_FREE.includes(why)) throw new KitError('secondFree', 'This has already had its free replacement for a lost, expired or damaged kit.')
        const prev = (await req.payload.find({ collection: 'kits', where: { id: { equals: back } }, limit: 1, ...READ, req })).docs[0] as unknown as { replacementOf?: unknown } | undefined
        back = idOf(prev?.replacementOf)
      }
    }
    const order = idOf(kit.order)!
    const lastTry = reason === 'failed' && (kit.attempt ?? 1) >= 1 + freeRetests
    if (lastTry && after === 'credit' && !o.payments?.creditBack) throw new KitError('noPayments', 'Payments aren’t set up here, so no test can be given back.')
    // Damaged isn't a status: the trail says so in a note, and the kit's status moves to replaced below.
    if (reason === 'damaged') await recordKitEvent(req, kit, { type: 'note', source: 'admin', order, note: note ? `Arrived damaged: ${note}` : 'Arrived damaged', details: { damaged: true } })
    else if (reason !== 'recalled' && kit.status !== reason) await recordKitEvent(req, kit, { type: reason, source: 'admin', order, note })
    if (lastTry) {
      if (after === 'none') return { outcome: 'none' as const, code }
      // Once per kit, however often this is pressed: the trail remembers.
      const given = await req.payload.find({ collection: 'kit-events', where: { and: [{ kit: { equals: kit.id } }, { 'details.creditReturned': { exists: true } }] }, limit: 1, ...READ, req })
      if (!given.docs.length) {
        const credit = await o.payments!.creditBack({ kit, reason: `Kit ${code} failed on attempt ${kit.attempt ?? 1}`, key: `kit:${kit.id}`, req })
        await recordKitEvent(req, kit, { type: 'note', source: 'admin', order, note: `Failed on attempt ${kit.attempt ?? 1}: a test given back instead of another kit.`, details: { creditReturned: (credit && credit.id) || true } })
      }
      return { outcome: 'credit' as const, code }
    }
    const { docs } = await req.payload.find({ collection: o.collections.orders, where: { id: { equals: order } }, limit: 1, ...READ, req })
    const original = docs[0] as unknown as KitOrder | undefined
    if (!original) throw new KitError('noOrder', 'The kit’s order wasn’t found.')
    const own = o.orders?.replacement ? await o.orders.replacement({ order: original, kit, req }) : { customer: idOf(original.customer) ?? idOf(kit.buyer) }
    const line = (await o.subjects.lineFor?.({ kit, req })) ?? { kind: 'count' }
    const created = await req.payload.create({
      collection: o.collections.orders,
      data: {
        ...own,
        ...(o.scope ? { [o.scope.field]: site ?? idOf(kit[o.scope.field]) } : {}),
        kitLines: [{ ...line, quantity: 1, test: kit.test ?? o.tests[0]!.value }],
        kitFulfillment: { status: 'to-pack', replaces: kit.id },
      } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit(`replacement for kit ${code}`)),
    })
    await recordKitEvent(req, kit, { type: 'replaced', source: 'admin', order: String(created.id), note, details: { reason } })
    if (reason === 'damaged') await closeDamagedRequest(req, o, original, String(created.id), code)
    return { outcome: 'replacement' as const, code, order: String(created.id) }
  })
}

/** The buyer's open damaged request on this order, if any, is answered: replaced, with the new order. */
async function closeDamagedRequest(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, replacement: string, code: string) {
  const requests = order.kitFulfillment?.requests ?? []
  const open = requests.findIndex((r) => r.outcome === 'review' && !r.decidedAt && (r.reasons ?? []).includes('damaged'))
  if (open < 0) return
  const me = personOf(o, req)
  const updated = requests.map((r, i) => (i === open ? { ...r, id: undefined, outcome: 'replaced', decidedBy: me?.id ?? null, decidedAt: new Date().toISOString(), note: `Kit ${code} replaced: order ${replacement}`.slice(0, 300) } : { ...r, id: undefined }))
  await saveFulfillment(req, o, order, { requests: updated }, 'damaged request: replaced')
}

/** Kits sold from recalled lots that still need a replacement, oldest first (kit staff). */
export async function recalledAwaitingReplacement(req: PayloadRequest): Promise<KitDoc[]> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  return (await req.payload.find({ collection: 'kits', where: scoped(o, site, { and: [{ status: { equals: 'recalled' } }, { buyer: { exists: true } }, { buyer: { not_equals: null } }] }), sort: 'updatedAt', ...READ, req })).docs as unknown as KitDoc[]
}
