import type { PayloadRequest, Where } from 'payload'

import { hasShipping } from '../carrier.js'
import { normalizeKitCode, parseTracking } from '../codes.js'
import { expectedAtEvents } from '../eventReturns.js'
import { idOf, KitError, ONE, READ, requireStaff, scoped, siteOf } from '../internal.js'
import { createLot, findKit, receiveKit, type LotInput } from '../kits.js'
import { batchKit, checkInKit, createBatch, shipBatch, unbatchKit, type BatchDoc } from '../lab.js'
import { ordersWithLabelProblems } from '../orderLabels.js'
import { makeOrderLabels } from '../orderLabels.js'
import { requestsToReview } from '../orderHelp.js'
import { getKitOrder, makeSlip, markShipped, orderKits, packKit, unpackKit } from '../packing.js'
import { releasePreorders } from '../preorders.js'
import { recalledAwaitingReplacement, replaceKit } from '../problems.js'
import { recallLot } from '../recall.js'
import { makeOrderReturnLabels, reprintReturnLabel, staleReturnLabels } from '../returns.js'
import { KIT_STATUS_LABELS, type KitStatus } from '../status.js'
import type { KitDoc, KitOrder, ResolvedOptions } from '../types.js'
import { say, serve, text, type ServerResult } from './result.js'

/**
 * Server functions for the staff pages (`/kits/*`). Each takes the request and a plain input, checks that the person
 * is kit staff of the request's site (through the actions it calls, or `requireStaff` for the read-only pages), and
 * answers a `ServerResult`. The site's route wraps each in its own rules (masquerade, CSRF, origin) first.
 */

/** A scan's answer, for the scan log. `outcome` says which kind, in words as well as by name. */
export type ScanAnswer = { code: string; outcome: 'done' | 'already' | 'warning'; message: string }

const statusWords = (o: ResolvedOptions, s: string) => say(o, `status.${s}`, KIT_STATUS_LABELS[s as KitStatus] ?? s)

const count = async (req: PayloadRequest, collection: string, where: Where) => (await req.payload.count({ collection: collection as never, where, overrideAccess: true, req })).totalDocs

export { STAFF_NAV } from '../ui/nav.js'

// ---------------------------------------------------------------- /kits

export type KitsHomeData = {
  counts: { preorders: number; inStock: number; toPack: number; packed: number }
  lots: { id: string; lotNumber: string; maker: string; expiresOn: string | null; expired: boolean; recalled: boolean; free: number; total: number }[]
  placeholders: ('box-types' | 'hubs' | 'labs')[]
  atEvents: { dateId: string; event: string; starts: string | null; place: string; kits: number; orders: number; state: string | null }[]
}

/** `/kits`: stock, what's waiting to pack, lots, placeholders still in use, and kits due at events. Kit staff. */
export function kitsHomePage(req: PayloadRequest): Promise<ServerResult<KitsHomeData>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const on = (w: Where) => scoped(o, site, w)
    const counts = {
      preorders: await count(req, o.collections.orders, on({ 'kitFulfillment.status': { equals: 'pre-order' } })),
      inStock: await count(req, 'kits', on({ status: { equals: 'in-stock' } })),
      toPack: await count(req, o.collections.orders, on({ 'kitFulfillment.status': { equals: 'to-pack' } })),
      packed: await count(req, o.collections.orders, on({ 'kitFulfillment.status': { equals: 'packed' } })),
    }
    const lotDocs = (await req.payload.find({ collection: 'kit-lots', where: on({ id: { exists: true } }), sort: '-createdAt', limit: 100, ...ONE, req })).docs as unknown as Record<string, unknown>[]
    const today = new Date().toISOString().slice(0, 10)
    const lots: KitsHomeData['lots'] = []
    for (const lot of lotDocs) {
      const expiresOn = lot.expiresOn ? String(lot.expiresOn).slice(0, 10) : null
      lots.push({
        id: String(lot.id),
        lotNumber: String(lot.lotNumber),
        maker: [lot.manufacturer, lot.model].filter(Boolean).join(' '),
        expiresOn,
        expired: Boolean(expiresOn && expiresOn < today),
        recalled: lot.recalled === true,
        free: await count(req, 'kits', on({ and: [{ lot: { equals: lot.id } }, { status: { equals: 'in-stock' } }] })),
        total: await count(req, 'kits', on({ lot: { equals: lot.id } })),
      })
    }
    const placeholders: KitsHomeData['placeholders'] = []
    for (const c of ['box-types', 'hubs', 'labs'] as const) if (await count(req, c, on({ placeholder: { equals: true } }))) placeholders.push(c)
    const atEvents = (await expectedAtEvents(req)).map((e) => ({ dateId: e.dateId, event: e.event?.name ?? '', starts: e.event?.starts ?? null, place: e.event?.place ?? '', kits: e.kits, orders: e.orders, state: e.state }))
    return { counts, lots, placeholders, atEvents }
  })
}

