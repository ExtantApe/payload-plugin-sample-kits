import type { Payload, PayloadRequest, Where } from 'payload'

import { audit, errName, freshReq, optionsOf, READ, sysReq } from './internal.js'
import type { NoticeDelivery, ResolvedOptions } from './types.js'

/**
 * The record of every shipment notice (`kit-notices`): one row per parcel, notice and person, so each is sent once
 * however often the carrier repeats an update.
 *
 * - The row is written in the action's own transaction, as `pending`, with a key that a unique index lets exist once
 *   (`sampleKits_notice_key`). An update the carrier sends twice at the same moment can't make two rows: the second
 *   transaction fails and the carrier tries it again later, when it's a duplicate.
 * - After the commit, each `pending` (or `failed`) row is claimed by changing its status to `sending` only where the
 *   status and the attempt count are still the ones read, so two senders never send one notice twice. Then `notify`
 *   is called, and the row says `sent` (with what the site answered) or `failed`.
 * - A failed notice is sent again on the parcel's next update, the kit's next check-in scan, or `retryKitNotices`
 *   (daily), up to `MAX_NOTICE_TRIES` attempts, then `gave-up` for staff to see. A rare second copy (a send that went
 *   out and then reported an error) is better than a notice owed and never sent.
 */

export const MAX_NOTICE_TRIES = 5
/** How long a `sending` row is someone's send in flight, before it's treated as never finished. */
export const SENDING_STUCK_MS = 10 * 60_000

export type NoticeAudience = 'buyer' | 'keeper' | 'staff'
export type NoticeStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'gave-up'
export type PlannedNotice = {
  key: string
  kind: string
  audience: NoticeAudience
  user: string | null
  order: string | null
  site: string | undefined
  tracking: string | null
  /** Whether the person told is the order's own buyer, decided when the notice is planned. Only then does a keeper's notice carry the order. */
  toBuyer: boolean
  kits: string[]
  data: Record<string, unknown>
}
type NoticeRow = PlannedNotice & { id: string | number; noticeKey: string; status: NoticeStatus; attempts?: number | null }

/**
 * In the caller's transaction: a `pending` row for each planned notice not already recorded. Nothing without
 * `notify`. Answers how many were added.
 */
export async function recordNotices(req: PayloadRequest, o: ResolvedOptions, planned: PlannedNotice[]): Promise<number> {
  if (!o.notify || !planned.length) return 0
  const { docs } = await req.payload.find({ collection: 'kit-notices', where: { noticeKey: { in: planned.map((n) => n.key) } }, ...READ, req })
  const known = new Set(docs.map((d) => String((d as unknown as NoticeRow).noticeKey)))
  let added = 0
  for (const n of planned) {
    if (known.has(n.key)) continue
    known.add(n.key)
    await req.payload.create({
      collection: 'kit-notices',
      data: {
        ...(o.scope ? { [o.scope.field]: n.site } : {}),
        noticeKey: n.key,
        kind: n.kind,
        audience: n.audience,
        user: n.user,
        order: n.order,
        toBuyer: n.toBuyer === true,
        tracking: n.tracking,
        kits: n.kits,
        data: n.data,
        status: 'pending',
        attempts: 0,
      } as never,
      overrideAccess: true,
      depth: 0,
      req: sysReq(req, audit('shipment notice recorded')),
    })
    added++
  }
  return added
}

/** The answers `notify` may give that are stored as they are. Anything else is stored as `unknown`. */
const KNOWN_DELIVERY: readonly string[] = ['sent', 'not-sent-side-effects-off', 'not-sent-test-addresses', 'no-address', 'failed']

/**
 * Who a notice goes to, as `notify` sees it. A keeper may be a minor and may have got the kit as a gift, so a
 * keeper's notice never carries the buyer's order (the row keeps it, for the seed and for retries). A staff notice
 * names the order's site, so a site with many tenants tells only that site's kit staff.
 */
export function noticeTo(o: ResolvedOptions, row: Pick<NoticeRow, 'audience' | 'user' | 'order'> & Record<string, unknown>): Parameters<NonNullable<ResolvedOptions['notify']>>[0]['to'] {
  // A keeper who is also the order's buyer (recorded when planned) may see their own order; anyone else never.
  if (row.audience === 'keeper') return { user: row.user ?? null, order: row.toBuyer === true ? (row.order ?? null) : null }
  if (row.audience === 'staff') {
    const site = o.scope ? row[o.scope.field] : null
    return { user: row.user ?? null, order: row.order ?? null, staff: true, site: site === null || site === undefined || site === '' ? null : String(typeof site === 'object' && 'id' in (site as object) ? (site as { id: unknown }).id : site) }
  }
  return { user: row.user ?? null, order: row.order ?? null }
}

