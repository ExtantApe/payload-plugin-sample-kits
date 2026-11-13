import type { Payload, Where } from 'payload'

import { carrierRefusal } from './carrier.js'
import { addressProblemsOf, busy, carrierCode, idOf, KitError } from './internal.js'
import type { Label, ResolvedOptions } from './types.js'

/**
 * The record of every label purchase, kept so that a paid label is never forgotten, whatever happens to the
 * caller's transaction. Before the carrier is asked, a `return-labels` row with status `buying` is written
 * straight through the database adapter, with no session, so it commits at once. After the answer, the same row
 * becomes `active` (bought), `unknown` (Shipping's `MAYBE_BOUGHT`, or any answer that isn't a clear refusal) or
 * `not-bought` (a clear refusal), again outside the transaction. Outbound labels get a row too, with kind
 * `outbound`; the order's `outboundLabels` entry links to it in the caller's transaction.
 *
 * A `buying` row left by a crash means the outcome is unknown: like an `unknown` row, it stops every automatic
 * purchase for its order and box (or kit) until staff settle it.
 */

export type LedgerKind = 'box' | 'extra' | 'outbound'
export type LedgerRow = {
  id: string | number
  order: unknown
  box?: number | null
  kind: LedgerKind
  status: 'buying' | 'active' | 'replaced' | 'cancelled' | 'unknown' | 'not-bought'
  kits?: unknown[] | null
  tracking?: string | null
  costCents?: number | null
  labelUrl?: string | null
  shipmentId?: string | null
  carrier?: string | null
  service?: string | null
  mode?: string | null
  hub?: unknown
  addressKey?: string | null
  reference?: string | null
  refund?: string | null
  createdAt: string
  [field: string]: unknown
}

/** Statuses that mean a label may have been bought, so nothing more is bought for that slot. */
export const PENDING = ['buying', 'unknown'] as const

export type Slot = { order: unknown; kind: LedgerKind; box?: number | null; kit?: string | null }

const slotWhere = (slot: Slot, statuses: readonly string[]): Where => ({
  and: [
    { order: { equals: idOf(slot.order) } },
    { kind: { equals: slot.kind } },
    { status: { in: [...statuses] } },
    ...(slot.kit ? [{ kits: { in: [slot.kit] } }] : slot.box != null ? [{ box: { equals: slot.box } }] : []),
  ],
})

/** Rows as committed, read outside any transaction, so a purchase made in this run is always seen. */
export async function committedRows(payload: Payload, where: Where): Promise<LedgerRow[]> {
  const r = await payload.db.find({ collection: 'return-labels', where, limit: 0, pagination: false, sort: 'box' } as never)
  return (r as unknown as { docs: LedgerRow[] }).docs
}
export const rowsForSlot = (payload: Payload, slot: Slot, statuses: readonly string[]) => committedRows(payload, slotWhere(slot, statuses))
export const pendingOnOrder = (payload: Payload, order: unknown) => committedRows(payload, { and: [{ order: { equals: idOf(order) } }, { status: { in: [...PENDING] } }] })

/**
 * The slot's claim: `order|kind|box` (or the kit, for an extra). Only `buying` and `unknown` rows carry it, and a
 * unique index that ignores rows without one (`ensureSampleKitsIndexes`) lets only one of them exist per slot.
 */
export const slotKey = (slot: Slot) => `${idOf(slot.order)}|${slot.kind}|${slot.kind === 'extra' ? (slot.kit ?? '') : (slot.box ?? '')}`

/** A change to a row, outside any transaction. A row that settles out of `buying` or `unknown` frees its slot. */
export const settleRow = (payload: Payload, id: LedgerRow['id'], data: Record<string, unknown>) => {
  const frees = typeof data.status === 'string' && !(PENDING as readonly string[]).includes(data.status)
  return payload.db.updateOne({ collection: 'return-labels', id, data: { ...data, ...(frees ? { slotKey: null } : {}), updatedAt: new Date().toISOString() } } as never) as unknown as Promise<LedgerRow>
}