/** A new lot, and its kits when a serial range is given. Kit staff. */
export function submitLot(req: PayloadRequest, input: LotInput): Promise<ServerResult<{ lotNumber: string; added: number; message: string }>> {
  return serve(req, async (o) => {
    const num = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v))
    const { lot, added } = await createLot(req, {
      lotNumber: text(input?.lotNumber, 20),
      manufacturer: text(input?.manufacturer) || null,
      model: text(input?.model) || null,
      expiresOn: text(input?.expiresOn, 10) || null,
      quantity: num(input?.quantity),
      serialDigits: num(input?.serialDigits) ?? 6,
      firstSerial: num(input?.firstSerial),
      lastSerial: num(input?.lastSerial),
    })
    return { lotNumber: lot.lotNumber, added, message: say(o, 'lots.added', 'Lot {lot} added. Kits added: {n}.', { lot: lot.lotNumber, n: added }) }
  })
}

/** Move every waiting pre-order on this site into the packing queue. Kit staff. */
export function submitReleasePreorders(req: PayloadRequest): Promise<ServerResult<{ released: number; message: string }>> {
  return serve(req, async (o) => {
    const released = await releasePreorders(req)
    return { released, message: say(o, 'preorders.released', 'Pre-orders moved to packing: {n}.', { n: released }) }
  })
}

// ---------------------------------------------------------------- /kits/scan

/** Look a kit up: its status and lot, and nothing about who has it. Kit staff. */
export function scanLookup(req: PayloadRequest, input: { code: string }): Promise<ServerResult<ScanAnswer & { status: string; lot: string }>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const code = normalizeKitCode(input?.code)
    if (!code) throw new KitError('notACode', 'That isn’t a kit code. Kit codes are the 8 to 20 digits under the barcode.')
    const kit = await findKit(req, code, site)
    if (!kit) throw new KitError('unknownKit', `No kit ${code} on this site. Check the number, or receive its lot first.`, { code })
    const lot = (await req.payload.find({ collection: 'kit-lots', where: { id: { equals: idOf(kit.lot) } }, limit: 1, ...ONE, req })).docs[0] as { lotNumber?: string } | undefined
    const status = statusWords(o, kit.status)
    return { code, outcome: 'done', status: kit.status, lot: lot?.lotNumber ?? '', message: say(o, 'scan.found', 'Kit {code}: {status}, lot {lot}.', { code, status, lot: lot?.lotNumber ?? '' }) }
  })
}

/** Scan a kit into stock. Kit staff. */
export function scanReceive(req: PayloadRequest, input: { code: string }): Promise<ServerResult<ScanAnswer>> {
  return serve(req, async (o) => {
    const r = await receiveKit(req, String(input?.code ?? ''))
    return r.result === 'added'
      ? { code: r.code, outcome: 'done', message: say(o, 'scan.received', 'Kit {code} is in stock (lot {lot}).', { code: r.code, lot: r.lot }) }
      : { code: r.code, outcome: 'already', message: say(o, 'scan.already', 'Kit {code} was already received. It’s {status}.', { code: r.code, status: statusWords(o, r.status) }) }
  })
}

