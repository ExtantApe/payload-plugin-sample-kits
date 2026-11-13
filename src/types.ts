import type { CollectionConfig, Field, Payload, PayloadRequest, TypedUser, Where } from 'payload'

import type { KitStatus } from './status.js'

/**
 * The options for `sampleKits()`. Everything specific to a site comes in here: what a kit is for, who
 * may do what, its tenancy, and (in later phases) results, payments, shipping and its other plugins.
 *
 * Every provider call gets `{ req }` and runs inside the caller's transaction: a provider that reads
 * or writes must pass `req` on to Payload, and a provider that throws rolls the whole action back.
 */

/** The plugin's collections. Same slugs as the first site that used it, so switching it needed no migration. */
export const KIT_COLLECTION_SLUGS = ['kit-lots', 'kits', 'kit-events', 'box-types', 'hubs', 'labs', 'lab-batches', 'return-labels', 'kit-refunds', 'kit-notices'] as const
export type KitCollectionSlug = (typeof KIT_COLLECTION_SLUGS)[number]

/**
 * Who may do what. Each answers for the request's person, and only an answer of exactly `true`
 * counts: `1`, `'yes'`, a query or a thrown error is a no.
 * - `staff`: works with kits (stock, lots, recall, hubs' and labs' records to read).
 * - `admin`: sets up box types, hubs and labs, and deletes records.
 * - `maintainer`: the only one who can lift a recall or delete a custody-trail row.
 * A maintainer passes as admin and staff, and an admin as staff.
 */
export type AccessCheck = (req: PayloadRequest) => boolean | Promise<boolean>

export type SampleKitsAccess = {
  staff: AccessCheck
  admin: AccessCheck
  maintainer: AccessCheck
  /**
   * The kits a signed-in person who isn't staff may read: a Payload query, such as kits they bought
   * or activated (`buyerOrKeeper`, exported, is that rule). Anything but a non-empty query object,
   * `true` included, is refused. Leave it out and only staff read kits.
   */
  buyerOf?: (args: { req: PayloadRequest; user: TypedUser }) => Where | false | null | Promise<Where | false | null>
}

/** Tenancy. Omit it on a single-site install. */
export type Scope = {
  /** The field that holds a record's site, added by the site's multi-tenant plugin (e.g. `tenant`). */
  field: string
  /** The site this request is for, or null when there isn't one (actions then refuse). */
  of: (req: PayloadRequest) => string | number | null | Promise<string | number | null>
  /**
   * Whether this person may use the lab portal for `lab` on this site (for example, a Lab partner role
   * on the tenant). Only exactly `true` passes, and the person must also be listed on the lab's `portalUsers`.
   * Leave it out and being listed is enough.
   */
  isLabUser?: (req: PayloadRequest, lab: { id: string | number; [field: string]: unknown }) => boolean | Promise<boolean>
}

/** What a kit can be for, as an opaque reference the subject provider understands. */
export type SubjectRef = { kind: string; id: string }

/** A refusal people should see, from a provider. `code` names it for translation. */
export type Refusal = { code: string; message: string }

/** One choice in activation's subject picker. */
export type Subject = { ref: SubjectRef; label: string; suggested?: boolean }

/** A kit as the plugin reads it. Site fields (from `subjects.fields` and `overrides`) are there too. */
export type KitDoc = {
  id: string | number
  code: string
  lot: unknown
  status: KitStatus
  test?: string | null
  buyer?: unknown
  order?: unknown
  orderLine?: number | null
  identifierLabel?: string | null
  activatedBy?: unknown
  activatedAt?: string | null
  sampledAt?: string | null
  secretHash?: string | null
  secretIssuedAt?: string | null
  [field: string]: unknown
}

/**
 * The subject provider: what a kit is sampled from (for example animals and groups). The plugin
 * stores no subject field of its own: the provider brings its fields and maps them.
 */
