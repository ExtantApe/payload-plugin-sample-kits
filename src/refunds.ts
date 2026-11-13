import type { Payload, PayloadRequest, Where } from 'payload'

import { errName, idOf, inTransaction, isAdmin, KitError, personOf, optionsOf, scoped, siteOf } from './internal.js'
import type { KitOrder, RefundRecord, ResolvedOptions } from './types.js'

/**
 * The record of every refund on a kit order, kept so money that went back is never forgotten, whatever happens to
 * the caller's transaction. As with label purchases (`ledger.ts`):
 * - before the payment service is asked, a `kit-refunds` row with status `asking` is written straight through the
 *   database adapter, with no session, so it commits at once;
 * - the row carries the order's claim (`claimKey`). A unique partial index lets only one claim exist per order, so
 *   two refunds on one order can never be asked at the same moment, whatever their kind;
 * - the limit (never more than was paid) is checked after the claim, against the committed rows, so it holds when
 *   two requests race;
 * - after the answer the row becomes `refunded`, `failed` (a clear refusal: nothing went back) or `unknown` (anything
 *   else: a timeout, a dropped connection, an answer without an id), again outside the transaction, and the claim is
 *   freed. An `unknown` refund counts as paid back until a site admin settles it, so no other refund can pass what
 *   was paid even if it did go through (security read of fee0a58, 2026-11-10).
 *
 * A row left `asking` by a crash keeps its claim: no more refunds on that order until an admin settles it
 * (`settleRefund`), after checking the payment service.
 */

export type RefundKind = 'order' | 'review' | 'shipping'
export type RefundRow = {
  id: string | number
  order: unknown
  kind: RefundKind
  amountCents?: number | null
  status: 'asking' | 'refunded' | 'failed' | 'not-asked' | 'unknown'
  key?: string | null
  refundId?: string | null
  reason?: string | null
  createdAt: string
  [field: string]: unknown
}

/** Statuses whose money counts as gone back: refunded, or maybe (still being asked, or an unclear answer). */
const COUNTED = ['refunded', 'asking', 'unknown'] as const

/**
 * A payment service's clear refusal: nothing was refunded. A `KitError`, or an error with `refused: true` (what a site's
 * `payments.refund` throws when, say, Stripe answers with a card or request error). Anything else may have refunded.
 */
export const isClearRefusal = (error: unknown): boolean => error instanceof KitError || (Boolean(error) && typeof error === 'object' && (error as { refused?: unknown }).refused === true)

/** For a site's `payments.refund`: the error to throw when the payment service clearly refused. */
export const refundRefusal = (message = 'The payment service refused the refund.'): Error & { refused: true } => Object.assign(new Error(message), { name: 'RefundRefused', refused: true as const })

export const refundUnknown = () =>
  new KitError('refundUnknown', 'The payment service didn’t answer clearly, so the refund may have gone through. It counts as refunded until an admin checks the payment service and settles it.')

export async function refundRows(payload: Payload, where: Where): Promise<RefundRow[]> {
  const r = await payload.db.find({ collection: 'kit-refunds', where, limit: 0, pagination: false, sort: 'createdAt' } as never)
  return (r as unknown as { docs: RefundRow[] }).docs
}

const settle = (payload: Payload, id: RefundRow['id'], data: Record<string, unknown>) => {
  const frees = typeof data.status === 'string' && data.status !== 'asking'
  return payload.db.updateOne({ collection: 'kit-refunds', id, data: { ...data, ...(frees ? { claimKey: null } : {}), updatedAt: new Date().toISOString() } } as never) as unknown as Promise<RefundRow>
}

/** What the order paid, in cents. */
export async function paidOf(req: PayloadRequest, o: ResolvedOptions, order: KitOrder): Promise<number> {
  const raw = o.orders?.paidCents ? await o.orders.paidCents({ order, req }) : Number(order.amount) || 0
  return Math.max(0, Math.floor(Number(raw) || 0))
}

/**
 * Money already given back on this order: the committed refund rows (refunded or still being asked), plus refunds the
 * site recorded before the move, which have no row.
 */
export function refundedOf(order: KitOrder, rows: RefundRow[], except?: RefundRow['id']): number {
  const others = rows.filter((r) => r.id !== except)
  const counted = others.filter((r) => (COUNTED as readonly string[]).includes(r.status))
  let sum = counted.reduce((n, r) => n + (Number(r.amountCents) || 0), 0)
  const f = order.kitFulfillment ?? {}
  if (!others.some((r) => r.kind === 'shipping') && f.shippingRefund?.status === 'refunded') sum += Number(f.shippingRefund.amountCents) || 0
  if (!others.some((r) => r.kind === 'order' || r.kind === 'review') && f.orderRefund?.status === 'refunded') sum += Number(f.orderRefund.amountCents) || 0
  return sum
}

/** What's left to refund on the order, from committed rows. */
export async function refundableOf(req: PayloadRequest, o: ResolvedOptions, order: KitOrder): Promise<number> {
  const rows = await refundRows(req.payload, { order: { equals: idOf(order.id) } })
  return Math.max(0, (await paidOf(req, o, order)) - refundedOf(order, rows))
}

/** A second claim on the order: MongoDB's duplicate key, as the driver reports it or as Payload's adapter turns it into a "must be unique" error on `claimKey`. */
const duplicateKey = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown; data?: { errors?: { path?: unknown }[] } } | null
  return e?.code === 11000 || e?.cause?.code === 11000 || /E11000|duplicate key/i.test(String(e?.message ?? '')) || Boolean(e?.data?.errors?.some((x) => x?.path === 'claimKey'))
}