/** Check a returned kit in at the hub. Kit staff. */
export function scanCheckIn(req: PayloadRequest, input: { code: string; hub?: string }): Promise<ServerResult<ScanAnswer>> {
  return serve(req, async (o) => {
    const r = await checkInKit(req, { code: String(input?.code ?? ''), ...(input?.hub ? { hub: text(input.hub, 64) } : {}) })
    if (r.result === 'already') return { code: r.code, outcome: 'already', message: say(o, 'checkIn.already', 'Kit {code} was already checked in.', { code: r.code }) }
    const warnings = r.warnings.map((w) =>
      w === 'notSampled' ? say(o, 'checkIn.notSampled', 'Warning: it wasn’t marked as sampled. Check the tube before batching it.') : say(o, 'checkIn.otherHub', 'Warning: it was meant for another hub.'),
    )
    return { code: r.code, outcome: warnings.length ? 'warning' : 'done', message: [say(o, 'checkIn.done', 'Kit {code} checked in at {hub}.', { code: r.code, hub: r.hub }), ...warnings].join(' ') }
  })
}

// ---------------------------------------------------------------- recalls and replacements

/** Recall a lot. Needs a reason and `confirm: true` (the "can't be undone here" box). Kit staff. */
export function submitRecall(req: PayloadRequest, input: { lotNumber: string; reason: string; confirm: boolean }): Promise<ServerResult<{ lot: string; message: string }>> {
  return serve(req, async (o) => {
    if (input?.confirm !== true) throw new KitError('confirmRecall', 'Tick the box to confirm the recall. Only a maintainer can lift it later.')
    const { lot } = await recallLot(req, { lotNumber: text(input?.lotNumber, 20), reason: text(input?.reason, 300) })
    return { lot, message: say(o, 'recall.done', 'Lot {lot} is recalled. Its kits are set aside.', { lot }) }
  })
}

/** Replace a sold kit, or give its test back after the last free retest. Kit staff. */
export function submitReplace(req: PayloadRequest, input: { code: string; reason: string; note?: string }): Promise<ServerResult<{ outcome: string; code: string; message: string }>> {
  return serve(req, async (o) => {
    const r = await replaceKit(req, { code: text(input?.code, 40), reason: text(input?.reason, 40), note: text(input?.note, 300) })
    const message =
      r.outcome === 'replacement'
        ? say(o, 'replace.made', 'A free replacement order was made for kit {code}. It’s in the packing queue.', { code: r.code })
        : r.outcome === 'credit'
          ? say(o, 'replace.credit', 'Kit {code} had its last free retest. Its test was given back as credit.', { code: r.code })
          : say(o, 'replace.none', 'Kit {code} had its last free retest. Nothing more was given.', { code: r.code })
    return { outcome: r.outcome, code: r.code, message }
  })
}

// ---------------------------------------------------------------- packing

export type PackingQueueRow = { id: string; createdAt: string | null; status: string; kits: number; packed: number; slipMade: boolean; dropOff: string | null }

/** Orders to pack and packed orders waiting to ship, oldest first. Kit staff. */
export function packingPage(req: PayloadRequest): Promise<ServerResult<{ orders: PackingQueueRow[] }>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const docs = (await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { 'kitFulfillment.status': { in: ['to-pack', 'packed'] } }), sort: 'createdAt', limit: 200, ...ONE, req })).docs as unknown as KitOrder[]
    const orders: PackingQueueRow[] = []
    for (const d of docs) {
      const f = d.kitFulfillment ?? {}
      orders.push({
        id: String(d.id),
        createdAt: d.createdAt ? String(d.createdAt) : null,
        status: String(f.status),
        kits: (d.kitLines ?? []).reduce((n, l) => n + (Number(l.quantity) || 0), 0),
        packed: await count(req, 'kits', scoped(o, site, { order: { equals: d.id } })),
        slipMade: Boolean(f.slipMadeAt),
        dropOff: f.returnAtEvent?.name ?? null,
      })
    }
    return { orders }
  })
}