export type SubjectsProvider = {
  /** The site's own kit fields, added to `kits` (for example `forAnimal`, `forGroup`, `animal`). */
  fields: Field[]
  /**
   * Which of `fields` say what the kit was bought for (for example `forAnimal`, `forGroup`). Through the API they
   * read for the buyer and kit staff only; every other subject field (what was sampled) reads for the keeper and kit
   * staff only. A field's own `read` access must pass too. Leave it out and every subject field is the keeper's.
   */
  buyerFields?: string[]
  /** What a kit can be for, e.g. `['animal', 'group']`. Activation refuses other kinds when given. */
  kinds?: string[]
  /** What the kit was bought for, if anything (the suggestion at activation). */
  suggestedOf: (kit: KitDoc) => SubjectRef | null
  /** What the kit was sampled from, once activated. */
  sampledOf: (kit: KitDoc) => SubjectRef | null
  /** The data to write on the kit when it's activated for `ref`. Only keys of `fields` are allowed. */
  assign: (args: { kit: KitDoc; ref: SubjectRef; req: PayloadRequest }) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Whether this person may sample this subject with this kit. Only exactly `true` passes. */
  canSample: (args: { user: TypedUser; ref: SubjectRef; kit: KitDoc; req: PayloadRequest }) => true | Refusal | Promise<true | Refusal>
  /** What activation offers, the suggestion first. (Phase 4: the pages.) */
  choices?: (args: { user: TypedUser; kit: KitDoc; req: PayloadRequest }) => Promise<Subject[]>
  /** The subject's name for labels, e.g. "Kinixys | Group #1". Never a person's name. */
  label?: (args: { ref: SubjectRef; req: PayloadRequest }) => Promise<string | null>
  /** Whether a product may be sold for this subject. (Phase 3: checkout's checks.) */
  canSell?: (args: { product: unknown; ref: SubjectRef; req: PayloadRequest }) => Promise<true | Refusal>
  /** The site's own fields on each order line (for example `group`, `animals`). */
  lineFields?: Field[]
  /** The line kinds orders may use, besides `count` (not assigned yet). Default: `kinds`, labeled by name. */
  lineKinds?: { label: string; value: string }[]
  /**
   * At packing: what the `slot`-th kit of this line is for. `set` is written on the kit (only keys of `fields`),
   * `label` goes on its identifier label. Leave it out and kits are packed with no subject.
   */
  packFor?: (args: { line: KitLine; index: number; slot: number; kit: KitDoc; order: KitOrder; req: PayloadRequest }) => PackedFor | Promise<PackedFor>
  /** A free replacement's order line for this kit's subject: `kind` and the line fields. Default `{ kind: 'count' }`. */
  lineFor?: (args: { kit: KitDoc; req: PayloadRequest }) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
}

export type PackedFor = { set?: Record<string, unknown>; label?: string | null }

/** One kind of test a kit can carry, e.g. `{ label: 'Cytochrome b (cyt-b)', value: 'cyt-b' }`. The first is the default. */
export type KitTest = {
  label: string
  value: string
  /** What the lab calls it on the batch's kit list (for example `cytb` for `cyt-b`). Default: `value`. */
  marker?: string
}

/** The site's other collections, by slug. */
export type SiteCollections = { users?: string; orders?: string; products?: string; files?: string }

// ---------------------------------------------------------------- results

/**
 * A result file a lab uploaded, after the plugin's checks (name, type, size) and its checksum. Sent as bytes (base64),
 * `data` and `text` are set and `fileId` is null. Uploaded straight to the site's storage (`results.verifyUpload`),
 * `fileId`, `type` and the site's checked size and SHA-256 are set, and `data` and `text` are null: the site reads the
 * stored file itself.
 */
export type ResultFile = { name: string; data: Uint8Array | null; text: string | null; sha256: string; size: number; fileId: string | null; type: string | null }

/** What the site's storage says about an uploaded file, after its own checks. */
export type VerifiedUpload = { fileId: string; name: string; size: number; type: string; sha256: string }

/** What the results provider says about a file: `failed` is a refusal, with `summary` as the reason the lab sees. */
export type ResultAnswer = {
  status: 'ready' | 'review' | 'failed'
  /** For `failed`, the reason in plain words, shown to the lab. Otherwise kept for staff only. */
  summary?: string
  /** The site's record of the stored file (its `files` collection), if it stored one. */
  file?: string | number | null
}