export const refundBusy = () => new KitError('refundBusy', 'Another refund on this order is being made, or its outcome isn’t known yet. Nothing was refunded; try again in a minute, or ask an admin to check.')

export type RefundOutcome = { amountCents: number; refundId: string | null; row: RefundRow | null }

/**
 * One refund on an order, with its record kept outside the caller's transaction. `amount(left)` gets what's left to
 * refund (paid, less every committed refund) after the claim, and returns what to refund: 0 asks nothing, more than
 * `left` is refused (`refundTooMuch`). A payment service that throws, or answers without an id, is a failure:
 * nothing is recorded as refunded and the claim is freed (the same `key` on a retry can't refund twice).
 */
export async function recordedRefund(
  req: PayloadRequest,
  o: ResolvedOptions,
  intent: { order: KitOrder; site: string | undefined; kind: RefundKind; key: string; reason: string; by?: unknown; amount: (left: number) => number },
): Promise<RefundOutcome> {
  const payload = req.payload
  const orderId = idOf(intent.order.id)!
  const now = new Date().toISOString()
  const row = (await payload.db
    .create({
      collection: 'kit-refunds',
      data: {
        ...(o.scope ? { [o.scope.field]: intent.site } : {}),
        order: orderId,
        kind: intent.kind,
        amountCents: null,
        status: 'asking',
        key: intent.key,
        reason: intent.reason.slice(0, 300),
        by: idOf(intent.by),
        claimKey: orderId,
        createdAt: now,
        updatedAt: now,
      },
    } as never)
    .catch((error: unknown) => {
      if (duplicateKey(error)) throw refundBusy()
      throw error
    })) as unknown as RefundRow
  let amount: number
  try {
    const rows = await refundRows(payload, { order: { equals: orderId } })
    const left = Math.max(0, (await paidOf(req, o, intent.order)) - refundedOf(intent.order, rows, row.id))
    amount = intent.amount(left)
    if (!Number.isInteger(amount) || amount < 0) throw new KitError('refundAmount', 'Enter an amount above zero.')
    if (amount > left) throw new KitError('refundTooMuch', `At most ${(left / 100).toFixed(2)}: what’s left of the payment.`, { max: (left / 100).toFixed(2) })
  } catch (error) {
    await settle(payload, row.id, { status: 'not-asked' })
    throw error
  }
  if (amount === 0) {
    await settle(payload, row.id, { status: 'not-asked', amountCents: 0 })
    return { amountCents: 0, refundId: null, row: null }
  }
  if (!o.payments?.refund) {
    await settle(payload, row.id, { status: 'not-asked' })
    throw new KitError('noPayments', 'Payments aren’t set up here, so nothing can be refunded.')
  }
  await settle(payload, row.id, { status: 'asking', amountCents: amount })
  let record: RefundRecord
  try {
    record = await o.payments.refund({ order: intent.order, amountCents: amount, reason: intent.reason, key: intent.key, req })
  } catch (error) {
    if (!isClearRefusal(error)) {
      // It may have gone through: counted as paid back until an admin settles it.
      await settle(payload, row.id, { status: 'unknown' })
      payload.logger.error({ err: errName(error), order: orderId }, 'Sample Kits: refund outcome unknown')
      throw refundUnknown()
    }
    await settle(payload, row.id, { status: 'failed' })
    if (error instanceof KitError) throw error
    throw new KitError('refundFailed', 'The payment service didn’t take the refund. Nothing was refunded; try again later.')
  }
  if (!record || typeof record.id !== 'string' || !record.id) {
    await settle(payload, row.id, { status: 'unknown' })
    throw refundUnknown()
  }
  const done = await settle(payload, row.id, { status: 'refunded', refundId: record.id })
  return { amountCents: amount, refundId: record.id, row: done }
}

/**
 * Site admins, after checking the payment service: a refund left `asking` (the server stopped) or `unknown` (an unclear
 * answer) either went through (`refundId`) or didn't (null). Either frees the order for the next refund, and only
 * then does a refund that didn't go through stop counting as paid back.
 */
export async function settleRefund(req: PayloadRequest, input: { refund: string; refundId: string | null }) {
  const o = optionsOf(req.payload)
  if (!personOf(o, req) || !(await isAdmin(o, req))) throw new KitError('notAllowed', 'Only the site’s administrators can settle refunds.')
  const site = await siteOf(o, req)
  const refundId = input?.refundId === null ? null : String(input?.refundId ?? '').trim()
  if (refundId !== null && !/^[A-Za-z0-9_-]{3,100}$/.test(refundId)) throw new KitError('refundDetails', 'Give the refund’s id as the payment service shows it, or say it didn’t go through.')
  return inTransaction(req, async () => {
    const row = (await refundRows(req.payload, scoped(o, site, { and: [{ id: { equals: idOf(input?.refund) ?? '' } }, { status: { in: ['asking', 'unknown'] } }] })).catch(() => []))[0]
    if (!row) throw new KitError('noRefund', 'That refund isn’t waiting to be settled.')
    await settle(req.payload, row.id, refundId ? { status: 'refunded', refundId } : { status: 'failed' })
    return { result: refundId ? ('refunded' as const) : ('failed' as const) }
  })
}