export { SLOT_INDEX } from './indexes.js'

export const labelFields = (label: Label) => ({ tracking: label.tracking, carrier: label.carrier, service: label.service, costCents: label.rateCents, mode: label.mode, labelUrl: label.labelUrl, shipmentId: label.shipmentId })

export const unknownStop = () => new KitError('labelUnknown', 'A label here may already have been bought: the carrier’s answer was unclear or never came. Staff check the carrier and settle it before another is bought.')

/** How long a `buying` row is another request's purchase in flight (`busy`), before it's treated as unknown. */
export const IN_FLIGHT_MS = 2 * 60_000

/**
 * Why a slot is held: a purchase another request started moments ago is a lost race (`busy`, plain words); an unknown
 * outcome, or a purchase that never finished, waits for staff (`labelUnknown`).
 */
export const stopFor = (rows: LedgerRow[], now = Date.now()) =>
  rows.some((r) => r.status !== 'buying' || !(now - Date.parse(String(r.createdAt)) < IN_FLIGHT_MS)) ? unknownStop() : busy()

/** MongoDB's duplicate-key error, as the driver or Payload's adapter reports it. */
const duplicateKey = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null
  return e?.code === 11000 || e?.cause?.code === 11000 || /E11000|duplicate key/i.test(String(e?.message ?? ''))
}

export type Purchase = { row: LedgerRow; label: Label | null; unknown: boolean }

/**
 * One label purchase with its record kept outside the caller's transaction. Refuses while a `buying` or
 * `unknown` row exists for the same slot. A clear refusal is thrown (the row says `not-bought`); an unclear
 * answer is returned with `unknown: true`, never thrown.
 */
export async function recordedPurchase(
  payload: Payload,
  o: ResolvedOptions,
  intent: Slot & { site: string | undefined; kits?: string[]; hub?: unknown; addressKey?: string | null; reference: string; placeholderWeight?: boolean },
  buy: () => Promise<Label>,
): Promise<Purchase> {
  // The friendly check first; the unique claim below is what makes it hold when two calls race.
  const held = await rowsForSlot(payload, intent, PENDING)
  if (held.length) throw stopFor(held)
  const now = new Date().toISOString()
  const row = (await payload.db
    .create({
    collection: 'return-labels',
    data: {
      ...(o.scope ? { [o.scope.field]: intent.site } : {}),
      order: idOf(intent.order),
      box: intent.box ?? null,
      kind: intent.kind,
      kits: intent.kits ?? [],
      hub: idOf(intent.hub),
      addressKey: intent.addressKey ?? null,
      reference: intent.reference,
      placeholderWeight: intent.placeholderWeight ?? null,
      status: 'buying',
      slotKey: slotKey(intent),
      createdAt: now,
      updatedAt: now,
    },
  } as never)
    .catch(async (error: unknown) => {
      // A duplicate claim: another purchase holds the slot. Anything else is a real failure.
      const now = await rowsForSlot(payload, intent, PENDING)
      if (now.length) throw stopFor(now)
      // The other purchase settled in between: still a lost race.
      if (duplicateKey(error)) throw busy()
      throw error
    })) as unknown as LedgerRow
  let label: Label
  try {
    label = await buy()
  } catch (error) {
    const code = carrierCode(error)
    // Only a clear refusal means nothing was bought. Anything else may have reached the carrier.
    const clear = (code !== null && code !== 'MAYBE_BOUGHT') || addressProblemsOf(error) !== null || error instanceof KitError
    if (!clear) return { row: await settleRow(payload, row.id, { status: 'unknown' }), label: null, unknown: true }
    await settleRow(payload, row.id, { status: 'not-bought' })
    throw carrierRefusal(error)
  }
  return { row: await settleRow(payload, row.id, { status: 'active', ...labelFields(label) }), label, unknown: false }
}