/** What a result means is the site's. The plugin checks the file and matches it to a kit; the provider stores and reads it. */
export type ResultView = { status: 'ready' | 'review' | 'failed'; summary?: string; [key: string]: unknown }
export type ResultsProvider = {
  /**
   * Store and read one lab file for this kit. Runs in the plugin's transaction: a throw rolls the upload back. With
   * `verifyUpload`, `file.fileId` names what the site already stored and `file.data` is null.
   */
  accept: (args: { kit: KitDoc; file: ResultFile; lab: { id: string | number; name: string }; rerun: boolean; req: PayloadRequest }) => Promise<ResultAnswer>
  /** The result for the keeper. The plugin only asks for the kit's keeper and kit staff, and returns null to anyone else. */
  view: (args: { kit: KitDoc; user: TypedUser | null; req: PayloadRequest }) => Promise<ResultView | null>
  /** File endings the portal takes. Default: FASTA and plain text (`RESULT_EXTENSIONS`). */
  extensions?: string[]
  /** Content types the portal takes from `verifyUpload`. Default: plain text, FASTA and unknown binary (`RESULT_TYPES`). */
  types?: string[]
  /**
   * Uploads by file id (agreed with the site's team, 2026-11-10): the lab's browser puts the file in the site's private
   * storage first, and the page sends only its id. The site answers what it stored, or throws to refuse. It must check
   * the uploader is this request's person, the site, private storage, that the upload is recent and not used before,
   * and the stored size, type and SHA-256. The plugin then checks name, type and size again, matches the kit by the
   * code in the file's name, and refuses an id any kit's result already used. With it, base64 uploads are refused.
   */
  verifyUpload?: (args: { fileId: string; req: PayloadRequest }) => Promise<VerifiedUpload>
  /** Without `verifyUpload`: the largest file taken as base64, in bytes. Default 3 MB (hosts cap a request at about 4.5 MB). */
  maxBase64Bytes?: number
  /** Largest file, in bytes. Default 900,000. */
  maxBytes?: number
  /** A plain-words reason a file's contents can't be used, or null, checked before `accept`. `fastaProblem` is one. */
  check?: (text: string) => string | null
}

// ---------------------------------------------------------------- orders

/** One line of a kit order, as stored in the order's `kitLines`. The subject provider's line fields are there too. */
export type KitLine = { kind: string; quantity: number; test?: string | null; [field: string]: unknown }

/** An outbound label bought for one box of an order at order time, kept in `kitFulfillment.outboundLabels`. */
export type OutboundLabel = {
  box: number
  boxType?: string | null
  kits?: number | null
  tracking?: string | null
  carrier?: string | null
  service?: string | null
  costCents?: number | null
  labelUrl?: string | null
  shipmentId?: string | null
  mode?: string | null
  weightOz?: number | null
  refund?: string | null
  at?: string | null
  /** The purchase's outcome isn't known (Shipping's `MAYBE_BOUGHT`): it may have been bought. */
  unknown?: boolean | null
  /** What the purchase was called at the carrier, to look it up. */
  reference?: string | null
}

/** A kit order as the plugin reads it: the site's own fields are there too. */
export type KitOrder = {
  id: string | number
  kitLines?: KitLine[] | null
  kitFulfillment?: (Record<string, unknown> & {
    status?: string | null
    slipMadeAt?: string | null
    trackingNumbers?: string[] | null
    shippedAt?: string | null
    plan?: { boxes?: SavedBox[] | null; [key: string]: unknown } | null
    returnAt?: string | null
    outboundLabels?: OutboundLabel[] | null
    labels?: { state?: string | null; error?: string | null; at?: string | null; run?: string | null } | null
    shippedEmail?: { delivery?: string | null; at?: string | null } | null
    replaces?: unknown
    returnShippingCents?: number | null
    shippingRefund?: { status?: string | null; amountCents?: number | null; reason?: string | null; by?: unknown; at?: string | null; refundId?: string | null } | null
    agreed?: { text?: string | null; at?: string | null } | null
    returnAtEvent?: ReturnAtEvent | null
    promisedBy?: string | null
    revisedBy?: string | null
    delayNoticeFor?: string | null
    missedNoticeFor?: string | null
    preorderVote?: PreorderVote | null
    requests?: HelpRequest[] | null
    orderRefund?: { status?: string | null; amountCents?: number | null; deductedCents?: number | null; creditsBack?: number | null; refundId?: string | null; at?: string | null; by?: unknown } | null
  }) | null
  [field: string]: unknown
}

