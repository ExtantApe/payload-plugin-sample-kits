import type { PayloadRequest } from 'payload'

import { errName, audit, freshReq, SKIP_LABEL_CANCEL, idOf, inTransaction, isStaff, KitError, optionsOf, personOf, READ, requireStaff, scoped, siteOf, sysReq } from './internal.js'
import { buyerOf, getKitOrder, saveFulfillment, siteOfRecord } from './packing.js'
import { eventDay, inPersonText } from './terms.js'
import type { DropOffChoice, KitOrder, ResolvedOptions, ReturnAtEvent } from './types.js'

/**
 * "Return it in person at {event}". A buyer whose address is near an event date that takes kits may hand them in
 * there instead of mailing them back: no return label is bought for them. The events side says which dates qualify
 * (`adapters.events.dropOffChoices`); this plugin owns everything after:
 * - the choice is checked again on the server and saved on the order (`returnAt`, the date's id, and
 *   `returnAtEvent`, what was chosen);
 * - packing marks each kit with where it's handed in (`returnInPerson`), and a kit marked later has its unneeded
 *   return labels refunded by the kits' in-person hook;
 * - a reminder a week before; if the date is canceled or moved, the buyer is told at once (`noticeDateChanged`);
 *   the day after a missed date, told too; either way a prepaid return label is one click away;
 * - staff see which kits each date expects.
 */

const DAY = 864e5
/** Kits that still have to come back (not yet checked in at a hub or event). */
const OUT = ['packed', 'shipped', 'delivered', 'activated', 'sampled']

const eventsOf = (o: ResolvedOptions) => o.adapters?.events ?? null

/** The dates this address may hand kits in at (US ZIP codes, like kit shipping). Never throws: no offer instead. */
export async function dropOffOffer(req: PayloadRequest, input: { postalCode: string | null | undefined; country?: string; now?: Date }): Promise<DropOffChoice[]> {
  const o = optionsOf(req.payload)
  const events = eventsOf(o)
  if (!events) return []
  const country = String(input?.country ?? 'US').toUpperCase()
  const zip = String(input?.postalCode ?? '').trim().slice(0, 5)
  if (country !== 'US' || !/^\d{5}$/.test(zip)) return []
  try {
    const tenant = o.scope ? ((await o.scope.of(req)) ?? null) : null
    const choices = await events.dropOffChoices({ tenant, country, postalCode: zip, now: input.now ?? new Date(), req })
    return Array.isArray(choices) ? choices.filter((c) => c && typeof c.dateId === 'string' && c.dateId && typeof c.starts === 'string') : []
  } catch (error) {
    req.payload.logger.warn({ err: errName(error) }, 'Sample Kits: no drop-off offer (the events side failed)')
    return []
  }
}

/** The buyer's choice, checked against what this address is offered now. */
export async function checkDropOff(req: PayloadRequest, input: { postalCode: string | null | undefined; dateId: string; now?: Date }): Promise<DropOffChoice> {
  const choice = (await dropOffOffer(req, input)).find((c) => c.dateId === String(input?.dateId ?? ''))
  if (!choice) throw new KitError('dropOffGone', 'That event date can’t take kits from this address any more. Choose another, or send them back by mail.')
  return choice
}

export const snapshotOf = (c: DropOffChoice): ReturnAtEvent => ({ name: c.eventName, slug: c.eventSlug, starts: c.starts, timezone: c.timezone ?? null, place: c.place })

export { eventDay, inPersonText }

/**
 * The buyer (or kit staff) chooses to hand an order's kits in at an event date, before it ships. Checked against the
 * order's ship-to address now. Kits already packed are marked at once, and their unneeded return labels refunded.
 */
