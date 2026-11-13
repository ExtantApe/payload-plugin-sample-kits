import type { Payload, PayloadRequest } from 'payload'

import { afterCommit, idOf, inTransaction, optionsOf, READ } from './internal.js'
import { recordKitEvent } from './kits.js'
import { recordNotices, sendNotices, type PlannedNotice } from './notices.js'
import { buyerOf, getKitOrder, orderKits, siteOfRecord } from './packing.js'
import { applyRefundEvent } from './returns.js'
import type { KitDoc, KitOrder, ResolvedOptions } from './types.js'

/**
 * Carrier tracking for kits, from Shipping's webhook (the plugin registers its handler at
 * `config.custom.shippingHandlers` when Shipping is wired):
 * - outbound: the order's tracking numbers. "Delivered" moves shipped kits to Delivered;
 * - return: a box's (or an extra's) prepaid return label. It never moves a kit's status: the hub's check-in does that,
 *   by scan, and tells each keeper their sample arrived (`lab.ts`);
 * - each update is a kit event on every kit it covers. Notices, through `notify` after the commit, each once per
 *   parcel, notice and person (`notices.ts`):
 *   - outbound out for delivery and delivered: the buyer;
 *   - outbound problem (failure, error, returned to sender): the buyer and kit staff;
 *   - return-leg problem: each keeper of a kit in the parcel (the buyer when none was activated) and kit staff.
 *   A return parcel in transit or delivered to the hub's post office tells nobody: the check-in scan does.
 * The same update (or the same status for the same parcel) is applied once. Shipping refuses old updates. A notice
 * that failed to send goes again on the parcel's next update, repeats included, or `retryKitNotices`.
 */

export type TrackerUpdate = { id: string; createdAt?: string; tracking: string; status: string }
export type TrackResult = 'applied' | 'recorded' | 'duplicate' | 'unknown-tracker'
export type ShipmentNotice = 'out-for-delivery' | 'delivered' | 'exception'

/** Which notice a carrier status means. "Available for pickup" is delivered to a PO Box or General Delivery. */
export function noticeFor(status: string): ShipmentNotice | null {
  if (status === 'out_for_delivery') return 'out-for-delivery'
  if (status === 'delivered' || status === 'available_for_pickup') return 'delivered'
  if (status === 'return_to_sender' || status === 'failure' || status === 'error') return 'exception'
  return null
}

export type Found = { leg: 'outbound' | 'return'; site: string | undefined; order: KitOrder; kits: KitDoc[] }

async function findParcel(req: PayloadRequest, o: ResolvedOptions, tracking: string): Promise<Found | null> {
  const label = (await req.payload.find({ collection: 'return-labels', where: { tracking: { equals: tracking } }, limit: 1, ...READ, req })).docs[0] as Record<string, unknown> | undefined
  if (label) {
    const site = siteOfRecord(o, label)
    const order = await getKitOrder(req, o, site, label.order)
    const own = ((label.kits as unknown[] | null) ?? []).map((k) => idOf(k)!)
    const all = (await orderKits(req, o, site, order)).kits
    return { leg: 'return', site, order, kits: own.length ? all.filter((k) => own.includes(String(k.id))) : all }
  }
  const found = (await req.payload.find({ collection: o.collections.orders, where: { 'kitFulfillment.trackingNumbers': { equals: tracking } }, limit: 1, ...READ, req })).docs[0] as unknown as KitOrder | undefined
  if (!found || !found.kitLines?.length) return null
  const site = siteOfRecord(o, found)
  return { leg: 'outbound', site, order: found, kits: (await orderKits(req, o, site, found)).kits }
}