/** What the buyer chose for an event drop-off, as it was then, with when each notice went. */
export type ReturnAtEvent = {
  name: string
  slug: string
  starts: string
  timezone: string | null
  place: string
  remindedAt?: string | null
  canceledToldAt?: string | null
  missedToldAt?: string | null
}

/** One request on an order's help page, and its decision. */
export type HelpRequest = {
  kind: 'refund' | 'help' | 'missed-date'
  reasons: string[]
  details?: string | null
  at: string
  outcome: 'refunded' | 'cancelled' | 'review' | 'declined' | 'waiting' | 'reallocated' | 'credited' | 'replaced'
  amountCents?: number | null
  deductedCents?: number | null
  decidedBy?: unknown
  decidedAt?: string | null
  note?: string | null
  [field: string]: unknown
}

/** One box of an order's saved plan. */
export type SavedBox = { box: number; boxType: string; name: string; kits: number; parcel: ParcelSize | null }

/**
 * What the plugin reads from the site's orders, which belong to the site (often an ecommerce plugin).
 * Every member is optional; the defaults read the Payload ecommerce plugin's fields.
 */
export type OrdersProvider = {
  /** The buyer's user id. Default: the order's `customer`. */
  buyerOf?: (order: KitOrder) => string | number | null | undefined
  /**
   * The query for a buyer's orders, for `/my-tests` (phase 4b). Default `{ customer: { equals: buyer } }`, matching
   * `buyerOf`'s default. Every order it finds is checked again with `buyerOf`, so a loose query can't show another's.
   */
  buyerWhere?: (buyer: string) => Where
  /** Where the order ships, in Shipping's stored-address shape. Without it, labels to the buyer are refused. */
  shipTo?: (args: { order: KitOrder; req: PayloadRequest }) => StoredAddress | null | Promise<StoredAddress | null>
  /** Shipping paid on the order, in cents: the most "refund shipping" gives back. Default: `totals.shipping`, never above `amount`. */
  shippingPaidCents?: (args: { order: KitOrder; req: PayloadRequest }) => number | Promise<number>
  /** The site's own fields for a free replacement order (the buyer, the address, a zero amount). Default: `{ customer }`. */
  replacement?: (args: { order: KitOrder; kit: KitDoc; req: PayloadRequest }) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Called when an order ships, in the same transaction, for the site's own fields (e.g. its order status). */
  onShipped?: (args: { order: KitOrder; req: PayloadRequest }) => void | Promise<void>
  /** What the order paid, in cents: the most all its refunds together give back. Default: `amount`. */
  paidCents?: (args: { order: KitOrder; req: PayloadRequest }) => number | Promise<number>
  /**
   * Called when an order is canceled, in the same transaction, for the site's own fields (for example its order
   * `status` and `kitsRefunded`). `refundCents` is what this cancellation gave back.
   */
  onCanceled?: (args: { order: KitOrder; mode: 'refund' | 'credit'; refundCents: number; req: PayloadRequest }) => void | Promise<void>
  /**
   * For `seedKitStory`: the site's own fields for a made-up paid order (the buyer, an amount, where its payment id
   * goes). `paymentId` is a stand-in, `seed_pi_<16 digits>`, never a real payment. Default: `{ customer: buyer }`.
   */
  seeded?: (args: { buyer: string; kits: number; paymentId: string; req: PayloadRequest }) => Record<string, unknown> | Promise<Record<string, unknown>>
}

// ---------------------------------------------------------------- payments

export type RefundRecord = { id: string; amountCents?: number; status?: string }