/** With `scope`, a staff notice must name its site; one that can't is never sent (a site might read no site as every site). */
export const staffSiteMissing = (o: ResolvedOptions, row: Pick<NoticeRow, 'audience'> & Record<string, unknown>): boolean =>
  Boolean(o.scope) && row.audience === 'staff' && noticeTo(o, row as never).site === null

const rows = async (payload: Payload, where: Where) => (await payload.db.find({ collection: 'kit-notices', where, limit: 0, pagination: false, sort: 'createdAt' } as never)) as unknown as { docs: NoticeRow[] }
const write = (payload: Payload, where: Where, data: Record<string, unknown>) =>
  payload.db.updateOne({ collection: 'kit-notices', where, data: { ...data, updatedAt: new Date().toISOString() } } as never) as unknown as Promise<NoticeRow | null>

/**
 * Outside any transaction, after the commit: sends the `pending` and `failed` notices that match `where`. Never
 * throws. With `stuck`, also those left `sending` longer than `SENDING_STUCK_MS` (a crash mid-send).
 */
export async function sendNotices(payload: Payload, where: Where, opts: { stuck?: boolean; now?: Date } = {}): Promise<{ sent: number; failed: number }> {
  const o = optionsOf(payload)
  const out = { sent: 0, failed: 0 }
  if (!o.notify) return out
  const now = opts.now ?? new Date()
  const due: Where = {
    or: [
      { status: { in: ['pending', 'failed'] } },
      ...(opts.stuck ? [{ and: [{ status: { equals: 'sending' } }, { triedAt: { less_than: new Date(now.getTime() - SENDING_STUCK_MS).toISOString() } }] }] : []),
    ],
  }
  let found: NoticeRow[]
  try {
    found = (await rows(payload, { and: [where, due] })).docs
  } catch (error) {
    payload.logger.error({ err: errName(error) }, 'Sample Kits: shipment notices not read; the next update or run tries again')
    return out
  }
  for (const row of found) {
    const attempts = Number(row.attempts ?? 0)
    if (attempts >= MAX_NOTICE_TRIES) continue
    try {
      if (staffSiteMissing(o, row as NoticeRow & Record<string, unknown>)) {
        // Fail closed: recorded for staff to see, never sent to a site's staff at large.
        const stopped = await write(payload, { and: [{ id: { equals: row.id } }, { status: { equals: row.status } }, { attempts: { equals: attempts } }] }, { status: 'gave-up', delivery: 'noSite', triedAt: new Date().toISOString() })
        if (stopped) {
          out.failed++
          payload.logger.warn({ notice: String(row.id) }, 'Sample Kits: a staff notice has no site, so it was not sent')
        }
        continue
      }
      // The claim: only one sender gets the row while its status and attempt count are the ones read.
      const claimed = await write(payload, { and: [{ id: { equals: row.id } }, { status: { equals: row.status } }, { attempts: { equals: attempts } }] }, { status: 'sending', attempts: attempts + 1, triedAt: new Date().toISOString() })
      if (!claimed) continue
      let delivery: NoticeDelivery | 'unknown'
      try {
        const answer: unknown = await o.notify({ kind: row.kind, to: noticeTo(o, row as NoticeRow & Record<string, unknown>), data: row.data ?? {}, req: freshReq({ payload } as PayloadRequest) })
        // Only the answers the plugin knows are stored; a site's odd answer is recorded as unknown, never as given.
        delivery = answer === undefined || answer === null ? 'sent' : typeof answer === 'string' && KNOWN_DELIVERY.includes(answer) ? (answer as NoticeDelivery) : 'unknown'
      } catch (error) {
        delivery = 'failed'
        payload.logger.warn({ err: errName(error), notice: String(row.id) }, 'Sample Kits: shipment notice not sent; it will be tried again')
      }
      const status: NoticeStatus = delivery !== 'failed' ? 'sent' : attempts + 1 >= MAX_NOTICE_TRIES ? 'gave-up' : 'failed'
      await write(payload, { id: { equals: row.id } }, { status, delivery, ...(status === 'sent' ? { sentAt: new Date().toISOString() } : {}) })
      if (status === 'sent') out.sent++
      else out.failed++
    } catch (error) {
      payload.logger.error({ err: errName(error), notice: String(row.id) }, 'Sample Kits: shipment notice bookkeeping failed')
    }
  }
  return out
}

/**
 * Server only, daily (or more often): every shipment notice still owed, on every site: `pending` ones whose send
 * never ran, `failed` ones, and sends that never finished. Each is claimed first, so it's safe beside webhooks.
 */
export async function retryKitNotices(req: PayloadRequest, input: { at?: Date } = {}): Promise<{ sent: number; failed: number }> {
  return sendNotices(req.payload, { attempts: { less_than: MAX_NOTICE_TRIES } }, { stuck: true, now: input.at })
}