/** Who hears about a parcel's notice, and what they're told. Kit codes and tracking only: never an address or a result. */
export function planNotices(o: ResolvedOptions, found: Found, notice: ShipmentNotice, tracking: string, carrierStatus: string): PlannedNotice[] {
  const order = String(found.order.id)
  const base = { order, site: found.site, tracking }
  const key = (who: string) => `${tracking}|${notice}|${who}`
  const out: PlannedNotice[] = []
  const buyer = buyerOf(o, found.order)
  const codes = (kits: KitDoc[]) => kits.map((k) => k.code)
  const ids = (kits: KitDoc[]) => kits.map((k) => String(k.id))
  if (found.leg === 'outbound') {
    if (buyer) out.push({ ...base, key: key(`buyer:${buyer}`), kind: 'kit-shipment', audience: 'buyer', user: buyer, toBuyer: true, kits: ids(found.kits), data: { event: notice, leg: 'outbound', kits: found.kits.length, tracking: [tracking], order } })
  } else if (notice === 'exception') {
    // The return leg is the keeper's parcel: each keeper hears about their own kits in it, never the buyer of a gift.
    const byKeeper = new Map<string, KitDoc[]>()
    for (const k of found.kits) {
      const keeper = idOf(k.activatedBy)
      if (keeper) byKeeper.set(keeper, [...(byKeeper.get(keeper) ?? []), k])
    }
    // Nobody activated a kit in it: whoever bought them is who mailed them.
    if (!byKeeper.size && buyer) byKeeper.set(buyer, found.kits)
    for (const [user, kits] of byKeeper)
      out.push({ ...base, key: key(`keeper:${user}`), kind: 'kit-shipment', audience: 'keeper', user, toBuyer: Boolean(buyer) && String(user) === String(buyer), kits: ids(kits), data: { event: notice, leg: 'return', kits: kits.length, codes: codes(kits), tracking: [tracking] } })
  }
  if (notice === 'exception')
    out.push({ ...base, key: key('staff'), kind: 'kit-shipment-staff', audience: 'staff', user: null, toBuyer: false, kits: ids(found.kits), data: { event: notice, leg: found.leg, carrierStatus, kits: found.kits.length, codes: codes(found.kits), tracking: [tracking], order } })
  return out
}

/** Server only: one tracker update from the carrier. */
export async function applyTrackerEvent(req: PayloadRequest, ev: TrackerUpdate): Promise<TrackResult> {
  const o = optionsOf(req.payload)
  const outer = req
  return inTransaction(req, async (req) => {
    const tracking = String(ev.tracking).toUpperCase()
    const found = await findParcel(req, o, tracking)
    if (!found) return 'unknown-tracker'
    const kitIds = found.kits.map((k) => k.id)
    const seen = await req.payload.find({
      collection: 'kit-events',
      where: { and: [{ kit: { in: kitIds.length ? kitIds : ['none'] } }, { or: [{ 'details.trackerEvent': { equals: ev.id } }, { and: [{ 'details.tracking': { equals: ev.tracking } }, { 'details.trackerStatus': { equals: ev.status } }] }] }] },
      limit: 1,
      ...READ,
      req,
    })
    // Any update for the parcel, a repeat included, sends what's still owed for it after the commit.
    afterCommit(outer, () => sendNotices(outer.payload, { tracking: { equals: tracking } }))
    if (seen.docs.length) return 'duplicate'
    const notice = noticeFor(ev.status)
    const details = { trackerEvent: ev.id, tracking: ev.tracking, trackerStatus: ev.status, leg: found.leg, notice }
    for (const kit of found.kits) {
      const delivered = found.leg === 'outbound' && notice === 'delivered' && kit.status === 'shipped'
      await recordKitEvent(req, kit, { type: delivered ? 'delivered' : 'note', actor: null, source: 'carrier', order: String(found.order.id), note: delivered ? undefined : `${found.leg === 'return' ? 'Return' : 'Outbound'} parcel ${ev.tracking}: ${ev.status.replace(/_/g, ' ')}`, details })
    }
    if (notice) await recordNotices(req, o, planNotices(o, found, notice, tracking, ev.status))
    return notice ? 'applied' : 'recorded'
  })
}

/** Sample Kits' handler for Shipping's webhook registry. Shipping's own registry shape; Shipping isn't imported. */
export const shippingHandler = {
  owner: 'sample-kits',
  onTracker: async ({ event, req }: { event: TrackerUpdate; req: PayloadRequest; payload: Payload }): Promise<'handled' | 'unknown'> =>
    (await applyTrackerEvent(req, event)) === 'unknown-tracker' ? 'unknown' : 'handled',
  onRefund: async ({ event, req }: { event: { tracking: string; status: string }; req: PayloadRequest; payload: Payload }): Promise<'handled' | 'unknown'> =>
    (await applyRefundEvent(req, event)) === 'unknown-label' ? 'unknown' : 'handled',
}