export type PackOrderData = {
  id: string
  createdAt: string | null
  status: string
  lines: { index: number; kind: string; quantity: number; packed: number }[]
  kits: { code: string; status: string; line: number | null; label: string | null; inPerson: string | null }[]
  total: number
  packed: number
  slipMadeAt: string | null
  shippedAt: string | null
  trackingNumbers: string[]
  dropOff: { event: string; starts: string | null; place: string } | null
  labels: { state: string | null; error: string | null; enabled: boolean }
  boxes: { box: number; name: string; kits: number }[]
  outbound: { box: number; tracking: string; labelUrl: string; unknown: boolean }[]
  returns: { id: string; box: number | null; kind: string; status: string; tracking: string; labelUrl: string }[]
  canShip: boolean
}

/** One order at the packing table: its lines, the kits packed, the slip, labels and tracking. Kit staff. */
export function packOrderPage(req: PayloadRequest, input: { order: string }): Promise<ServerResult<PackOrderData>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const order = await getKitOrder(req, o, site, input?.order)
    const { kits, lines, total, packed } = await orderKits(req, o, site, order)
    const f = order.kitFulfillment ?? {}
    const labels = hasShipping(o)
      ? ((await req.payload.find({ collection: 'return-labels', where: scoped(o, site, { and: [{ order: { equals: order.id } }, { kind: { not_equals: 'outbound' } }] }), sort: 'createdAt', ...READ, req })).docs as unknown as Record<string, unknown>[])
      : []
    return {
      id: String(order.id),
      createdAt: order.createdAt ? String(order.createdAt) : null,
      status: String(f.status ?? ''),
      lines,
      kits: kits.map((k) => ({ code: k.code, status: k.status, line: k.orderLine ?? null, label: (k.identifierLabel as string | null | undefined) ?? null, inPerson: typeof k.returnInPerson === 'string' && k.returnInPerson ? k.returnInPerson : null })),
      total,
      packed,
      slipMadeAt: f.slipMadeAt ?? null,
      shippedAt: f.shippedAt ?? null,
      trackingNumbers: f.trackingNumbers ?? [],
      dropOff: f.returnAtEvent?.name ? { event: f.returnAtEvent.name, starts: f.returnAtEvent.starts ?? null, place: f.returnAtEvent.place } : null,
      labels: { state: f.labels?.state ?? null, error: f.labels?.error ?? null, enabled: hasShipping(o) },
      boxes: (f.plan?.boxes ?? []).map((b) => ({ box: b.box, name: b.name, kits: b.kits })),
      outbound: (f.outboundLabels ?? []).map((l) => ({ box: l.box, tracking: l.tracking ?? '', labelUrl: l.labelUrl ?? '', unknown: l.unknown === true })),
      returns: labels.map((l) => ({ id: String(l.id), box: (l.box as number | null) ?? null, kind: String(l.kind), status: String(l.status), tracking: String(l.tracking ?? ''), labelUrl: String(l.labelUrl ?? '') })),
      canShip: f.status === 'packed' && Boolean(f.slipMadeAt) && packed === total,
    }
  })
}

/** Scan a kit into an order. Kit staff. */
export function scanPack(req: PayloadRequest, input: { order: string; code: string }): Promise<ServerResult<ScanAnswer & { packed: number; total: number }>> {
  return serve(req, async (o) => {
    const r = await packKit(req, { order: text(input?.order, 64), code: text(input?.code, 40) })
    const message = r.label
      ? say(o, 'packing.packedFor', 'Kit {code} packed for {label} ({packed} of {total}).', { code: r.code, label: r.label, packed: r.packed, total: r.total })
      : say(o, 'packing.packed', 'Kit {code} packed ({packed} of {total}).', { code: r.code, packed: r.packed, total: r.total })
    return { code: r.code, outcome: 'done', message, packed: r.packed, total: r.total }
  })
}

