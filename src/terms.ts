/**
 * The words buyers agree to and are told, shared by forms, the stored order and notices so they never drift apart.
 * Plain functions: safe in the browser too. English; a site translates through its own words if it needs to.
 */

import { storeDay } from './pricing.js'

import type { ReturnAtEvent } from './types.js'

/** An event's date in its own time zone, in plain English for notices and kits. */
export const eventDay = (e: Pick<ReturnAtEvent, 'starts' | 'timezone'>, fallbackZone = 'UTC') =>
  new Date(e.starts).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: e.timezone || fallbackZone })

/** What goes on each kit handed in at an event (`returnInPerson`): the event and its date. */
export const inPersonText = (e: Pick<ReturnAtEvent, 'name' | 'starts' | 'timezone'>, fallbackZone = 'UTC') => `${e.name}, ${eventDay(e, fallbackZone)}`.slice(0, 200)

/** A date-only value (a promised date) as YYYY-MM-DD, whatever time of day it was stored at. */
export const dateOnly = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

/** The longest a pre-order may promise, in months, unless `policy.preorderMaxMonths` says otherwise. */
export const PREORDER_MAX_MONTHS = 6

/** The date a pre-order promises: the product's ship-by date, never more than `maxMonths` after ordering (YYYY-MM-DD). */
export function promisedByFor(shipBy: string | null | undefined, orderedAt: Date, opts: { timeZone?: string; maxMonths?: number } = {}) {
  const max = new Date(`${storeDay(orderedAt, opts.timeZone)}T12:00:00Z`)
  max.setUTCMonth(max.getUTCMonth() + (opts.maxMonths ?? PREORDER_MAX_MONTHS))
  const by = shipBy ? new Date(shipBy) : null
  return (by && !Number.isNaN(by.getTime()) && by < max ? by : max).toISOString().slice(0, 10)
}

/** A promised date in words, the same everywhere: "March 3, 2027". */
export const formatPromised = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

/**
 * Kits on pre-order: the promised date, the refund window, and the choices if the date is missed. Ticked before
 * paying and kept with the order. `voteChoice` adds moving the pre-order's vote to the choices (a site with votes);
 * `closing` is the site's own last sentence, e.g. where the vote goes.
 */
export const preorderTerms = (promised: string, opts: { refundDays?: number; voteChoice?: boolean; closing?: string } = {}) =>
  [
    `This is a pre-order. We promise to ship by ${promised}. For ${opts.refundDays ?? 30} days after you order you can cancel for a full refund, to the way you paid; after that it's locked in until that date. If we're going to miss it, we'll tell you before it passes. If it passes and your kits haven't shipped, you choose: wait for the new date, ${opts.voteChoice ? "move your pre-order's vote to another species, " : ''}turn the payment into credit, or a full refund.`,
    opts.closing?.trim(),
  ]
    .filter(Boolean)
    .join(' ')

export type DelayKind = 'preorder-changed' | 'preorder-late'

/** The delay notice's subject and text, around the words about this order. */
export const delayEmail = (kind: DelayKind, window: string) =>
  kind === 'preorder-changed'
    ? { subject: 'Your sample kit pre-order: new shipping estimate', text: `The shipping estimate for your pre-ordered sample kits has changed. ${window} Your order stays in place; nothing more is charged.` }
    : { subject: 'Your sample kit pre-order is taking longer', text: `Your pre-ordered sample kits haven’t shipped by the date we expected. We’re sorry for the wait. ${window} Your order stays in place; we’ll email you again when kits ship.` }

/** Prepaid returns and in-person returns: USPS refunds unused labels only within 30 days. */
export const IN_PERSON_POSTAGE =
  'Bringing your kits back in person, at an event or a hub? Tell us within 30 days of ordering and we’ll get the prepaid return postage refunded. After that, USPS won’t refund it.'

/** The reasons and choices on a buyer's order page. Plain lists, safe in the browser; the rules are in `orderHelp.ts`. */
export const REASONS = ['changed-mind', 'wrong-quantity', 'animal-gone', 'duplicate', 'too-slow', 'hardship', 'damaged', 'other'] as const
export type Reason = (typeof REASONS)[number]
/** After the refund window, these cancel at once (the site's list). */
export const FIXED_CASES: readonly Reason[] = ['animal-gone', 'duplicate', 'hardship']
export const MISSED_CHOICES = ['wait', 'reallocate', 'credit', 'refund'] as const
export type MissedChoice = (typeof MISSED_CHOICES)[number]