/**
 * Throw this shape from `payments.refund` (an error with `refused: true`, or a `KitError`) when the payment service
 * clearly refused and nothing was refunded. Any other throw (a timeout, a dropped connection) may have refunded: it's
 * recorded `unknown` and counted as paid back until a site admin settles it.
 */
export type RefundRefusal = Error & { refused: true }
/** Payments only take and return money. The site's provider (Stripe, say) does the rest. */
export type PaymentsProvider = {
  /**
   * Gives money back on an order. `key` is the same for a repeat of the same refund: pass it to the payment
   * service as its idempotency key, so a retry never refunds twice.
   */
  refund: (args: { order: KitOrder; amountCents: number; reason: string; key: string; req: PayloadRequest }) => Promise<RefundRecord>
  /** After the last free retest fails, with `policy.afterLastRetest: 'credit'`. `key` is the same for the same kit. */
  creditBack: (args: { kit: KitDoc; reason: string; key: string; req: PayloadRequest }) => Promise<{ id?: string } | void>
  /**
   * Test credits back when an order is canceled (for example credits used on the order, or one per kit with
   * `mode: 'credit'`). Answer how many were given. Without it, "take credit" isn't offered and no credits come back.
   */
  creditOrder?: (args: { order: KitOrder; mode: 'refund' | 'credit'; reason: string; key: string; req: PayloadRequest }) => Promise<{ credits: number }>
  /** What the order paid for. Not called by the plugin (it reads `kitLines`); kept for the site's own use. */
  orderKits?: (args: { order: unknown; req: PayloadRequest }) => KitLine[] | Promise<KitLine[]>
}

export type KitPolicy = {
  /** Free new kits after a failed sample, per subject. Default 1 (two attempts in all). */
  freeRetests?: number
  /** After the last free retest fails: give a test back through `payments.creditBack`, or nothing. Default 'credit'. */
  afterLastRetest?: 'credit' | 'none'
  returnWithinDays?: number
  /** Days after ordering when "Request a refund" gives everything back. Default 30. */
  refundWithinDays?: number
  /** Most months a pre-order may promise ahead. Default 6. */
  preorderMaxMonths?: number
  /** The store's calendar, for refund windows and promised dates (e.g. 'America/Phoenix'). Default 'UTC'. */
  storeTimeZone?: string
  supportEmail?: string
  /** What one packed kit weighs, in ounces, for parcels. Default 4.2 (a placeholder). */
  kitWeightOz?: number
  /** What a return parcel weighs, in ounces, when it's bought apart from its box. Default 8 (a placeholder). */
  returnWeightOz?: number
}

/**
 * The site's notifications and email, called after the commit. Answer how it went, if you know:
 * `'sent'`, `'not-sent-side-effects-off'`, `'not-sent-test-addresses'` or `'no-address'`. Nothing means sent;
 * a throw is recorded as `'failed'`. `to` is `{ user, order }`: the site finds the address.
 */
export type NoticeDelivery = 'sent' | 'not-sent-side-effects-off' | 'not-sent-test-addresses' | 'no-address' | 'failed'
export type Notify = (args: {
  kind: string
  /**
   * `lab` and `emails` are set for a lab's batch notice, where `user` and `order` are null. `staff` is set for a notice
   * to the site's kit staff (`kit-shipment-staff`), where `user` is null and `site` is the order's site (null without
   * `scope`). A keeper's notice (`kit-arrived`, and a return parcel's `kit-shipment`) has `order` null: a keeper may
   * be a minor who got the kit as a gift, and never sees the buyer's order.
   */
  to: { user: string | null; order: string | null; lab?: string | null; emails?: string[]; staff?: boolean; site?: string | null }
  data: Record<string, unknown>
  req: PayloadRequest
}) => Promise<void | NoticeDelivery>

// ---------------------------------------------------------------- shipping