/** Take a kit back out of an order before it ships. Kit staff. */
export function scanUnpack(req: PayloadRequest, input: { order: string; code: string }): Promise<ServerResult<ScanAnswer>> {
  return serve(req, async (o) => {
    const r = await unpackKit(req, { order: text(input?.order, 64), code: text(input?.code, 40) })
    return { code: r.code, outcome: 'done', message: say(o, 'packing.unpacked', 'Kit {code} is back in stock.', { code: r.code }) }
  })
}

/**
 * The order slip: a new secret for every kit (older printouts stop working) and its activation link. Kit staff.
 * The secrets are for printing now and aren't shown again.
 */
export function submitSlip(req: PayloadRequest, input: { order: string }): Promise<ServerResult<{ kits: { code: string; secret: string; link: string | null; label: string | null }[] }>> {
  return serve(req, async () => {
    // The links' address is the plugin's `site.origin`, never the page's.
    const kits = await makeSlip(req, { order: text(input?.order, 64) })
    return { kits: kits.map((k) => ({ code: k.code, secret: k.secret, link: k.link, label: k.label })) }
  })
}

/** Mark an order shipped, with its tracking numbers (one per line, or separated by commas). Kit staff. */
export function submitShip(req: PayloadRequest, input: { order: string; tracking?: string }): Promise<ServerResult<{ kits: number; tracking: string[]; message: string }>> {
  return serve(req, async (o) => {
    const r = await markShipped(req, { order: text(input?.order, 64), tracking: parseTracking(text(input?.tracking, 2000)) })
    return { ...r, message: say(o, 'packing.shipped', 'Shipped. Kits: {n}. The buyer is told by email.', { n: r.kits }) }
  })
}

/** Buy (or finish buying) an order's outbound and return labels. Kit staff. */
export function submitOrderLabels(req: PayloadRequest, input: { order: string }): Promise<ServerResult<{ state: string; boxes: number; bought: number; message: string }>> {
  return serve(req, async (o) => {
    const r = await makeOrderLabels(req, { order: text(input?.order, 64) })
    const message =
      r.state === 'busy'
        ? say(o, 'labels.busy', 'Labels for this order are being made right now. Wait a minute, then reload the page.')
        : r.state === 'failed'
          ? say(o, 'labels.failed', 'Some labels weren’t made: {error}. Nothing was bought twice. Fix the problem, then try again.', { error: r.error ?? '' })
          : say(o, 'labels.done', 'Labels bought: {bought}, for boxes: {boxes}.', { bought: r.bought, boxes: r.boxes })
    return { state: r.state, boxes: r.boxes, bought: r.bought, message }
  })
}

/** One prepaid return label per outbound box. Kit staff. */
export function submitReturnLabels(req: PayloadRequest, input: { order: string }): Promise<ServerResult<{ made: number; current: number; unknown: number; message: string }>> {
  return serve(req, async (o) => {
    const r = await makeOrderReturnLabels(req, { order: text(input?.order, 64) })
    const message = r.unknown
      ? say(o, 'labels.unknown', 'A label purchase didn’t finish clearly. Check the carrier’s dashboard, then settle it in the admin before trying again.')
      : say(o, 'labels.returnsMade', 'New return labels: {made}. Already up to date: {current}.', { made: r.made, current: r.current })
    return { made: r.made, current: r.current, unknown: r.unknown, message }
  })
}

// ---------------------------------------------------------------- returns and check-in

export type ReturnsData = {
  hubs: { id: string; name: string }[]
  atEvents: KitsHomeData['atEvents']
  staleLabels: { id: string; order: string; box: number | null; tracking: string; createdAt: string; refundable: boolean }[]
  labelProblems: { id: string; error: string; at: string | null }[]
  recalled: { code: string; status: string }[]
  toReview: { order: string; createdAt: string; reasons: string[]; at: string }[]
  labelsEnabled: boolean
}

