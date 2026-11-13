import type { PayloadRequest } from 'payload'

import { audit, idOf, inTransaction, KitError, optionsOf, personOf, READ, requireStaff, scoped, siteOf, withCarried } from './internal.js'
import { type LotDoc, recordKitEvent } from './kits.js'
import type { KitStatus } from './status.js'
import { saveFulfillment, unpackedFields } from './packing.js'
import type { KitDoc, KitOrder } from './types.js'
import { assignInTransaction, kittingAfterCommit, kittingOf, requireSharedTransaction, unitsNeeded, voidRecalled } from './kitting.js'

/**
 * Recalls fail closed. Ticking "recalled" on a lot, from the admin or `recallLot`, runs `applyRecall`
 * in the same transaction: kits in stock are set aside, kits packed but not shipped are taken out of
 * their order (their secret canceled, and the order put back in the packing queue), and kits sold but not yet sampled are marked recalled.
 * Kits sampled before the recall keep their status and get a note, so staff decide about their
 * results. Activation, packing, the slip and shipping check the lot again, so a recalled kit
 * can't be used even if this processing never ran.
 */

/** Kits that a recall marks "recalled": not used yet. */
const RECALLABLE: readonly KitStatus[] = ['in-stock', 'packed', 'shipped', 'delivered', 'activated']
/** Kits already off the usual path: a recall leaves them alone. */
const SETTLED: readonly KitStatus[] = ['lost', 'expired', 'failed', 'replaced', 'void', 'recalled']

export type RecallSummary = { setAside: number; unpacked: number; sold: number; sampled: number }

export async function applyRecall(req: PayloadRequest, lot: LotDoc): Promise<RecallSummary> {
  const o = optionsOf(req.payload)
  const actor = personOf(o, req)
  const site = o.scope ? (idOf(lot[o.scope.field]) ?? undefined) : undefined
  await requireSharedTransaction(o, req)
  const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { lot: { equals: lot.id } }), sort: 'code', ...READ, req })).docs as unknown as KitDoc[]
  const summary: RecallSummary = { setAside: 0, unpacked: 0, sold: 0, sampled: 0 }
  // Without the reason's closing full stop: a sentence is added after it for kits already sampled.
  const reason = lot.recallReason?.trim().replace(/[.!]+$/, '')
  const note = reason ? `Lot ${lot.lotNumber} recalled: ${reason}` : `Lot ${lot.lotNumber} recalled`
  // Taking a kit out of its order clears what packing wrote, the subject fields included.
  const unpack = unpackedFields(o)
  const reopen = new Set<string>()
  for (const kit of kits) {
    if (SETTLED.includes(kit.status)) continue
    if (!RECALLABLE.includes(kit.status)) {
      // Sampled or further: the sample exists. Staff decide whether its result stands.
      await recordKitEvent(req, kit, { type: 'note', actor, source: 'system', note: `${note}, after this kit was sampled. Check before trusting its result.` })
      summary.sampled++
      continue
    }
    const order = idOf(kit.order)
    if (kit.status === 'packed' && order) {
      // In a box that hasn't shipped: out of the order, and its secret canceled. The order goes back to packing.
      await recordKitEvent(req, kit, { type: 'recalled', actor, source: 'system', order, note, details: { unpackedFrom: order }, set: { ...unpack, attempt: 1 } })
      reopen.add(order)
      summary.unpacked++
    } else {
      await recordKitEvent(req, kit, { type: 'recalled', actor, source: 'system', order, note })
      if (kit.status === 'in-stock') summary.setAside++
      else summary.sold++
    }
  }
  // Kitting wired: the lot's units still ready or assigned are voided, in this transaction.
  if (kittingOf(o)) await voidRecalled(req, o, site, kits.map((k) => k.code), note)
  for (const id of reopen) {
    const { docs } = await req.payload.find({ collection: o.collections.orders, where: { id: { equals: id } }, limit: 1, ...READ, req })
    const order = docs[0] as unknown as KitOrder | undefined
    const status = order?.kitFulfillment?.status
    if (order && (status === 'packed' || status === 'to-pack')) await saveFulfillment(req, o, order, { status: 'to-pack' }, 'kit recalled out of the order')
    // Each reopened order is given back the units it lost, so its next packing scan doesn't push a good unit back to ready.
    if (order && kittingOf(o)) {
      const total = (order.kitLines ?? []).reduce((n, l) => n + Number(l.quantity ?? 0), 0)
      await assignInTransaction(req, o, site, id, await unitsNeeded(req, o, site, id, total))
    }
  }
  if (kittingOf(o)) kittingAfterCommit(o, req)
  return summary
}

/** Recall a lot (kit staff): ticks it, which runs `applyRecall` through the lot's hook, in one transaction. */
export async function recallLot(req: PayloadRequest, input: { lotNumber: string; reason: string }): Promise<{ lot: string }> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const why = String(input?.reason ?? '').trim()
  if (!why) throw new KitError('recallReason', 'Say why the lot is recalled. Staff and the custody trail see it.')
  const site = await siteOf(o, req)
  return inTransaction(req, async (req) => {
    const { docs } = await req.payload.find({ collection: 'kit-lots', where: scoped(o, site, { lotNumber: { equals: String(input.lotNumber ?? '').trim() } }), limit: 1, ...READ, req })
    const lot = docs[0] as unknown as LotDoc | undefined
    if (!lot) throw new KitError('noLot', 'That lot isn’t here.')
    if (lot.recalled) throw new KitError('alreadyRecalled', `Lot ${lot.lotNumber} is already recalled.`, { lot: lot.lotNumber })
    // With the person's request, so the recall's events name them.
    await req.payload.update({ collection: 'kit-lots', id: lot.id, data: { recalled: true, recallReason: why.slice(0, 1000) } as never, overrideAccess: true, depth: 0, req, context: withCarried(req, audit('lot recalled')) })
    return { lot: lot.lotNumber }
  })
}