/** The address problems Shipping (`payload-plugin-shipping`) reports, by name. */
export type AddressProblem = 'placeholder' | 'name' | 'street' | 'poBox' | 'city' | 'state' | 'zip' | 'gdZip'
/** Shipping's stored address: a street, a USPS PO Box or USPS General Delivery. */
export type StoredAddress = {
  kind?: 'street' | 'po-box' | 'general-delivery' | null
  name?: string | null
  company?: string | null
  line1?: string | null
  line2?: string | null
  poBox?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  phone?: string | null
}
/** Shipping's label address (EasyPost's shape). */
export type LabelAddress = { name: string; company: string | null; street1: string; street2: string | null; city: string; state: string; zip: string; country: 'US'; phone: string | null }
export type Parcel = { weightOz: number; lengthIn?: number | null; widthIn?: number | null; heightIn?: number | null }
export type ParcelSize = { lengthIn: number; widthIn: number; heightIn: number; weightOz: number }
export type Quote = { shipmentId: string; rate: { id: string; carrier: string; service: string; rate: string; fake?: boolean }; rateCents: number; mode: 'test' | 'production'; fake?: boolean }
export type Label = { shipmentId: string; tracking: string; carrier: string; service: string; rateCents: number; labelUrl: string; trackerUrl: string | null; mode: 'test' | 'production'; fake?: boolean }
export type RefundStatus = 'submitted' | 'refunded' | 'rejected' | 'not_applicable'
type Req = Partial<PayloadRequest>
type HubAddress = { address?: StoredAddress | null; placeholder?: boolean | null }
type LabelInput = { from: LabelAddress; to: LabelAddress; parcel: Parcel; carrier?: 'any' | 'USPS'; reference: string }

/**
 * Shipping's side (`payload-plugin-shipping`), never imported: a site passes Shipping's own functions,
 * unchanged. Errors are read by their `code`, never by class:
 * - `MAYBE_BOUGHT`: a label may have been bought. Sample Kits records it as unknown and never buys it again by itself;
 * - `REFUSED`: production postage is refused here. Nothing was bought.
 *
 * `addressProblems` alone checks hubs' addresses. Labels need the rest: give all of `quote`, `buy`, `buyReturn`,
 * `quoteReturn`, `refund`, `labelAddress`, `addressKey` and `parcelFor`, or none of them.
 */
export type ShippingAdapter = {
  addressProblems?: (address: StoredAddress, opts?: { placeholder?: boolean | null }) => AddressProblem[] | Promise<AddressProblem[]>
  quote?: (payload: Payload, input: LabelInput, req?: Req) => Promise<Quote>
  buy?: (payload: Payload, quote: Quote, req?: Req) => Promise<Label>
  buyLabel?: (payload: Payload, input: LabelInput, req?: Req) => Promise<Label>
  buyReturn?: (payload: Payload, input: { customer: LabelAddress; hub: HubAddress; parcel: Parcel; carrier?: string; reference: string }, req?: Req) => Promise<Label>
  quoteReturn?: (payload: Payload, input: { customer: LabelAddress; hub: HubAddress; parcel: Parcel; reference: string }, req?: Req) => Promise<Quote>
  refund?: (payload: Payload, shipmentId: string, req?: Req) => Promise<RefundStatus>
  verifyAddress?: (payload: Payload, address: LabelAddress, req?: Req) => Promise<unknown>
  /** Throws an error with a `problems` list when the address can't go on a label. */
  labelAddress?: (address: StoredAddress | null | undefined, opts?: { placeholder?: boolean | null }) => LabelAddress
  addressKey?: (address: LabelAddress) => string
  parcelFor?: (box: { outside: [number, number, number] | null; emptyWeightOz?: number | null }, contentsWeightOz: number) => ParcelSize | null
  /** When given, box types too big or heavy to mail are left out of plans. */
  mailability?: (parcel: ParcelSize) => { mailable: boolean; notes: string[] }
}

/** The members labels need. */
export const LABEL_MEMBERS = ['quote', 'buy', 'buyReturn', 'quoteReturn', 'refund', 'labelAddress', 'addressKey', 'parcelFor'] as const
export type LabelShipping = Required<Pick<ShippingAdapter, (typeof LABEL_MEMBERS)[number]>> & ShippingAdapter