/** Returns and check-in: hubs to check in at, kits due at events, labels to reprint, and problems waiting for staff. Kit staff. */
export function returnsPage(req: PayloadRequest): Promise<ServerResult<ReturnsData>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const hubs = (await req.payload.find({ collection: 'hubs', where: scoped(o, site, { active: { not_equals: false } }), sort: 'name', ...READ, req })).docs as unknown as { id: string; name: string }[]
    const labelsEnabled = hasShipping(o)
    const atEvents = (await expectedAtEvents(req)).map((e) => ({ dateId: e.dateId, event: e.event?.name ?? '', starts: e.event?.starts ?? null, place: e.event?.place ?? '', kits: e.kits, orders: e.orders, state: e.state }))
    const recalled = (await recalledAwaitingReplacement(req)).map((k: KitDoc) => ({ code: k.code, status: k.status }))
    const toReview = (await requestsToReview(req)).map((r) => ({ order: r.id, createdAt: r.createdAt, reasons: r.request.reasons ?? [], at: r.request.at }))
    return {
      hubs: hubs.map((h) => ({ id: String(h.id), name: String(h.name) })),
      atEvents,
      staleLabels: labelsEnabled ? await staleReturnLabels(req) : [],
      labelProblems: await ordersWithLabelProblems(req),
      recalled,
      toReview,
      labelsEnabled,
    }
  })
}

/** Reprint a return label for the hub's current address; the old one's refund is asked for. Kit staff. */
export function submitReprint(req: PayloadRequest, input: { label: string }): Promise<ServerResult<{ result: string; refund: string | null; labelUrl: string; message: string }>> {
  return serve(req, async (o) => {
    const r = await reprintReturnLabel(req, { label: text(input?.label, 64) })
    const message =
      r.result === 'unknown'
        ? say(o, 'labels.unknown', 'A label purchase didn’t finish clearly. Check the carrier’s dashboard, then settle it in the admin before trying again.')
        : say(o, 'labels.reprinted', 'New label made. The old one’s refund: {refund}.', { refund: String(r.refund ?? 'none') })
    return { result: r.result, refund: r.refund ?? null, labelUrl: r.labelUrl, message }
  })
}

// ---------------------------------------------------------------- /kits/batches

export type BatchRow = { id: string; number: number; title: string | null; lab: string; status: string; size: number; kits: number; shippedAt: string | null }

/** Lab batches, newest first, and the labs a new one can go to. Kit staff. */
export function batchesPage(req: PayloadRequest): Promise<ServerResult<{ batches: BatchRow[]; labs: { id: string; name: string; sizes: number[] }[] }>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const labs = (await req.payload.find({ collection: 'labs', where: scoped(o, site, { active: { not_equals: false } }), sort: 'name', ...READ, req })).docs as unknown as { id: string; name: string; batchSizes?: number[] | null }[]
    const names = new Map(labs.map((l) => [String(l.id), String(l.name)]))
    const docs = (await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { id: { exists: true } }), sort: '-number', limit: 50, ...ONE, req })).docs as unknown as BatchDoc[]
    const batches: BatchRow[] = []
    for (const b of docs)
      batches.push({
        id: String(b.id),
        number: b.number,
        title: b.title ?? null,
        lab: names.get(idOf(b.lab) ?? '') ?? '',
        status: b.status,
        size: b.size,
        kits: await count(req, 'kits', scoped(o, site, { labBatch: { equals: b.id } })),
        shippedAt: b.shippedAt ?? null,
      })
    return { batches, labs: labs.map((l) => ({ id: String(l.id), name: String(l.name), sizes: l.batchSizes ?? [] })) }
  })
}