export async function chooseDropOff(req: PayloadRequest, input: { order: string; dateId: string; now?: Date }) {
  const o = optionsOf(req.payload)
  const me = personOf(o, req)
  if (!me) throw new KitError('noOrder', 'That order wasn’t found.')
  const site = await siteOf(o, req)
  const staff = await isStaff(o, req)
  return inTransaction(req, async (req) => {
    const order = await getKitOrder(req, o, site, input?.order)
    if (!staff && buyerOf(o, order) !== String(me.id)) throw new KitError('noOrder', 'That order wasn’t found.')
    const status = order.kitFulfillment?.status ?? 'to-pack'
    if (status === 'shipped' || status === 'cancelled') throw new KitError('orderClosed', 'This order has already shipped or was canceled.')
    const shipTo = o.orders?.shipTo ? await o.orders.shipTo({ order, req }) : null
    const choice = await checkDropOff(req, { postalCode: shipTo?.postalCode, dateId: input?.dateId, now: input?.now })
    const event = snapshotOf(choice)
    await saveFulfillment(req, o, order, { returnAt: choice.dateId, returnAtEvent: event }, 'event drop-off chosen')
    // Kits already packed: marked now. The kits' in-person hook refunds the return labels they no longer need.
    const packed = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { and: [{ order: { equals: order.id } }, { status: { in: OUT } }] }), ...READ, req })).docs
    for (const k of packed) await req.payload.update({ collection: 'kits', id: k.id, data: { returnInPerson: inPersonText(event, o.policy?.storeTimeZone) } as never, overrideAccess: true, depth: 0, req: sysReq(req, audit('event drop-off chosen')) })
    return { dateId: choice.dateId, event, kits: packed.length }
  })
}

export type ReturnAtState = 'upcoming' | 'missed' | 'canceled'

/**
 * Where an order's event return stands. With `adapters.events.dateOf`, the date as the events side has it now: gone or
 * canceled is "canceled". Once the day after the date has begun in the event's time zone, "missed".
 */
export async function returnAtState(req: PayloadRequest, f: KitOrder['kitFulfillment'], now = new Date()): Promise<{ state: ReturnAtState; starts: string | null } | null> {
  if (!f?.returnAt) return null
  const o = optionsOf(req.payload)
  const dateOf = eventsOf(o)?.dateOf
  let starts = f.returnAtEvent?.starts ?? null
  let tz = f.returnAtEvent?.timezone ?? null
  if (dateOf) {
    const date = await dateOf({ dateId: f.returnAt, req })
    if (!date || date.canceled) return { state: 'canceled', starts }
    starts = date.starts ?? starts
    tz = date.timezone ?? tz
  }
  if (!starts) return { state: 'upcoming', starts }
  const zone = tz || o.policy?.storeTimeZone || 'UTC'
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: zone })
  return { state: day(now) > day(new Date(starts)) ? 'missed' : 'upcoming', starts }
}

const countOut = async (req: PayloadRequest, o: ResolvedOptions, order: KitOrder) =>
  (await req.payload.count({ collection: 'kits', where: scoped(o, siteOfRecord(o, order), { and: [{ order: { equals: order.id } }, { status: { in: OUT } }] }), overrideAccess: true, req })).totalDocs

/**
 * Server only, daily (and at once through `noticeDateChanged`): a reminder a week before the date, once the kits have
 * shipped; at once when the date is canceled or moved; the day after a missed date if kits are still out. Each once
 * per order. The marker is saved first, then the notice goes through `notify` (kind `kit-dropoff`).
 */
