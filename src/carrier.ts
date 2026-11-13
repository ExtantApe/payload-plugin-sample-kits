import type { PayloadRequest } from 'payload'

import { addressProblemsOf, carrierCode, carrierStatus, KitError, READ, scoped } from './internal.js'
import type { KitOrder, LabelAddress, LabelShipping, ResolvedOptions, StoredAddress } from './types.js'
import { LABEL_MEMBERS } from './types.js'

/**
 * The plugin's side of Shipping: finding the hubs and addresses that go on labels, and reading Shipping's
 * errors by their code. Shipping itself is never imported.
 */

/** USPS refunds an unused label only within this many days of buying it. */
export const USPS_REFUND_DAYS = 30
const DAY = 86_400_000
export const refundable = (at?: string | null, now = Date.now()) => Boolean(at) && now - new Date(at!).getTime() < USPS_REFUND_DAYS * DAY

/** The shipping adapter with everything labels need, or a refusal. */
export function shippingOf(o: ResolvedOptions): LabelShipping {
  const s = o.adapters?.shipping
  if (!s || LABEL_MEMBERS.some((k) => typeof s[k] !== 'function')) throw new KitError('noShipping', 'Shipping isn’t set up here, so no labels can be made.')
  return s as LabelShipping
}
export const hasShipping = (o: ResolvedOptions) => {
  const s = o.adapters?.shipping
  return Boolean(s) && LABEL_MEMBERS.every((k) => typeof s![k] === 'function')
}

export type HubDoc = { id: string | number; name: string; address?: StoredAddress | null; placeholder?: boolean | null; [field: string]: unknown }

/** The site's default return hub. */
export async function returnHub(req: PayloadRequest, o: ResolvedOptions, site: string | undefined): Promise<HubDoc> {
  const { docs } = await req.payload.find({ collection: 'hubs', where: scoped(o, site, { and: [{ defaultReturn: { equals: true } }, { active: { not_equals: false } }] }), limit: 1, ...READ, req })
  if (!docs[0]) throw new KitError('noReturnHub', 'No hub takes returns yet. Tick “Kits return here by default” on one in the admin.')
  return docs[0] as unknown as HubDoc
}

/** The hub asked for (same site only), else the default return hub. */
export async function hubFor(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, hubId?: string | null): Promise<HubDoc> {
  if (!hubId) return returnHub(req, o, site)
  const { docs } = await req.payload.find({ collection: 'hubs', where: scoped(o, site, { id: { equals: hubId } }), limit: 1, ...READ, req })
  if (!docs[0]) throw new KitError('noReturnHub', 'That hub isn’t on this site.')
  return docs[0] as unknown as HubDoc
}

/** The hub kit orders ship from. */
export async function shipFromHub(req: PayloadRequest, o: ResolvedOptions, site: string | undefined): Promise<HubDoc> {
  const { docs } = await req.payload.find({ collection: 'hubs', where: scoped(o, site, { and: [{ shipsOrders: { equals: true } }, { active: { not_equals: false } }] }), limit: 1, ...READ, req })
  if (!docs[0]) throw new KitError('noShipFrom', 'No hub ships kit orders yet. Tick “Kit orders ship from here” on one in the admin.')
  return docs[0] as unknown as HubDoc
}

/** A hub's address as it goes on a label now, and its fingerprint. Refuses placeholder or incomplete hubs. */
export function hubLabel(s: LabelShipping, hub: HubDoc): { to: LabelAddress; key: string } {
  try {
    const to = s.labelAddress(hub.address, { placeholder: hub.placeholder })
    return { to, key: s.addressKey(to) }
  } catch (error) {
    const problems = addressProblemsOf(error)
    if (problems) throw new KitError('hubAddress', `${hub.name}’s address can’t go on a label yet (${problems.join(', ')}).`, { hub: hub.name, problems: problems.join(', ') })
    throw error
  }
}

/** Where the order ships, from the orders provider. Refuses an order without a complete address. */
export async function customerAddress(req: PayloadRequest, o: ResolvedOptions, s: LabelShipping, order: KitOrder): Promise<LabelAddress> {
  const stored = (await o.orders?.shipTo?.({ order, req })) ?? null
  try {
    if (!stored) throw Object.assign(new Error('no address'), { problems: ['street'] })
    return s.labelAddress({ kind: 'street', ...stored })
  } catch (error) {
    if (addressProblemsOf(error)) throw new KitError('customerAddress', 'This order has no complete shipping address.')
    throw error
  }
}

/**
 * Shipping's errors, in the plugin's words, when nothing was bought. `MAYBE_BOUGHT` is never passed here:
 * the callers record it before anything else.
 */
export function carrierRefusal(error: unknown): KitError {
  if (error instanceof KitError) return error
  const code = carrierCode(error)
  if (code === 'REFUSED') return new KitError('postageOff', 'Real postage is off here, so nothing was bought.')
  if (code === 'NO_KEY') return new KitError('noShipping', 'Shipping isn’t set up here, so no labels can be made.')
  const problems = addressProblemsOf(error)
  if (problems) return new KitError('hubAddress', `An address can’t go on a label yet (${problems.join(', ')}).`, { hub: '', problems: problems.join(', ') })
  if (code) return new KitError('carrier', `The carrier refused: ${(error as Error).message}`, { message: (error as Error).message })
  throw error
}

/** A refund's outcome, as a word to store, never throwing: a carrier's clear 4xx is a refusal; anything else is a failure to retry. */
export async function askRefund(req: PayloadRequest, s: LabelShipping, shipmentId: string): Promise<string> {
  try {
    return await s.refund(req.payload, shipmentId, req)
  } catch (error) {
    const code = carrierCode(error)
    const status = carrierStatus(error)
    const refused = code !== null && code !== 'NO_KEY' && code !== 'REFUSED' && status >= 400 && status < 500
    return `${refused ? 'refused' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
  }
}

/** A label's refund, in the words staff see. */
export type RefundState = 'requested' | 'refunded' | 'refused' | 'too-late' | 'failed'
export function refundState(refund: string | null | undefined): RefundState | null {
  if (!refund || refund === 'none') return null
  if (refund === 'submitted') return 'requested'
  if (refund === 'refunded') return 'refunded'
  if (refund === 'too-old') return 'too-late'
  if (refund === 'rejected' || refund === 'not_applicable' || refund.startsWith('refused')) return 'refused'
  return 'failed'
}