/** One batch: its lab, status and kits. Kit staff. */
export function batchPage(req: PayloadRequest, input: { batch: string }): Promise<ServerResult<BatchRow & { kitList: { code: string; status: string }[]; trackingNumbers: string[]; sizes: number[] }>> {
  return serve(req, async (o) => {
    await requireStaff(o, req)
    const site = await siteOf(o, req)
    const id = text(input?.batch, 64)
    const b = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? ((await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { id: { equals: id } }), limit: 1, ...ONE, req }).catch(() => ({ docs: [] }))).docs[0] as unknown as BatchDoc | undefined) : undefined
    if (!b) throw new KitError('noBatch', 'That batch isn’t here. Go back to the batch list and choose it again.')
    const lab = (await req.payload.find({ collection: 'labs', where: { id: { equals: idOf(b.lab) } }, limit: 1, ...ONE, req })).docs[0] as { name?: string; batchSizes?: number[] | null } | undefined
    const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { labBatch: { equals: b.id } }), sort: 'code', ...READ, req })).docs as unknown as KitDoc[]
    return {
      id: String(b.id),
      number: b.number,
      title: b.title ?? null,
      lab: lab?.name ?? '',
      status: b.status,
      size: b.size,
      kits: kits.length,
      shippedAt: b.shippedAt ?? null,
      trackingNumbers: b.trackingNumbers ?? [],
      sizes: lab?.batchSizes ?? [],
      kitList: kits.map((k) => ({ code: k.code, status: k.status })),
    }
  })
}

/** A new batch for a lab. Kit staff. */
export function submitNewBatch(req: PayloadRequest, input: { lab: string; size?: number | null }): Promise<ServerResult<{ id: string; number: number }>> {
  return serve(req, async () => {
    const size = input?.size === null || input?.size === undefined || String(input.size).trim() === '' ? null : Number(input.size)
    const b = await createBatch(req, { lab: text(input?.lab, 64), size })
    return { id: String(b.id), number: b.number }
  })
}

/** Scan a checked-in kit into a batch. Kit staff. */
export function scanBatch(req: PayloadRequest, input: { batch: string; code: string }): Promise<ServerResult<ScanAnswer>> {
  return serve(req, async (o) => {
    const r = await batchKit(req, { batch: text(input?.batch, 64), code: text(input?.code, 40) })
    return { code: r.code, outcome: 'done', message: say(o, 'batches.added', 'Kit {code} added ({count} of {size}).', { code: r.code, count: r.count, size: r.size }) }
  })
}

/** Take a kit back out of a batch before it ships. Kit staff. */
export function scanUnbatch(req: PayloadRequest, input: { batch: string; code: string }): Promise<ServerResult<ScanAnswer>> {
  return serve(req, async (o) => {
    const r = await unbatchKit(req, { batch: text(input?.batch, 64), code: text(input?.code, 40) })
    return { code: r.code, outcome: 'done', message: say(o, 'batches.removed', 'Kit {code} taken out of the batch.', { code: r.code }) }
  })
}

/** Ship a batch to its lab, with tracking; the lab is told after the commit. Kit staff. */
export function submitShipBatch(req: PayloadRequest, input: { batch: string; tracking?: string; oddSizeOk?: boolean }): Promise<ServerResult<{ kits: number; delivery: string; message: string }>> {
  return serve(req, async (o) => {
    // The site's name and portal address in the lab's notice come from the plugin's `site` option, never the page.
    const r = await shipBatch(req, { batch: text(input?.batch, 64), tracking: parseTracking(text(input?.tracking, 2000)), oddSizeOk: input?.oddSizeOk === true })
    const told = r.delivery === 'sent' || r.delivery === 'pending'
    return {
      kits: r.kits,
      delivery: String(r.delivery),
      message: told
        ? say(o, 'batches.shipped', 'Batch shipped. Kits: {n}. The lab is being told.', { n: r.kits })
        : say(o, 'batches.shippedNotTold', 'Batch shipped (kits: {n}), but the lab wasn’t told by email ({delivery}). Send them the kit list from the batch page.', { n: r.kits, delivery: String(r.delivery) }),
    }
  })
}
