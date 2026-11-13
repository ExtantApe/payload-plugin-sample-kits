/**
 * Kit statuses and the events that move them. Every scan and every change is
 * a kit event (the custody trail); a kit's status is the result of its latest status-changing event,
 * kept on the kit so lists can filter by it.
 */

export const KIT_STATUSES = [
  'in-stock',
  'packed',
  'shipped',
  'delivered',
  'activated',
  'sampled',
  'returned',
  'at-lab',
  'sequencing',
  'results-in',
  'analysis',
  'released',
  // Side paths.
  'lost',
  'expired',
  'failed',
  'replaced',
  'void',
  'recalled',
] as const
export type KitStatus = (typeof KIT_STATUSES)[number]

export const KIT_STATUS_LABELS: Record<KitStatus, string> = {
  'in-stock': 'In stock',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  activated: 'Activated',
  sampled: 'Sampled',
  returned: 'Back at the hub',
  'at-lab': 'At the lab',
  sequencing: 'Sequencing',
  'results-in': 'Results in',
  analysis: 'Analysis',
  released: 'Released',
  lost: 'Lost',
  expired: 'Expired',
  failed: 'Failed',
  replaced: 'Replaced',
  void: 'Void',
  recalled: 'Recalled',
}

export const KIT_EVENT_TYPES = [
  'received', // into stock
  'scanned', // looked up; changes nothing
  'packed', // scanned into an order
  'unpacked', // taken back out of an order before shipping
  'label-printed',
  'slip-made', // activation secrets issued (an order slip printed)
  'shipped',
  'delivered',
  'activated',
  'sampled',
  'returned',
  'batched', // scanned into a lab batch at the hub; changes nothing
  'unbatched', // taken back out of a lab batch before it ships
  'sent-to-lab', // its batch shipped to the lab; still "back at the hub" until the lab confirms
  'at-lab',
  'sequencing',
  'results-in',
  'result-refused', // a result file for it was refused (the message is the event's note)
  'analysis',
  'released',
  'lost',
  'expired',
  'failed',
  'replaced',
  'void',
  'recalled',
  'note',
] as const
export type KitEventType = (typeof KIT_EVENT_TYPES)[number]

export const KIT_EVENT_LABELS: Record<KitEventType, string> = {
  received: 'Received into stock',
  scanned: 'Scanned',
  packed: 'Packed for an order',
  unpacked: 'Taken out of an order',
  'label-printed': 'Label printed',
  'slip-made': 'Order slip made (new activation secret)',
  shipped: 'Shipped',
  delivered: 'Delivered',
  activated: 'Activated',
  sampled: 'Sampled',
  returned: 'Received at the hub',
  batched: 'Put in a lab batch',
  unbatched: 'Taken out of a lab batch',
  'sent-to-lab': 'Shipped to the lab',
  'at-lab': 'Received by the lab',
  sequencing: 'Sequencing',
  'results-in': 'Result file received',
  'result-refused': 'Result file refused',
  analysis: 'Analysis',
  released: 'Released',
  lost: 'Marked lost',
  expired: 'Marked expired',
  failed: 'Failed',
  replaced: 'Replaced',
  void: 'Voided',
  recalled: 'Recalled',
  note: 'Note',
}

/** The status an event leaves the kit in; events without one (scans, labels, notes) leave it as it was. */
export function statusAfter(type: KitEventType): KitStatus | null {
  if (type === 'received' || type === 'unpacked') return 'in-stock'
  if ((KIT_STATUSES as readonly string[]).includes(type)) return type as KitStatus
  return null
}

/**
 * What the customer sees: a progress tracker in plain steps. The lab is never named: "At the lab"
 * stays generic.
 */
export const PROGRESS_STEPS = ['ordered', 'shipped', 'activated', 'sampled', 'returned', 'lab', 'results'] as const
export type ProgressStep = (typeof PROGRESS_STEPS)[number]

const STEP_OF: Partial<Record<KitStatus, ProgressStep>> = {
  'in-stock': 'ordered',
  packed: 'ordered',
  shipped: 'shipped',
  delivered: 'shipped',
  activated: 'activated',
  sampled: 'sampled',
  returned: 'returned',
  'at-lab': 'lab',
  sequencing: 'lab',
  'results-in': 'lab',
  analysis: 'lab',
  released: 'results',
}

/** How far a kit has come: the index of its current step, and whether it went off the usual path. */
export function progressOf(status: KitStatus): { step: number; problem: KitStatus | null } {
  const step = STEP_OF[status]
  if (step) return { step: PROGRESS_STEPS.indexOf(step), problem: null }
  return { step: -1, problem: status }
}

/** Kits in these states can be scanned into an order. */
export const PACKABLE: readonly KitStatus[] = ['in-stock']
/** Kits in these states can be activated by the person holding the slip. */
export const ACTIVATABLE: readonly KitStatus[] = ['packed', 'shipped', 'delivered']
/** Kits in these states can be checked in at the hub: the keeper activated them (and usually took the sample). */
export const CHECKABLE_IN: readonly KitStatus[] = ['activated', 'sampled']
/** Kits in these states can take a result file from the lab (a re-run keeps "results in"). */
export const RESULTABLE: readonly KitStatus[] = ['returned', 'at-lab', 'sequencing', 'results-in']

export type OrderSummary =
  | { stage: 'pre-order' | 'packing' | 'packed' | 'cancelled' }
  | { stage: 'underway'; steps: { step: ProgressStep; n: number }[]; attention: number; replaced: number }

/**
 * One line for an order on My Tests: before it ships, where the order is; after, how many of its kits are
 * at each step, earliest first, and how many went off the usual path. A replaced kit isn't a worry: its
 * replacement has its own order.
 */
export function orderSummary(fulfillment: string | null | undefined, statuses: KitStatus[]): OrderSummary {
  if (fulfillment === 'cancelled') return { stage: 'cancelled' }
  if (fulfillment === 'pre-order') return { stage: 'pre-order' }
  if (fulfillment !== 'shipped') return { stage: fulfillment === 'packed' ? 'packed' : 'packing' }
  const counts = new Map<ProgressStep, number>()
  let attention = 0
  let replaced = 0
  for (const s of statuses) {
    const { step, problem } = progressOf(s)
    if (problem === 'replaced') replaced++
    else if (problem) attention++
    else counts.set(PROGRESS_STEPS[step]!, (counts.get(PROGRESS_STEPS[step]!) ?? 0) + 1)
  }
  return { stage: 'underway', steps: PROGRESS_STEPS.filter((s) => counts.has(s)).map((step) => ({ step, n: counts.get(step)! })), attention, replaced }
}