/**
 * Events drop-off, agreed with Platform on 2026-11-10. The type lives here, since this plugin is the consumer; the
 * site's adapter maps its event dates onto it. `miles` is optional, so a site without geocoding still works.
 */
export type DropOffChoice = { dateId: string; eventName: string; eventSlug: string; starts: string; timezone: string; place: string; miles?: number }
export type EventsAdapter = {
  dropOffChoices: (args: { tenant: string | number | null; country: string; postalCode: string; now: Date; req: PayloadRequest }) => Promise<DropOffChoice[]>
  /**
   * Optional, beyond the agreed shape: a booked date as the events side has it now, or null when it's gone. Without
   * it, canceled and rescheduled dates can't be told, and the plugin works from what the buyer chose.
   */
  dateOf?: (args: { dateId: string; req: PayloadRequest }) => Promise<{ starts: string; timezone?: string | null; canceled?: boolean } | null>
}

type ID = string | number
type KReq = Partial<PayloadRequest>

/**
 * Kitting's units (`payload-plugin-kitting`), never imported: a site passes Kitting's own exports, unchanged, with
 * `payload` first, as Kitting declares them. Each joins the transaction of the `req` it's given, so a kit's status
 * and its unit change together or not at all. Kitting's refusals are read by their `code` (`unitNotFound`,
 * `nothingReserved`, `unitStatus`, …), never by class.
 *
 * Wire Kitting's `units.onBuild` to the exported `kittingOnBuild(...)`, so each built kit is an in-stock kit in the
 * build's transaction.
 */
export type KittingAdapter = {
  /** The sample kit's recipe in Kitting, e.g. `{ key: 'sample-kit' }`. */
  recipe: { key: string } | { id: ID }
  assignUnits: (payload: Payload, recipe: { key: string } | { id: ID }, count: number, context: { reference: string; scope?: ID; req?: KReq; queue?: boolean }) => Promise<unknown>
  swapUnit: (payload: Payload, args: { reference: string; take: { id: ID } | { externalId: string }; scope?: ID; req?: KReq }) => Promise<unknown>
  release: (payload: Payload, args: { reference: string; unit?: { id: ID } | { externalId: string }; scope?: ID; req?: KReq }) => Promise<unknown>
  shipUnits: (payload: Payload, ids: ID[], options?: { req?: KReq }) => Promise<unknown>
  voidUnit: (payload: Payload, unitID: ID, args: { reason: 'dud' | 'damaged' | 'mistake' | 'other'; note?: string; req?: KReq }) => Promise<unknown>
  /** Kitting holds its stock emails while it joins a transaction: called after the commit. */
  sendPendingAlerts?: (payload: Payload) => Promise<unknown>
  /** Kitting's units collection. Default `assembled-units`. */
  units?: string
  /** The field Kitting keeps a unit's site in. Default: `scope.field`. */
  scopeField?: string
  /** How an order is named on its units. Default `Order <id>`, the first site's format, so its units still match. */
  reference?: (orderId: string) => string
}

/** What a scan link opens, by path on the site. Each default is the first site's path. */
export type ScanPaths = {
  /** A kit's record, for kit staff. Default `/kits/scan?mode=lookup&code=<code>`. */
  kit?: (code: string) => string
  /** Activation, for the buyer. Default `/my-tests/activate?kit=<code>`. Never with the secret. */
  activate?: (code: string) => string
  /** An order's packing page, for kit staff. Default `/kits/packing/<order>`. */
  order?: (orderId: string, box: number) => string
  /** The buyer's order page. Default `/my-tests/orders/<order>`. */
  myOrder?: (orderId: string) => string
}

/** Wizards (`payload-plugin-wizards`), never imported: the site passes Wizards' own `answersFor`, unchanged. */
export type WizardsAdapter = {
  answersFor: (
    payload: Payload,
    args: { flow: string; answers: unknown; locale?: string },
  ) => Promise<{ ok: true; record: { flow: string; at: string; locale: string | null; answers: unknown[] } } | { ok: false; problem: string; key?: string }>
}