export async function noticeEventReturns(req: PayloadRequest, input: { at?: Date; dateId?: string } = {}): Promise<{ reminded: number; canceled: number; missed: number; moved: number }> {
  const o = optionsOf(req.payload)
  const at = input.at ?? new Date()
  const out = { reminded: 0, canceled: 0, missed: 0, moved: 0 }
  const { docs } = await req.payload.find({
    collection: o.collections.orders,
    where: { and: [input.dateId ? { 'kitFulfillment.returnAt': { equals: String(input.dateId) } } : { 'kitFulfillment.returnAt': { exists: true } }, { 'kitFulfillment.status': { in: ['to-pack', 'packed', 'shipped'] } }] },
    ...READ,
  })
  const zone = o.policy?.storeTimeZone
  for (const order of docs as unknown as KitOrder[]) {
    const f = order.kitFulfillment!
    const e = f.returnAtEvent
    if (!f.returnAt || !e?.starts) continue
    const now = await returnAtState(req, f, at)
    if (!now) continue
    const still = await countOut(req, o, order)
    const when = `${e.name}, ${eventDay(e, zone)}${e.place ? `, ${e.place}` : ''}`
    const save = (data: Partial<ReturnAtEvent>) => inTransaction(freshReq(req), (r) => saveFulfillment(r, o, order, { returnAtEvent: { ...e, ...data } }, 'event drop-off notice'))
    // Moved: the buyer is told the new day, the kits carry it, and the week-before reminder follows it.
    if (now.state === 'upcoming' && now.starts && Math.abs(Date.parse(now.starts) - Date.parse(e.starts)) > 60_000) {
      const moved = { ...e, starts: now.starts }
      await inTransaction(freshReq(req), async (r) => {
        const kits = (await r.payload.find({ collection: 'kits', where: { and: [{ order: { equals: order.id } }, { returnInPerson: { exists: true } }] }, ...READ, req: r })).docs
        for (const k of kits) await r.payload.update({ collection: 'kits', id: k.id, data: { returnInPerson: inPersonText(moved, zone) } as never, overrideAccess: true, depth: 0, req: sysReq(r, { ...audit('event drop-off rescheduled'), [SKIP_LABEL_CANCEL]: true }) })
        await saveFulfillment(r, o, order, { returnAtEvent: { ...moved, remindedAt: null } }, 'event drop-off rescheduled')
      })
      if (await tell(req, o, order, 'Your kit drop-off date changed', `${e.name} moved from ${eventDay(e, zone)} to ${eventDay(moved, zone)}${e.place ? `, ${e.place}` : ''}. Can’t make the new day? Get a prepaid return label from your order page instead.`)) out.moved++
      continue
    }
    if (now.state === 'canceled') {
      if (e.canceledToldAt) continue
      await save({ canceledToldAt: at.toISOString() })
      if (await tell(req, o, order, 'Your kit drop-off date was canceled', `${when} was canceled, so you can’t hand your kits in there. Get a prepaid return label from your order page in one click, and mail them back instead.`)) out.canceled++
    } else if (now.state === 'missed') {
      if (e.missedToldAt || !still || f.status !== 'shipped') continue
      await save({ missedToldAt: at.toISOString() })
      if (await tell(req, o, order, 'Your kits still need to come back', `We didn’t get your kits at ${when}. Get a prepaid return label from your order page in one click, and mail them back.`)) out.missed++
    } else if (f.status === 'shipped' && !e.remindedAt && Date.parse(e.starts) - at.getTime() <= 7 * DAY && still) {
      await save({ remindedAt: at.toISOString() })
      if (await tell(req, o, order, `Bring your kits to ${e.name}`, `You chose to hand your kits in at ${when}. Look for our table. Can’t make it? Get a prepaid return label from your order page instead.`)) out.reminded++
    }
  }
  return out
}

async function tell(req: PayloadRequest, o: ResolvedOptions, order: KitOrder, subject: string, words: string): Promise<boolean> {
  const buyer = buyerOf(o, order)
  if (!buyer || !o.notify) return false
  try {
    await o.notify({ kind: 'kit-dropoff', to: { user: buyer, order: String(order.id) }, data: { order: String(order.id), subject, words }, req: freshReq(req) })
    return true
  } catch (error) {
    req.payload.logger.warn({ err: errName(error), order: String(order.id) }, 'Sample Kits: drop-off notice not sent')
    return false
  }
}

