import type { Field, FieldAccess } from 'payload'

import { isStaff } from './internal.js'
import type { ResolvedOptions } from './types.js'

/**
 * The fields the plugin adds to the site's `orders` and `products` collections, with the site's names and
 * shapes, so a site that moves to the plugin keeps its data. The admin panels' buttons (`ui` fields) come with
 * the pages, in phase 4.
 */

const never = () => false
const readOnlyField = { create: never, update: never }
const hasKits = (d: { kitLines?: unknown[] } | undefined) => Boolean(d?.kitLines?.length)

/** Order statuses. Stored values keep the site's spelling (`cancelled`); labels use US spelling. */
export const KIT_FULFILLMENT_STATUSES = ['pre-order', 'to-pack', 'packed', 'shipped', 'cancelled'] as const
export type KitFulfillmentStatus = (typeof KIT_FULFILLMENT_STATUSES)[number]

export function orderFields(o: ResolvedOptions): Field[] {
  /**
   * The order's own read and write access stay the site's. On top (security read of fee0a58, 2026-11-10): the kit
   * lines and fulfillment change only through kit staff (the plugin's own writes override access), so a buyer allowed
   * to edit their order can't mark it shipped or change what it's for; and the purchase records (label costs and
   * references, the labels run), the notice bookkeeping and which staff member decided are for kit staff only.
   */
  const staffOnly: FieldAccess = ({ req }) => isStaff(o, req)
  const staffWrite = { update: staffOnly }
  const staffRead = { read: staffOnly }
  const kinds = o.subjects.lineKinds ?? (o.subjects.kinds ?? []).map((k) => ({ label: `For: ${k}`, value: k }))
  const kitLines: Field = {
    name: 'kitLines',
    type: 'array',
    access: staffWrite,
    admin: { description: 'Sample kits in this order and what each is for.', condition: (d) => hasKits(d) },
    fields: [
      {
        type: 'row',
        fields: [
          { name: 'kind', type: 'select', required: true, options: [...kinds, { label: 'Not assigned yet', value: 'count' }] },
          { name: 'quantity', type: 'number', required: true, min: 1 },
          { name: 'test', type: 'select', defaultValue: o.tests[0]!.value, options: o.tests.map((t) => ({ label: t.label, value: t.value })) },
        ],
      },
      ...(o.subjects.lineFields ?? []),
    ],
  }
  const kitFulfillment: Field = {
    name: 'kitFulfillment',
    type: 'group',
    access: staffWrite,
    admin: { condition: (d) => hasKits(d) },
    fields: [
      {
        name: 'status',
        type: 'select',
        defaultValue: 'to-pack',
        index: true,
        options: [
          { label: 'Pre-order (waiting to ship)', value: 'pre-order' },
          { label: 'To pack', value: 'to-pack' },
          { label: 'Packed', value: 'packed' },
          { label: 'Shipped', value: 'shipped' },
          { label: 'Canceled', value: 'cancelled' },
        ],
      },
      {
        // What the buyer ticked before paying, word for word (the pre-order terms).
        name: 'agreed',
        type: 'group',
        access: { update: never },
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.agreed?.text), description: 'What the buyer ticked before paying, word for word.' },
        fields: [
          { name: 'text', type: 'textarea' },
          { name: 'at', type: 'date' },
        ],
      },
      { name: 'slipMadeAt', type: 'date', admin: { readOnly: true, description: 'When the order slip with activation secrets was last made.' } },
      { name: 'trackingNumbers', type: 'text', hasMany: true },
      { name: 'shippedAt', type: 'date' },
      { name: 'plan', type: 'json', admin: { readOnly: true, description: 'The packing plan used (boxes and kits per box).' } },
      {
        // The event date the buyer chose to hand the kits in at: no return labels for it.
        name: 'returnAt',
        label: 'Kits handed in at (event date id)',
        type: 'text',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.returnAt) },
      },
      {
        // What the buyer chose, as it was: for notices and the missed-date offer, even if the date changes later.
        name: 'returnAtEvent',
        type: 'group',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.returnAt) },
        fields: [
          { name: 'name', type: 'text' },
          { name: 'slug', type: 'text' },
          { name: 'starts', type: 'date' },
          { name: 'timezone', type: 'text' },
          { name: 'place', type: 'text' },
          // Each notice once: a week before, the date canceled, the date missed.
          { name: 'remindedAt', type: 'date' },
          { name: 'canceledToldAt', type: 'date' },
          { name: 'missedToldAt', type: 'date' },
        ],
      },
      {
        name: 'outboundLabels',
        type: 'array',
        access: { ...readOnlyField, ...staffRead },
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.outboundLabels?.length), description: 'Bought when the order could be packed, one per box of the plan above.' },
        fields: [
          { name: 'box', type: 'number' },
          { name: 'boxType', type: 'text' },
          { name: 'kits', type: 'number' },
          { name: 'tracking', type: 'text' },
          { name: 'carrier', type: 'text' },
          { name: 'service', type: 'text' },
          { name: 'costCents', type: 'number' },
          { name: 'labelUrl', type: 'text' },
          { name: 'shipmentId', type: 'text' },
          { name: 'mode', type: 'text' },
          { name: 'weightOz', type: 'number' },
          { name: 'refund', type: 'text', admin: { description: 'The carrier’s refund answer, if the label was canceled.' } },
          { name: 'at', type: 'date' },
          { name: 'unknown', type: 'checkbox', admin: { description: 'The carrier’s answer was unclear: the label may have been bought. Check the carrier for the reference before buying again.' } },
          { name: 'reference', type: 'text' },
        ],
      },
      {
        name: 'labels',
        type: 'group',
        access: { ...readOnlyField, ...staffRead },
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.labels?.state) },
        fields: [
          { name: 'state', type: 'select', options: ['making', 'made', 'failed'].map((v) => ({ label: v, value: v })) },
          { name: 'error', type: 'text' },
          { name: 'at', type: 'date' },
          // The run that holds the order while labels are being bought, so two runs never buy for the same box.
          { name: 'run', type: 'text', admin: { hidden: true } },
        ],
      },
      {
        name: 'shippedEmail',
        type: 'group',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.shippedEmail?.delivery) },
        fields: [
          {
            name: 'delivery',
            type: 'select',
            options: [
              { label: 'Sent', value: 'sent' },
              { label: 'Not sent: email is off here', value: 'not-sent-side-effects-off' },
              { label: 'Not sent: test address', value: 'not-sent-test-addresses' },
              { label: 'Not sent: no email address', value: 'no-address' },
              { label: 'Sending failed', value: 'failed' },
            ],
          },
          { name: 'at', type: 'date' },
        ],
      },
      {
        name: 'replaces',
        type: 'relationship',
        relationTo: 'kits',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.replaces), description: 'A free replacement for this kit.' },
      },
      {
        // Pre-orders: the date promised at checkout, at most `policy.preorderMaxMonths` after ordering.
        name: 'promisedBy',
        label: 'Promised ship-by date',
        type: 'date',
        access: readOnlyField,
        admin: { readOnly: true, date: { pickerAppearance: 'dayOnly' }, condition: (d) => Boolean(d?.kitFulfillment?.promisedBy), description: 'Agreed at checkout. Once it passes unshipped, the buyer may choose a full refund.' },
      },
      {
        name: 'revisedBy',
        label: 'New ship-by date (if late)',
        type: 'date',
        admin: { date: { pickerAppearance: 'dayOnly' }, condition: (d) => Boolean(d?.kitFulfillment?.promisedBy), description: 'Set it when kits won’t make the promised date: the buyer is told at the next notice run. It never takes away their refund once the promised date has passed.' },
      },
      { name: 'delayNoticeFor', type: 'date', access: staffRead, admin: { hidden: true, readOnly: true } },
      { name: 'missedNoticeFor', type: 'date', access: staffRead, admin: { hidden: true, readOnly: true } },
      {
        // The pre-order's vote, kept by the site (`onPreorderVote`); the plugin only stores what the site answers.
        name: 'preorderVote',
        type: 'group',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.preorderVote?.vote) },
        fields: [
          o.preorders?.voteItems ? { name: 'item', type: 'relationship', relationTo: o.preorders.voteItems } : { name: 'item', type: 'text' },
          { name: 'vote', type: 'text' },
          { name: 'contribution', type: 'text' },
        ],
      },
      {
        // Refund requests and help: every request and decision, kept.
        name: 'requests',
        type: 'array',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.requests?.length) },
        fields: [
          { name: 'kind', type: 'select', options: ['refund', 'help', 'missed-date'].map((v) => ({ label: v, value: v })) },
          { name: 'reasons', type: 'text', hasMany: true },
          { name: 'details', type: 'textarea' },
          { name: 'at', type: 'date' },
          { name: 'outcome', type: 'select', options: ['refunded', 'cancelled', 'review', 'declined', 'waiting', 'reallocated', 'credited', 'replaced'].map((v) => ({ label: v, value: v })) },
          { name: 'amountCents', type: 'number' },
          { name: 'deductedCents', type: 'number' },
          { name: 'decidedBy', type: 'relationship', relationTo: o.collections.users, access: staffRead },
          { name: 'decidedAt', type: 'date' },
          { name: 'note', type: 'text' },
        ],
      },
      {
        name: 'orderRefund',
        type: 'group',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.orderRefund?.status) },
        fields: [
          { name: 'status', type: 'select', options: [{ label: 'Refunding', value: 'pending' }, { label: 'Refunded', value: 'refunded' }] },
          { name: 'amountCents', type: 'number' },
          { name: 'deductedCents', type: 'number', admin: { description: 'Shipping that couldn’t be recovered, kept back.' } },
          { name: 'creditsBack', type: 'number' },
          { name: 'refundId', type: 'text' },
          { name: 'at', type: 'date' },
          { name: 'by', type: 'relationship', relationTo: o.collections.users, access: staffRead },
        ],
      },
      {
        // The prepaid-return part of the shipping paid, saved at checkout: what "Refund shipping" offers.
        name: 'returnShippingCents',
        type: 'number',
        min: 0,
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Number(d?.kitFulfillment?.returnShippingCents) > 0, description: 'Return shipping included in what was paid (cents).' },
      },
      {
        name: 'shippingRefund',
        type: 'group',
        access: readOnlyField,
        admin: { readOnly: true, condition: (d) => Boolean(d?.kitFulfillment?.shippingRefund?.status) },
        fields: [
          { name: 'status', type: 'select', options: [{ label: 'Refunding', value: 'pending' }, { label: 'Refunded', value: 'refunded' }] },
          { name: 'amountCents', type: 'number' },
          { name: 'reason', type: 'text' },
          { name: 'by', type: 'relationship', relationTo: o.collections.users, access: staffRead },
          { name: 'at', type: 'date' },
          { name: 'refundId', type: 'text' },
        ],
      },
    ],
  }
  return [kitLines, kitFulfillment]
}