/** Optional links to our other plugins. None is imported; the site wires each. */
export type SampleKitsAdapters = {
  shipping?: ShippingAdapter
  events?: EventsAdapter
  kitting?: KittingAdapter
  labels?: Record<string, unknown>
  /** Registers the scan kinds `k` (kit code) and `b` (shipping box) at `config.custom.scanKinds`. */
  scan?: true | { paths?: ScanPaths }
  /** Registers the `kit-activation` flow at `config.custom.wizardFlows`, and checks `markSampled`'s answers. */
  wizards?: WizardsAdapter
  /**
   * The seed plugin's own `allow(req)`, passed unchanged. `seedKitStory` and `removeKitRecords` ask it first, and only
   * an answer of exactly `true` lets them run. Without it, seeding is refused (`seedNotAllowed`).
   */
  seed?: SeedAdapter
}

/** The seed plugin's gate, never imported: the site passes the seed plugin's own `allow`. */
export type SeedAdapter = { allow: (req: PayloadRequest) => boolean | Promise<boolean> }

/**
 * The site's name and address, for order slips' activation links and the lab's batch notice. From options, never from
 * a page. `origin` has no path (e.g. `https://kits.example.com`); `labPortalPath` defaults to `/lab`.
 */
export type SiteInfo = { name?: string; origin?: string; labPortalPath?: string }

/** Order help's optional reasons, each off until the site turns it on. */
export type OrderHelpOptions = { reasons?: { damaged?: boolean } }

export type SampleKitsOptions = {
  access: SampleKitsAccess
  subjects: SubjectsProvider
  /** The tests a kit can carry. Required: there's no default list. */
  tests: KitTest[]
  /** Slugs of the site's collections. Default `users`, `orders`, `products`, `files`. */
  collections?: SiteCollections
  scope?: Scope
  /**
   * The site's name and address (`SiteInfo`), or a function of the request's site (`scope.of`) for many sites. It must
   * come from trusted server data, never a header or cookie the browser chose.
   */
  site?: SiteInfo | ((args: { site: string | null; req: PayloadRequest }) => SiteInfo | null | Promise<SiteInfo | null>)
  /**
   * The site's changes to each plugin collection (its ID fields, admin components, tenant hooks). The
   * plugin's own rules are put back after an override, and its access can only be narrowed.
   */
  overrides?: Partial<Record<KitCollectionSlug, (collection: CollectionConfig) => CollectionConfig>>
  results?: ResultsProvider
  payments?: PaymentsProvider
  /** What the plugin reads from the site's orders. */
  orders?: OrdersProvider
  policy?: KitPolicy
  notify?: Notify
  i18n?: { t: (key: string, vars?: Record<string, string | number>) => string }
  /**
   * Pre-order votes stay in the site. `place`: a new pre-order (after the commit; a throw is logged, never fails the
   * order). `move`: the buyer moves it to `item` after a missed date (in the transaction; a throw refuses). `withdraw`:
   * the order was canceled (after the commit). Answer the vote to keep on the order, or null.
   */
  onPreorderVote?: (args: { action: 'place' | 'move' | 'withdraw'; order: KitOrder; item: string | null; req: PayloadRequest }) => Promise<PreorderVote | null | void>
  /** Pre-orders: `voteItems` names the collection a vote's `item` points to (for example `roadmap-items`); else it's text. */
  preorders?: { voteItems?: string }
  /**
   * `'startup'` (default) makes the indexes money depends on when Payload starts. `'manual'` only checks they're there
   * and refuses to start if not: run `ensureSampleKitsIndexes(payload)` from your own index script first.
   */
  ensureIndexes?: 'startup' | 'manual'
  adapters?: SampleKitsAdapters
  /** Order help: `reasons.damaged` (default false) offers and accepts "damaged". */
  orderHelp?: OrderHelpOptions
}

/** A pre-order's vote, as the site keeps it on the order. */
export type PreorderVote = { item?: string | null; vote?: string | null; contribution?: string | null }

/** The options after start-up checks, with defaults filled in. Kept at `config.custom.sampleKits`. */
export type ResolvedOptions = SampleKitsOptions & { collections: Required<SiteCollections> }
