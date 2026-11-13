import { APIError, type Access, type Where, type CollectionAfterChangeHook, type CollectionBeforeChangeHook, type CollectionConfig, type Field, type FieldAccess, type FieldHook } from 'payload'

import { normalizeKitCode, normalizeLotNumber } from './codes.js'
import { errName, EVENT_WRITE, EVENT_WRITE_KEY, idOf, isAdmin, isMaintainer, isStaff, isWhere, personOf } from './internal.js'
import { hasShipping } from './carrier.js'
import { applyRecall } from './recall.js'
import { cancelUnneededReturnLabels, SKIP_LABEL_CANCEL } from './returns.js'
import { KIT_EVENT_LABELS, KIT_EVENT_TYPES, KIT_STATUS_LABELS, KIT_STATUSES } from './status.js'
import type { AddressProblem, ResolvedOptions } from './types.js'
import { US_STATES } from './usStates.js'

/**
 * The plugin's ten collections, with the same slugs and field names as the first site that used it.
 * Kit status changes only through kit events, so the custody trail is complete; the admin edits
 * descriptive fields. Site-only fields (subjects, ID numbers, admin components) come in by option.
 */

const GROUP = 'Kits'
const never = () => false
const readOnlyField = { create: never, update: never }

/** "ar" from a script or the API is AR: the state list is upper case. */
const upperState = ({ value }: { value?: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() || null : value)

const PROBLEM_WORDS: Record<AddressProblem, string> = {
  placeholder: 'it’s a placeholder',
  name: 'add the recipient’s name',
  street: 'add the street address',
  poBox: 'add the PO Box number (digits)',
  city: 'add the city',
  state: 'add the two-letter state',
  zip: 'add the ZIP code (12345 or 12345-6789)',
  gdZip: 'General Delivery needs the post office’s ZIP+4 ending in -9999',
}
const addressProblemText = (problems: AddressProblem[]) => `This address isn’t complete: ${problems.map((p) => PROBLEM_WORDS[p] ?? p).join('; ')}.`
const PLACEHOLDER_NOTE = 'Placeholder until the real facts are in. Untick when they are real.'

const placeholder: Field = { name: 'placeholder', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar', description: PLACEHOLDER_NOTE } }
const stateField: Field = { name: 'state', type: 'select', options: [...US_STATES], hooks: { beforeValidate: [upperState] } }

export const addressFields = (name: string, label: string): Field => ({
  name,
  label,
  type: 'group',
  fields: [
    { name: 'name', type: 'text', admin: { description: 'Who or what the address is for, as on a label.' } },
    { name: 'line1', label: 'Address line 1', type: 'text' },
    { name: 'line2', label: 'Address line 2', type: 'text' },
    { type: 'row', fields: [{ name: 'city', type: 'text' }, stateField, { name: 'postalCode', label: 'ZIP code', type: 'text' }] },
    { name: 'phone', type: 'text' },
  ],
})

/** A hub's mailing address: street, PO Box or USPS General Delivery. Labels use it as written. */
const hubAddressField: Field = {
  name: 'address',
  label: 'Mailing address',
  type: 'group',
  admin: { description: 'Return labels send kits here; if kit orders ship from here, it’s the sender too. PO Box and General Delivery take USPS only.' },
  fields: [
    {
      name: 'kind',
      type: 'select',
      defaultValue: 'street',
      options: [
        { label: 'Street address (or a mail store box)', value: 'street' },
        { label: 'USPS PO Box', value: 'po-box' },
        { label: 'USPS General Delivery', value: 'general-delivery' },
      ],
      admin: { description: 'General Delivery holds mail about 30 days: pick returns up promptly.' },
    },
    { name: 'name', label: 'Recipient', type: 'text', admin: { description: 'The person’s name as on their ID. Required for a PO Box and General Delivery.' } },
    { name: 'company', label: 'In care of (C/O)', type: 'text', admin: { description: 'e.g. the organization. Printed as “C/O …”.' } },
    { name: 'line1', label: 'Street address', type: 'text', admin: { condition: (_, s) => (s?.kind ?? 'street') === 'street' } },
    { name: 'line2', label: 'Address line 2', type: 'text', admin: { condition: (_, s) => (s?.kind ?? 'street') === 'street' } },
    { name: 'poBox', label: 'PO Box number', type: 'text', admin: { condition: (_, s) => s?.kind === 'po-box' } },
    { type: 'row', fields: [{ name: 'city', type: 'text' }, stateField, { name: 'postalCode', label: 'ZIP code', type: 'text', admin: { description: 'General Delivery: the office’s ZIP+4 ending in -9999.' } }] },
    { name: 'phone', type: 'text' },
  ],
}

// ---------------------------------------------------------------- access

const staffAccess = (o: ResolvedOptions): Access => ({ req }) => isStaff(o, req)
const adminAccess = (o: ResolvedOptions): Access => ({ req }) => isAdmin(o, req)
const maintainerAccess = (o: ResolvedOptions): Access => ({ req }) => isMaintainer(o, req)

/**
 * With a `scope`, the plugin's own access also keeps each site to its rows: whoever passes sees only rows of
 * the request's site, whether or not the site's multi-tenant plugin filters too. No site, nothing.
 */
const siteWhere = async (o: ResolvedOptions, req: Parameters<Access>[0]['req']): Promise<Where | true | false> => {
  if (!o.scope) return true
  let site: unknown
  try {
    site = await o.scope.of(req)
  } catch {
    return false
  }
  return site === null || site === undefined || site === '' ? false : { [o.scope.field]: { equals: String(site) } }
}
const onSite = (o: ResolvedOptions, check: Access): Access => async (args) => {
  const ok = await check(args)
  if (ok !== true && !isWhere(ok)) return false
  const site = await siteWhere(o, args.req)
  if (site === false) return false
  if (site === true) return ok
  return ok === true ? site : { and: [site, ok] }
}
const staffRead = (o: ResolvedOptions) => onSite(o, staffAccess(o))
const staffWrite = staffRead
const adminWrite = (o: ResolvedOptions) => onSite(o, adminAccess(o))

/** Kit staff, or a signed-in person through the site's buyer rule (a query), on the request's site. Anyone else, nothing. */
const kitRead = (o: ResolvedOptions): Access =>
  onSite(o, async ({ req }) => {
    if (await isStaff(o, req)) return true
    const user = personOf(o, req)
    if (!user || typeof o.access.buyerOf !== 'function') return false
    try {
      const where = await o.access.buyerOf({ req, user })
      return isWhere(where) ? where : false
    } catch {
      return false
    }
  })

/**
 * Field read access on a kit, so a gift's buyer and its keeper never see each other through the REST or GraphQL API
 * (security read of fee0a58, 2026-11-10):
 * - `buyer`: who bought it, the order and what it was bought for are for the buyer and kit staff;
 * - `keeper`: who activated it, when, when it was sampled and what it was sampled from are for the keeper and kit staff;
 * - `staff`: staff notes are for kit staff only.
 * The ids are read from the document before anything is awaited, so the order Payload checks fields in can't matter.
 * A field the reader can't see is removed before relationships are filled in, so `activatedBy` at any depth never
 * gives a buyer the keeper's user record. With no document (a query on the field), only staff pass: nobody else can
 * probe a field they can't read.
 */
export type KitParty = 'buyer' | 'keeper' | 'staff'
export const kitFieldRead = (o: ResolvedOptions, party: KitParty): FieldAccess => async ({ req, doc }) => {
  const d = doc as { buyer?: unknown; activatedBy?: unknown } | undefined
  const owner = party === 'buyer' ? idOf(d?.buyer) : party === 'keeper' ? idOf(d?.activatedBy) : null
  if (await isStaff(o, req)) return true
  if (party === 'staff' || !owner) return false
  const user = personOf(o, req)
  return Boolean(user) && owner === String(user!.id)
}

/** Both must pass: the plugin's rule and the field's own (a subject provider's, say). Only exactly `true` counts. */
const bothRead = (ours: FieldAccess, theirs: FieldAccess | undefined): FieldAccess =>
  !theirs
    ? ours
    : async (args) => {
        if ((await ours(args)) !== true) return false
        try {
          return (await theirs(args)) === true
        } catch {
          return false
        }
      }

type GuardableField = Field & { name?: string; fields?: Field[]; tabs?: { name?: string; fields?: Field[] }[]; access?: Record<string, FieldAccess | undefined> }

/** Copies of `fields` with `read` narrowed by `partyOf(name)` on every named field, looking through unnamed rows, collapsibles and tabs. */
export function guardRead(o: ResolvedOptions, fields: readonly Field[], partyOf: (name: string) => KitParty): Field[] {
  return (fields as GuardableField[]).map((f) => {
    if (f.type === 'tabs' && f.tabs) {
      const tabs = f.tabs as { name?: string; fields?: Field[] }[]
      return { ...f, tabs: tabs.map((t) => (t.name ? withRead(o, t as GuardableField, partyOf(t.name)) : { ...t, fields: guardRead(o, t.fields ?? [], partyOf) })) } as unknown as Field
    }
    if (!f.name && f.fields) return { ...f, fields: guardRead(o, f.fields, partyOf) } as Field
    if (!f.name) return f
    return withRead(o, f, partyOf(f.name)) as Field
  })
}
const withRead = (o: ResolvedOptions, f: GuardableField, party: KitParty) => ({ ...f, access: { ...(f.access ?? {}), read: bothRead(kitFieldRead(o, party), f.access?.read) } })

// ---------------------------------------------------------------- the plugin's rules

/** Stamps a new record with the request's site, when there's a scope and the record has none. */
const stampSite = (o: ResolvedOptions): CollectionBeforeChangeHook => async ({ data, operation, req }) => {
  if (!o.scope || operation !== 'create' || (data?.[o.scope.field] ?? null) !== null) return data
  const site = await o.scope.of(req)
  if (site !== null && site !== undefined && site !== '') data[o.scope.field] = site
  return data
}

/** A kit's code is normalized when it's created and can't change after. */
const kitCodeRule: FieldHook = ({ value, previousValue, operation }) => {
  if (operation === 'create') {
    const code = normalizeKitCode(value as string)
    if (!code) throw new APIError('A kit code is the 8 to 20 digits under the tube’s barcode.', 400, null, true)
    return code
  }
  if (value !== undefined && value !== previousValue) throw new APIError('A kit’s code can’t change.', 400, null, true)
  return value
}

/** A kit's status moves only through its events (`recordKitEvent`), so every change is in the trail. */
const kitStatusRule: FieldHook = ({ value, previousValue, operation, context }) => {
  if ((context as Record<string, unknown> | undefined)?.[EVENT_WRITE_KEY] === EVENT_WRITE) return value
  const before = operation === 'create' ? 'in-stock' : previousValue
  if (value !== undefined && value !== null && value !== before) throw new APIError('A kit’s status changes only through its events.', 400, null, true)
  return value
}

/** A lot number is digits, and can't change once set: it's the start of every kit code in the lot. */
const lotNumberRule: FieldHook = ({ value, previousValue }) => {
  const lot = normalizeLotNumber((value ?? previousValue) as string)
  if (!lot) throw new APIError('A lot number is 3 to 12 digits: the start of every kit code in the lot.', 400, null, true)
  if (previousValue && previousValue !== lot) throw new APIError('A lot number can’t change once kits use it.', 400, null, true)
  return lot
}

/**
 * A recall stays (fail closed): only a maintainer can lift one made by mistake, and the kits it set
 * aside stay recalled either way.
 */
const recallLiftRule = (o: ResolvedOptions): FieldHook => async ({ value, previousValue, req }) => {
  if (previousValue === true && value === false && !(await isMaintainer(o, req))) throw new APIError('A recall can’t be lifted here. Ask a maintainer if it was a mistake.', 403, null, true)
  return value
}

/** The custody trail is never edited. */
const noEdits: CollectionBeforeChangeHook = ({ operation }) => {
  if (operation === 'update') throw new APIError('Kit events are never edited.', 403, null, true)
}

/**
 * A kit marked as coming back in person: the order's return labels it no longer needs are refunded in the
 * same save, while USPS still allows it. A carrier problem is recorded on the label and never blocks the save.
 */
const inPersonReturn = (o: ResolvedOptions): CollectionAfterChangeHook => async ({ doc, previousDoc, req, operation, context }) => {
  const now = typeof doc.returnInPerson === 'string' && doc.returnInPerson.trim()
  const before = typeof previousDoc?.returnInPerson === 'string' && previousDoc.returnInPerson.trim()
  if (operation !== 'update' || context?.[SKIP_LABEL_CANCEL] || !now || before || !doc.order || !hasShipping(o)) return doc
  try {
    await cancelUnneededReturnLabels(req, idOf(doc.order)!)
  } catch (error) {
    req.payload.logger.error({ err: errName(error), kit: String(doc.id) }, 'Sample Kits: return labels not canceled for an in-person return')
  }
  return doc
}

// ---------------------------------------------------------------- collections

export function kitCollections(o: ResolvedOptions): CollectionConfig[] {
  const { users, orders, files } = o.collections
  const site = o.scope?.field
  const unique = (field: string) => [{ fields: site ? [site, field] : [field], unique: true }]
  const stamp = stampSite(o)
  const buyerRead = kitFieldRead(o, 'buyer')
  const keeperRead = kitFieldRead(o, 'keeper')
  const staffOnlyRead = kitFieldRead(o, 'staff')
  const buyerFields = new Set(o.subjects.buyerFields ?? [])

  const KitLots: CollectionConfig = {
    slug: 'kit-lots',
    labels: { singular: 'Kit lot', plural: 'Kit lots' },
    admin: {
      group: GROUP,
      useAsTitle: 'lotNumber',
      defaultColumns: ['lotNumber', 'manufacturer', 'model', 'expiresOn', 'quantity', 'recalled'],
      description: 'A lot of preprinted kits. The lot number is the start of every kit code in it.',
    },
    access: { read: staffRead(o), create: staffAccess(o), update: staffWrite(o), delete: adminWrite(o) },
    hooks: {
      beforeChange: [
        stamp,
        ({ data, originalDoc }) => {
          if (data.recalled && !originalDoc?.recalled) data.recalledAt = new Date().toISOString()
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, req }) => {
          // Ticking "recalled" sets the lot's kits aside in the same transaction.
          if (doc.recalled && !previousDoc?.recalled) await applyRecall(req, doc as never)
          return doc
        },
      ],
    },
    fields: [
      { name: 'lotNumber', type: 'text', required: true, index: true, hooks: { beforeChange: [lotNumberRule] }, admin: { description: 'Digits only, e.g. 275864. Kit codes in this lot start with it. Can’t change.' } },
      { type: 'row', fields: [{ name: 'manufacturer', type: 'text' }, { name: 'model', type: 'text', admin: { description: 'The manufacturer’s product number.' } }] },
      { type: 'row', fields: [
        { name: 'expiresOn', type: 'date', admin: { date: { pickerAppearance: 'dayOnly' }, description: 'Kits past this date can’t be packed or activated.' } },
        { name: 'receivedOn', type: 'date', admin: { date: { pickerAppearance: 'dayOnly' } } },
      ] },
      { name: 'quantity', type: 'number', min: 0, admin: { description: 'How many kits the lot came with (for checking the count).' } },
      { name: 'serialDigits', type: 'number', defaultValue: 6, min: 1, max: 12, admin: { description: 'Digits after the lot number in each kit code.' } },
      {
        name: 'recalled',
        type: 'checkbox',
        defaultValue: false,
        hooks: { beforeChange: [recallLiftRule(o)] },
        admin: {
          position: 'sidebar',
          description: 'Stops packing, shipping and activation for every kit in the lot. Saving sets kits aside and takes packed kits out of their orders. Only a maintainer can undo it.',
        },
      },
      { name: 'recallReason', type: 'textarea', admin: { position: 'sidebar', condition: (d) => Boolean(d?.recalled) } },
      { name: 'recalledAt', type: 'date', admin: { position: 'sidebar', readOnly: true, condition: (d) => Boolean(d?.recalled) } },
      { name: 'notes', type: 'textarea' },
      { name: 'kits', type: 'join', collection: 'kits', on: 'lot', admin: { defaultColumns: ['code', 'status', 'buyer'] } },
    ],
    indexes: unique('lotNumber'),
    timestamps: true,
  }

  const Kits: CollectionConfig = {
    slug: 'kits',
    labels: { singular: 'Kit', plural: 'Kits' },
    admin: {
      group: GROUP,
      useAsTitle: 'code',
      defaultColumns: ['code', 'status', 'lot', 'buyer', 'updatedAt'],
      listSearchableFields: ['code', 'identifierLabel'],
      description: 'One sample kit, by the code printed on its tube. Status follows the kit’s events.',
    },
    access: { read: kitRead(o), create: staffAccess(o), update: staffWrite(o), delete: adminWrite(o) },
    hooks: { beforeChange: [stamp], afterChange: [inPersonReturn(o)] },
    fields: [
      { name: 'code', type: 'text', required: true, index: true, hooks: { beforeChange: [kitCodeRule] }, admin: { description: 'The number under the tube’s barcode. Can’t change.' } },
      { name: 'lot', type: 'relationship', relationTo: 'kit-lots', required: true, index: true },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'in-stock',
        index: true,
        options: KIT_STATUSES.map((value) => ({ value, label: KIT_STATUS_LABELS[value] })),
        // Moved only by kit events, so every change is in the custody trail.
        access: readOnlyField,
        hooks: { beforeChange: [kitStatusRule] },
        admin: { position: 'sidebar', readOnly: true },
      },
      { name: 'test', type: 'select', defaultValue: o.tests[0]!.value, options: o.tests.map((t) => ({ label: t.label, value: t.value })), admin: { position: 'sidebar' } },
      {
        type: 'collapsible',
        label: 'Order',
        fields: [
          { name: 'buyer', type: 'relationship', relationTo: users, index: true, access: { read: buyerRead } },
          { name: 'order', type: 'relationship', relationTo: orders, index: true, access: { read: buyerRead } },
          { name: 'orderLine', type: 'number', access: { read: buyerRead }, admin: { description: 'Which line of the order (from 0).' } },
          { name: 'identifierLabel', type: 'text', access: { read: buyerRead }, admin: { description: 'Text printed on the outer label, e.g. the subject’s name.' } },
        ],
      },
      // What it was bought for is the buyer's (`subjects.buyerFields`); what it was sampled from is the keeper's.
      { type: 'collapsible', label: 'Subject', fields: guardRead(o, o.subjects.fields, (name) => (buyerFields.has(name) ? 'buyer' : 'keeper')) },
      {
        type: 'collapsible',
        label: 'Activation',
        fields: [
          { name: 'activatedBy', type: 'relationship', relationTo: users, index: true, access: { read: keeperRead } },
          { name: 'activatedAt', type: 'date', access: { read: keeperRead } },
          { name: 'sampledAt', type: 'date', access: { read: keeperRead } },
          // Never readable: the secret is shown once, when it's issued.
          { name: 'secretHash', type: 'text', hidden: true, access: { read: never, create: never, update: never }, admin: { hidden: true } },
          { name: 'secretIssuedAt', type: 'date', access: { ...readOnlyField, read: buyerRead }, admin: { readOnly: true, description: 'When the current secret was issued. A new one cancels the old.' } },
        ],
      },
      { name: 'hub', type: 'relationship', relationTo: 'hubs', admin: { position: 'sidebar', description: 'Collection point it returns to.' } },
      { name: 'labBatch', type: 'relationship', relationTo: 'lab-batches', index: true, access: readOnlyField, admin: { position: 'sidebar', readOnly: true } },
      { name: 'attempt', type: 'number', defaultValue: 1, min: 1, access: readOnlyField, admin: { position: 'sidebar', readOnly: true, description: 'Which try this is for the same subject: 2 after a failed sample.' } },
      { name: 'replacementOf', type: 'relationship', relationTo: 'kits', access: readOnlyField, admin: { position: 'sidebar', readOnly: true } },
      { name: 'returnInPerson', label: 'Returned in person at', type: 'text', maxLength: 200, admin: { position: 'sidebar', description: 'The event or hub where the keeper hands this kit in. Set, it gets no return label.' } },
      { name: 'notes', type: 'textarea', access: { read: staffOnlyRead }, admin: { description: 'For kit staff only.' } },
      { name: 'events', type: 'join', collection: 'kit-events', on: 'kit', defaultSort: '-at', admin: { defaultColumns: ['type', 'at', 'actor', 'source'] } },
    ],
    indexes: unique('code'),
    timestamps: true,
  }

  const KitEvents: CollectionConfig = {
    slug: 'kit-events',
    labels: { singular: 'Kit event', plural: 'Kit events' },
    admin: { group: GROUP, defaultColumns: ['kit', 'type', 'at', 'actor', 'source'], description: 'The custody trail: one row per thing that happened to a kit. Never edited.' },
    // Written only by recordKitEvent; never changed afterwards.
    access: { read: staffRead(o), create: never, update: never, delete: maintainerAccess(o) },
    hooks: { beforeChange: [noEdits, stamp] },
    fields: [
      { name: 'kit', type: 'relationship', relationTo: 'kits', required: true, index: true },
      { name: 'type', type: 'select', required: true, index: true, options: KIT_EVENT_TYPES.map((value) => ({ value, label: KIT_EVENT_LABELS[value] })) },
      { name: 'at', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'actor', type: 'relationship', relationTo: users },
      {
        name: 'source',
        type: 'select',
        defaultValue: 'admin',
        options: [
          { label: 'Scan', value: 'scan' },
          { label: 'Staff screen', value: 'admin' },
          { label: 'Customer', value: 'customer' },
          { label: 'Lab portal', value: 'portal' },
          { label: 'Carrier', value: 'carrier' },
          { label: 'System', value: 'system' },
        ],
      },
      { name: 'order', type: 'relationship', relationTo: orders },
      { name: 'hub', type: 'relationship', relationTo: 'hubs' },
      { name: 'lab', type: 'relationship', relationTo: 'labs' },
      { name: 'labBatch', type: 'relationship', relationTo: 'lab-batches' },
      { name: 'file', type: 'relationship', relationTo: files, admin: { description: 'The result file this event is about.' } },
      { name: 'note', type: 'text' },
      { name: 'details', type: 'json' },
    ],
    timestamps: true,
  }

  const BoxTypes: CollectionConfig = {
    slug: 'box-types',
    labels: { singular: 'Box type', plural: 'Box types' },
    admin: { group: GROUP, useAsTitle: 'name', defaultColumns: ['name', 'kitsPerBox', 'insideLength', 'insideWidth', 'insideHeight', 'active', 'placeholder'], description: 'Boxes kits ship in. The packing plan uses how many kits fit each one.' },
    access: { read: staffRead(o), create: adminAccess(o), update: adminWrite(o), delete: adminWrite(o) },
    hooks: { beforeChange: [stamp] },
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'kitsPerBox', type: 'number', required: true, min: 1, admin: { description: 'How many kits fit.' } },
      { type: 'row', fields: [
        { name: 'insideLength', label: 'Inside length (in)', type: 'number', min: 0 },
        { name: 'insideWidth', label: 'Inside width (in)', type: 'number', min: 0 },
        { name: 'insideHeight', label: 'Inside height (in)', type: 'number', min: 0 },
      ] },
      { type: 'row', fields: [
        // Carriers rate on the outside size, which corrugated walls make larger than the inside.
        { name: 'outsideLength', label: 'Outside length (in)', type: 'number', min: 0 },
        { name: 'outsideWidth', label: 'Outside width (in)', type: 'number', min: 0 },
        { name: 'outsideHeight', label: 'Outside height (in)', type: 'number', min: 0 },
      ] },
      { type: 'row', fields: [
        { name: 'emptyWeightOz', label: 'Empty weight (oz)', type: 'number', min: 0 },
        { name: 'maxWeightOz', label: 'Most weight (oz)', type: 'number', min: 0 },
      ] },
      { name: 'carrierPackage', type: 'text', admin: { description: 'Carrier package type, if any.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      placeholder,
    ],
    timestamps: true,
  }

  const Hubs: CollectionConfig = {
    slug: 'hubs',
    labels: { singular: 'Hub', plural: 'Hubs' },
    admin: { group: GROUP, useAsTitle: 'name', defaultColumns: ['name', 'active', 'defaultReturn', 'placeholder'], listSearchableFields: ['name'], description: 'Collection points: customers send kits back here, and hub operators batch them for a lab.' },
    access: { read: staffRead(o), create: adminAccess(o), update: adminWrite(o), delete: adminWrite(o) },
    hooks: {
      beforeChange: [
        stamp,
        async ({ data, originalDoc }) => {
          // A PO Box or General Delivery address must be complete when saved; a street address may be
          // filled in over time (labels refuse it until it is). Checked when Shipping is wired.
          const check = o.adapters?.shipping?.addressProblems
          if (!check) return data
          const address = { ...(originalDoc?.address ?? {}), ...(data.address ?? {}) }
          if ((address.kind ?? 'street') !== 'street') {
            const problems = (await check(address)).filter((p) => p !== 'street')
            if (problems.length) throw new APIError(addressProblemText(problems), 400, null, true)
          }
          return data
        },
      ],
    },
    fields: [
      { name: 'name', type: 'text', required: true },
      hubAddressField,
      { name: 'operators', type: 'relationship', relationTo: users, hasMany: true, admin: { description: 'Hub operators who work here.' } },
      { name: 'defaultReturn', label: 'Kits return here by default', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar' } },
      { name: 'shipsOrders', label: 'Kit orders ship from here', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar', description: 'Its address is the sender on outbound labels.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      placeholder,
    ],
    timestamps: true,
  }

  const Labs: CollectionConfig = {
    slug: 'labs',
    labels: { singular: 'Lab', plural: 'Labs' },
    admin: { group: GROUP, useAsTitle: 'name', defaultColumns: ['name', 'active', 'placeholder'], listSearchableFields: ['name'], description: 'Sequencing labs. Never shown to customers.' },
    access: { read: staffRead(o), create: adminAccess(o), update: adminWrite(o), delete: adminWrite(o) },
    hooks: { beforeChange: [stamp] },
    fields: [
      { name: 'name', type: 'text', required: true },
      addressFields('shippingAddress', 'Shipping address'),
      {
        name: 'contacts',
        type: 'array',
        admin: { description: 'Who gets the automatic notices (tracking number and kit list) when a batch ships.' },
        fields: [
          { type: 'row', fields: [{ name: 'name', type: 'text' }, { name: 'email', type: 'email', required: true }] },
          { name: 'notices', type: 'checkbox', defaultValue: true, label: 'Send batch notices' },
        ],
      },
      { name: 'batchSizes', type: 'number', hasMany: true, defaultValue: [24, 48, 96], admin: { description: 'Batch sizes the lab accepts. Others are allowed with a warning.' } },
      { name: 'fileNaming', type: 'textarea', admin: { description: 'How the lab names result files, e.g. 275864000115.fasta or 275864000115_R1.ab1.' } },
      { name: 'portalUsers', type: 'relationship', relationTo: users, hasMany: true, admin: { description: 'Lab partners who use the lab portal.' } },
      { name: 'active', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      placeholder,
    ],
    timestamps: true,
  }

  const LabBatches: CollectionConfig = {
    slug: 'lab-batches',
    labels: { singular: 'Lab batch', plural: 'Lab batches' },
    admin: { group: GROUP, useAsTitle: 'title', defaultColumns: ['title', 'lab', 'status', 'size', 'shippedAt'], listSearchableFields: ['title'], description: 'Returned kits bundled for a lab.' },
    access: { read: staffRead(o), create: never, update: staffWrite(o), delete: adminWrite(o) },
    hooks: { beforeChange: [stamp] },
    fields: [
      { name: 'title', type: 'text', access: readOnlyField, admin: { readOnly: true } },
      { type: 'row', fields: [
        { name: 'number', type: 'number', required: true, access: readOnlyField, admin: { readOnly: true, description: 'Counts up per site.' } },
        { name: 'size', label: 'Target size', type: 'number', required: true, min: 1, max: 500, admin: { description: 'Kits it should hold (labs usually take 24, 48 or 96).' } },
      ] },
      { name: 'lab', type: 'relationship', relationTo: 'labs', required: true, access: { update: never } },
      { name: 'hub', type: 'relationship', relationTo: 'hubs', access: { update: never } },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'assembling',
        index: true,
        options: LAB_BATCH_STATUSES.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
        access: readOnlyField,
        admin: { position: 'sidebar', readOnly: true },
      },
      { name: 'shippedAt', type: 'date', access: readOnlyField, admin: { position: 'sidebar', readOnly: true } },
      { name: 'receivedAt', type: 'date', access: readOnlyField, admin: { position: 'sidebar', readOnly: true } },
      { name: 'trackingNumbers', type: 'text', hasMany: true, access: readOnlyField, admin: { readOnly: true } },
      { name: 'plan', type: 'json', access: readOnlyField, admin: { readOnly: true, description: 'The boxes suggested when it shipped.' } },
      {
        name: 'notice',
        label: 'Notice to the lab',
        type: 'group',
        access: readOnlyField,
        admin: { description: 'What the lab is told when the batch ships: tracking number and kit list.' },
        fields: [
          { name: 'delivery', type: 'select', options: ['sent', 'not-sent-side-effects-off', 'not-sent-test-addresses', 'no-contacts', 'failed'].map((value) => ({ value, label: value.replace(/-/g, ' ') })), admin: { readOnly: true } },
          { name: 'to', type: 'text', hasMany: true, admin: { readOnly: true } },
          { name: 'subject', type: 'text', admin: { readOnly: true } },
          { name: 'text', type: 'textarea', admin: { readOnly: true, rows: 16 } },
          { name: 'csv', label: 'Kit list (CSV attachment)', type: 'textarea', admin: { readOnly: true } },
          { name: 'at', type: 'date', admin: { readOnly: true } },
        ],
      },
      { name: 'notes', type: 'textarea' },
      { name: 'kits', type: 'join', collection: 'kits', on: 'labBatch', admin: { defaultColumns: ['code', 'status'] } },
    ],
    indexes: unique('number'),
    timestamps: true,
  }

  const ReturnLabels: CollectionConfig = {
    slug: 'return-labels',
    labels: { singular: 'Return label', plural: 'Return labels' },
    admin: { group: GROUP, useAsTitle: 'tracking', defaultColumns: ['tracking', 'order', 'box', 'kind', 'status', 'costCents', 'createdAt'], description: 'Prepaid return labels: one per outbound box, plus any extra a keeper asked for. Also the record of every outbound label bought, written before the carrier is asked. Never edited.' },
    access: { read: staffRead(o), create: never, update: never, delete: adminWrite(o) },
    hooks: { beforeChange: [stamp] },
    fields: [
      { name: 'order', type: 'relationship', relationTo: orders, required: true, index: true },
      { type: 'row', fields: [
        { name: 'box', type: 'number', min: 1, admin: { description: 'Which outbound box (from 1).' } },
        { name: 'kind', type: 'select', defaultValue: 'box', options: [{ label: 'One per box', value: 'box' }, { label: 'Extra, asked for by the keeper', value: 'extra' }, { label: 'Outbound (the record of its purchase)', value: 'outbound' }] },
        {
          name: 'status',
          type: 'select',
          defaultValue: 'active',
          index: true,
          options: [
            { label: 'Buying: the carrier hasn’t answered (check before buying again)', value: 'buying' },
            { label: 'Active', value: 'active' },
            { label: 'Replaced', value: 'replaced' },
            { label: 'Canceled (returned in person)', value: 'cancelled' },
            { label: 'Unknown: may have been bought (check the carrier)', value: 'unknown' },
            { label: 'Not bought (checked with the carrier)', value: 'not-bought' },
          ],
        },
      ] },
      { name: 'kits', type: 'relationship', relationTo: 'kits', hasMany: true, admin: { description: 'For an extra label: the kit it was asked for.' } },
      { type: 'row', fields: [{ name: 'tracking', type: 'text' }, { name: 'carrier', type: 'text' }, { name: 'service', type: 'text' }] },
      { type: 'row', fields: [
        { name: 'costCents', type: 'number', admin: { description: 'What the label cost, in cents.' } },
        { name: 'mode', type: 'select', options: ['test', 'production'] },
        { name: 'refund', type: 'text', admin: { description: 'Refund for a replaced or canceled label: submitted, refunded, rejected, refused, too-old or failed.' } },
      ] },
      { name: 'labelUrl', type: 'text' },
      { name: 'shipmentId', type: 'text' },
      { name: 'reference', type: 'text', admin: { description: 'What the purchase was called at the carrier, to look it up.' } },
      // The claim on an order's box (or a kit, for an extra) while a purchase is buying or unknown. Unique where set.
      { name: 'slotKey', type: 'text', access: { read: never, create: never, update: never }, admin: { hidden: true } },
      { name: 'hub', type: 'relationship', relationTo: 'hubs' },
      { name: 'addressKey', type: 'text', admin: { description: 'Fingerprint of the hub address on the label.' } },
      { name: 'placeholderWeight', type: 'checkbox', admin: { description: 'Made with the placeholder return weight.' } },
    ],
    timestamps: true,
  }

  const KitRefunds: CollectionConfig = {
    slug: 'kit-refunds',
    labels: { singular: 'Kit refund', plural: 'Kit refunds' },
    admin: {
      group: GROUP,
      useAsTitle: 'key',
      defaultColumns: ['order', 'kind', 'amountCents', 'status', 'refundId', 'createdAt'],
      description: 'Every refund asked of the payment service for a kit order, written before it’s asked and kept whatever happens after. Never edited.',
    },
    // Written only by the plugin, straight to the database, so a rollback can't lose a refund that went through.
    access: { read: adminWrite(o), create: never, update: never, delete: never },
    hooks: { beforeChange: [stamp] },
    fields: [
      { name: 'order', type: 'relationship', relationTo: orders, required: true, index: true },
      { type: 'row', fields: [
        { name: 'kind', type: 'select', options: [{ label: 'Order canceled', value: 'order' }, { label: 'Request decided by staff', value: 'review' }, { label: 'Shipping (goodwill)', value: 'shipping' }] },
        { name: 'amountCents', type: 'number', admin: { description: 'In cents.' } },
        {
          name: 'status',
          type: 'select',
          index: true,
          options: [
            { label: 'Asking: the payment service hasn’t answered (check before refunding again)', value: 'asking' },
            { label: 'Refunded', value: 'refunded' },
            { label: 'Failed: nothing was refunded', value: 'failed' },
            { label: 'Unknown: may have been refunded (counted as refunded until an admin settles it)', value: 'unknown' },
            { label: 'Not asked (nothing left to refund)', value: 'not-asked' },
          ],
        },
      ] },
      { name: 'key', type: 'text', admin: { description: 'The idempotency key given to the payment service.' } },
      { name: 'refundId', type: 'text' },
      { name: 'reason', type: 'text' },
      { name: 'by', type: 'relationship', relationTo: users },
      // The order's claim while the refund is being asked. Unique where set: one refund at a time per order.
      { name: 'claimKey', type: 'text', access: { read: never, create: never, update: never }, admin: { hidden: true } },
    ],
    timestamps: true,
  }

  const KitNotices: CollectionConfig = {
    slug: 'kit-notices',
    labels: { singular: 'Kit notice', plural: 'Kit notices' },
    admin: {
      group: GROUP,
      useAsTitle: 'noticeKey',
      defaultColumns: ['kind', 'audience', 'tracking', 'order', 'status', 'attempts', 'createdAt'],
      description: 'Every shipment notice owed to a buyer, a keeper or kit staff: one per parcel, notice and person, so a repeated carrier update sends nothing new. Failed sends are tried again on the next update or daily run. Never edited.',
    },
    // Written only by the plugin: the row in the action's transaction, its sends straight to the database.
    access: { read: staffRead(o), create: never, update: never, delete: never },
    hooks: { beforeChange: [stamp] },
    fields: [
      // Unique where set (`sampleKits_notice_key`): the parcel's tracking (or the kit), the notice and the person.
      { name: 'noticeKey', type: 'text', required: true, admin: { readOnly: true } },
      { type: 'row', fields: [
        { name: 'kind', type: 'text', admin: { description: '`kit-shipment`, `kit-shipment-staff` or `kit-arrived`.' } },
        { name: 'audience', type: 'select', options: [{ label: 'Buyer', value: 'buyer' }, { label: 'Keeper', value: 'keeper' }, { label: 'Kit staff', value: 'staff' }] },
        {
          name: 'status',
          type: 'select',
          index: true,
          options: [
            { label: 'Pending: not sent yet', value: 'pending' },
            { label: 'Sending', value: 'sending' },
            { label: 'Sent (see delivery)', value: 'sent' },
            { label: 'Failed: tried again on the next update or run', value: 'failed' },
            { label: 'Gave up after five tries: tell them yourself', value: 'gave-up' },
          ],
        },
      ] },
      { name: 'user', type: 'relationship', relationTo: users, admin: { description: 'Who it’s for; empty for kit staff.' } },
      { name: 'order', type: 'relationship', relationTo: orders, index: true },
      { name: 'toBuyer', type: 'checkbox', defaultValue: false, admin: { readOnly: true, description: 'Whether the person told is the order’s own buyer. A keeper’s notice carries the order only then.' } },
      { name: 'tracking', type: 'text', index: true },
      { name: 'kits', type: 'relationship', relationTo: 'kits', hasMany: true },
      { name: 'data', type: 'json', admin: { description: 'What `notify` is given: the event, the leg, kit codes and tracking. Never an address or a result.' } },
      { type: 'row', fields: [
        { name: 'attempts', type: 'number', defaultValue: 0 },
        { name: 'delivery', type: 'text', admin: { description: 'What the site’s `notify` answered.' } },
        { name: 'triedAt', type: 'date' },
        { name: 'sentAt', type: 'date' },
      ] },
    ],
    timestamps: true,
  }

  return [KitLots, Kits, KitEvents, BoxTypes, Hubs, Labs, LabBatches, ReturnLabels, KitRefunds, KitNotices]
}

/** Stored values keep the site's spelling (`cancelled`), so no data changes; labels use US spelling. */
export const LAB_BATCH_STATUSES = ['assembling', 'shipped', 'received', 'complete', 'cancelled'] as const