/**
 * For the events side to call after a booked date is saved, moved or canceled: its buyers are told now, rather than
 * at the next daily run. Agreed with Platform on 2026-11-10.
 */
export const noticeDateChanged = ({ dateId, req }: { dateId: string; req: PayloadRequest }) => noticeEventReturns(req, { dateId: String(dateId) })

/** Kit staff: each drop-off date on their site with the orders and kits still expected there, soonest first. */
export async function expectedAtEvents(req: PayloadRequest, input: { now?: Date } = {}) {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const site = await siteOf(o, req)
  const { docs } = await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { and: [{ 'kitFulfillment.returnAt': { exists: true } }, { 'kitFulfillment.status': { in: ['to-pack', 'packed', 'shipped'] } }] }), ...READ, req })
  const by = new Map<string, { dateId: string; event: ReturnAtEvent; orders: number; kits: number; state: ReturnAtState | null }>()
  for (const order of docs as unknown as KitOrder[]) {
    const f = order.kitFulfillment!
    const row = by.get(f.returnAt!) ?? { dateId: f.returnAt!, event: f.returnAtEvent!, orders: 0, kits: 0, state: (await returnAtState(req, f, input.now ?? new Date()))?.state ?? null }
    row.orders++
    row.kits += await countOut(req, o, order)
    by.set(f.returnAt!, row)
  }
  return [...by.values()].sort((a, b) => Date.parse(a.event?.starts ?? '') - Date.parse(b.event?.starts ?? ''))
}

/**
 * The keeper or buyer asks to mail back a kit marked for an event: allowed once the date was missed or canceled (never
 * stranded); before, refused with why. Every kit of the order still out goes back to mail returns together, so the
 * box's one label covers them. Returns the codes released; the label itself comes from `customerReturnLabel`.
 */
export async function releaseForMail(req: PayloadRequest, input: { code: string; now?: Date }): Promise<{ released: string[] }> {
  const o = optionsOf(req.payload)
  const me = personOf(o, req)
  if (!me) throw new KitError('noKit', 'That kit wasn’t found.')
  const site = await siteOf(o, req)
  const staff = await isStaff(o, req)
  return inTransaction(req, async (req) => {
    const { docs } = await req.payload.find({ collection: 'kits', where: scoped(o, site, { code: { equals: String(input?.code ?? '').replace(/\D/g, '') } }), limit: 1, ...READ, req })
    const kit = docs[0] as unknown as { id: string; code: string; order?: unknown; buyer?: unknown; activatedBy?: unknown; returnInPerson?: string | null } | undefined
    if (!kit || !(staff || idOf(kit.activatedBy) === String(me.id) || idOf(kit.buyer) === String(me.id))) throw new KitError('noKit', 'That kit wasn’t found.')
    if (!kit.order || !kit.returnInPerson?.trim()) return { released: [] }
    const order = await getKitOrder(req, o, site, kit.order)
    const now = await returnAtState(req, order.kitFulfillment, input.now ?? new Date())
    if (!now) return { released: [] }
    if (now.state === 'upcoming') throw new KitError('dropOffUpcoming', `These kits are being handed in at ${kit.returnInPerson}. If you can’t make it, you can get a return label the day after.`, { event: kit.returnInPerson })
    const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { and: [{ order: { equals: order.id } }, { returnInPerson: { exists: true } }, { status: { in: OUT } }] }), ...READ, req })).docs as unknown as { id: string; code: string; returnInPerson?: string | null }[]
    const released: string[] = []
    for (const k of kits) {
      if (!k.returnInPerson?.trim()) continue
      await req.payload.update({ collection: 'kits', id: k.id, data: { returnInPerson: null } as never, overrideAccess: true, depth: 0, req: sysReq(req, { ...audit('event drop-off missed: mail return'), [SKIP_LABEL_CANCEL]: true }) })
      released.push(k.code)
    }
    return { released }
  })
}