/** The kit product's fields: a kit is sold by quantity, priced by tiers, with flat shipping by order size. */
export function productFields(): Field[] {
  return [
    {
      name: 'kit',
      type: 'group',
      admin: { position: 'sidebar' },
      fields: [
        { name: 'isKit', label: 'This is a sample kit', type: 'checkbox', defaultValue: false, admin: { description: 'Sold on the kit page, not through the cart.' } },
        {
          name: 'tiers',
          type: 'array',
          admin: { condition: (d) => Boolean(d?.kit?.isKit), description: 'Price per kit by order size, in cents. The first tier starts at 1.' },
          fields: [
            { name: 'minQuantity', label: 'From (kits)', type: 'number', required: true, min: 1 },
            { name: 'priceInUSD', label: 'Price per kit (cents)', type: 'number', required: true, min: 1 },
          ],
        },
        {
          name: 'shippingTiers',
          label: 'Shipping by order size',
          type: 'array',
          admin: { condition: (d) => Boolean(d?.kit?.isKit), description: 'One shipping price per order, by how many kits it has, in cents; the first tier starts at 1. Empty: shipping is included in the kit price.' },
          fields: [
            { name: 'minQuantity', label: 'From (kits)', type: 'number', required: true, min: 1 },
            { name: 'shippingCents', label: 'Shipping (cents)', type: 'number', required: true, min: 0, max: 99_999 },
            { name: 'returnCents', label: 'Of which return labels (cents)', type: 'number', min: 0, admin: { description: 'Refunded as goodwill when the kits come back in person.' } },
          ],
        },
        {
          name: 'preorder',
          label: 'Pre-order',
          type: 'checkbox',
          defaultValue: false,
          admin: { condition: (d) => Boolean(d?.kit?.isKit), description: 'Orders wait as pre-orders instead of going to packing. Buyers agree to a promised ship-by date (the date below, or the longest wait allowed if sooner), a full refund for the first days, and their choices if the date is missed. Untick when kits can ship, then release the pre-orders.' },
        },
        {
          name: 'shipWindow',
          label: 'Expected shipping',
          type: 'text',
          validate: (value: unknown, { siblingData }: { siblingData?: { preorder?: boolean } }) =>
            !siblingData?.preorder || (typeof value === 'string' && value.trim().length > 10) ? true : 'Say when pre-orders are expected to ship.',
          admin: { condition: (d) => Boolean(d?.kit?.isKit && d?.kit?.preorder), description: 'e.g. "Expected to ship within 8 to 12 weeks; we’ll email you with any change."' },
        },
        {
          name: 'shipBy',
          label: 'Ship-by date (promised to new pre-orders)',
          type: 'date',
          admin: { condition: (d) => Boolean(d?.kit?.isKit && d?.kit?.preorder), description: 'New pre-orders promise this date, or the longest wait allowed if that’s sooner. Each order keeps the date it was promised.' },
        },
      ],
    },
  ]
}

/** Top-level names the plugin adds, so a clash stops start-up. */
export const ORDER_FIELD_NAMES = ['kitLines', 'kitFulfillment'] as const
export const PRODUCT_FIELD_NAMES = ['kit'] as const
