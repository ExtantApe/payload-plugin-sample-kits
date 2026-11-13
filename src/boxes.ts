import type { ParcelSize } from './types.js'

/**
 * Boxes for kits: every kit ships in its own small kit box, and kit boxes go in an outer box. The plan picks
 * the outer boxes for an order, by what the labels cost when they can be priced, else by the snuggest fit.
 * The parcel rules (sizes, weights, what a carrier takes) are Shipping's; this is only about kits.
 */

/** Outside size of one kit box (in). */
export const KIT_BOX = { lengthIn: 6, widthIn: 6, heightIn: 2 } as const
/** What one packed kit box weighs, in ounces, unless `policy.kitWeightOz` says otherwise. A placeholder. */
export const KIT_WEIGHT_OZ = 4.2

export type LadderBox = { kits: number; name: string; outside: [number, number, number]; emptyWeightOz: number; labBatch?: boolean }

/**
 * A ladder of outer boxes, so there's always one just bigger than an order: a starting point for a site's
 * `box-types`, not a default. Empty weights are rough corrugated estimates (placeholders).
 */
export const BOX_LADDER: LadderBox[] = [
  { kits: 1, name: 'Kit box (1)', outside: [6, 6, 2], emptyWeightOz: 0 },
  { kits: 2, name: 'Outer 2', outside: [6.6, 6.6, 4.6], emptyWeightOz: 4 },
  { kits: 4, name: 'Outer 4', outside: [6.6, 6.6, 8.6], emptyWeightOz: 6 },
  { kits: 6, name: 'Outer 6', outside: [6.6, 6.6, 12.6], emptyWeightOz: 8 },
  { kits: 9, name: 'Outer 9', outside: [6.6, 6.6, 18.6], emptyWeightOz: 10 },
  { kits: 12, name: 'Outer 12', outside: [12.6, 6.6, 12.6], emptyWeightOz: 12 },
  { kits: 16, name: 'Outer 16', outside: [12.6, 12.6, 8.6], emptyWeightOz: 14 },
  { kits: 24, name: 'Outer 24 (lab batch)', outside: [12.6, 12.6, 12.6], emptyWeightOz: 18, labBatch: true },
  { kits: 36, name: 'Outer 36', outside: [12.6, 12.6, 18.6], emptyWeightOz: 24 },
  { kits: 48, name: 'Outer 48 (lab batch)', outside: [18.6, 12.6, 16.6], emptyWeightOz: 30, labBatch: true },
  { kits: 96, name: 'Outer 96 (lab batch)', outside: [24.6, 18.6, 16.6], emptyWeightOz: 48, labBatch: true },
]

// ---------------------------------------------------------------- the packing plan, without prices

export type BoxOption = { id: string; name: string; kitsPerBox: number; emptyWeightOz?: number | null; cost?: number | null }
export type PlannedBox = { boxType: string; name: string; kits: number }
export type PackingPlan = { boxes: PlannedBox[]; capacity: number; emptySlots: number }

type Score = [number, number, number, number]
const better = (a: Score, b: Score) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

/**
 * Which boxes hold `kits` kits best: the lowest cost when costs are given, then the fewest empty slots, then
 * the fewest boxes, then the lightest. 13 kits go in a 12 and a 4, not one 48.
 */
export function planBoxes(kits: number, options: BoxOption[]): PackingPlan | null {
  const n = Math.floor(kits)
  const usable = options.filter((o) => Number.isInteger(o.kitsPerBox) && o.kitsPerBox > 0)
  if (n <= 0) return { boxes: [], capacity: 0, emptySlots: 0 }
  if (!usable.length || n > 10_000) return null
  const best: { score: Score; pick: number; prev: number }[] = [{ score: [0, 0, 0, 0], pick: -1, prev: -1 }]
  for (let k = 1; k <= n; k++) {
    let choice: { score: Score; pick: number; prev: number } | null = null
    usable.forEach((o, i) => {
      const prev = Math.max(0, k - o.kitsPerBox)
      const p = best[prev]!.score
      const score: Score = [p[0] + (o.cost ?? 0), p[1] + o.kitsPerBox, p[2] + 1, p[3] + (o.emptyWeightOz ?? 0)]
      if (!choice || better(score, choice.score)) choice = { score, pick: i, prev }
    })
    best.push(choice!)
  }
  const counts = new Map<number, number>()
  for (let k = n; k > 0; k = best[k]!.prev) counts.set(best[k]!.pick, (counts.get(best[k]!.pick) ?? 0) + 1)
  // The biggest boxes first, so the last box is the part-full one.
  const boxes: PlannedBox[] = []
  let left = n
  for (const [i, count] of [...counts].sort((a, b) => usable[b[0]]!.kitsPerBox - usable[a[0]]!.kitsPerBox)) {
    const o = usable[i]!
    for (let c = 0; c < count; c++) {
      const kitsHere = Math.min(o.kitsPerBox, left)
      left -= kitsHere
      boxes.push({ boxType: o.id, name: o.name, kits: kitsHere })
    }
  }
  const capacity = boxes.reduce((s, b) => s + (usable.find((o) => o.id === b.boxType)?.kitsPerBox ?? 0), 0)
  return { boxes, capacity, emptySlots: capacity - n }
}

// ---------------------------------------------------------------- the plan by label cost

export type BoxTypeDoc = { id: string; name: string; kitsPerBox: number; emptyWeightOz?: number | null; outsideLength?: number | null; outsideWidth?: number | null; outsideHeight?: number | null; active?: boolean | null }
export type BoxPrice = { outboundCents: number; returnCents: number }
/** Prices one box of a type holding some kits: Shipping's quotes in real use, a fake in tests. */
export type Pricer = (box: BoxTypeDoc, parcel: ParcelSize, kits: number) => Promise<BoxPrice>
/** A box of a type holding `kits` kits, as a parcel (Shipping's `parcelFor`, with the kits' weight), or null. */
export type ParcelOf = (box: BoxTypeDoc, kits: number) => ParcelSize | null

export type PlannedShipmentBox = { box: number; boxType: string; name: string; kits: number; parcel: ParcelSize | null; outboundCents: number | null; returnCents: number | null }
export type ShipmentPlan = { boxes: PlannedShipmentBox[]; totalCents: number | null; priced: boolean; emptySlots: number }

export const outside = (b: BoxTypeDoc): [number, number, number] | null => (b.outsideLength && b.outsideWidth && b.outsideHeight ? [b.outsideLength, b.outsideWidth, b.outsideHeight] : null)

/** The box types worth pricing: every one that holds fewer (they combine), and the two smallest that hold them all. */
export function candidates(kits: number, types: BoxTypeDoc[]): BoxTypeDoc[] {
  const usable = types.filter((t) => t.active !== false && Number.isInteger(t.kitsPerBox) && t.kitsPerBox > 0)
  const smaller = usable.filter((t) => t.kitsPerBox < kits)
  const bigger = usable.filter((t) => t.kitsPerBox >= kits).sort((a, b) => a.kitsPerBox - b.kitsPerBox).slice(0, 2)
  return [...smaller, ...bigger]
}

/**
 * Plan an order's boxes. Each box needs an outbound label and, while kits go back by post, a return label, so
 * a box costs both. `returns` is how many kits go back by post; return labels are priced on the first boxes.
 * Box types without an outside size (no parcel) can't be priced; if none can, the snuggest fit is used.
 */
export async function planShipment(kits: number, types: BoxTypeDoc[], price: Pricer, parcelOf: ParcelOf, returns = kits): Promise<ShipmentPlan | null> {
  const n = Math.floor(kits)
  if (n <= 0) return { boxes: [], totalCents: 0, priced: true, emptySlots: 0 }
  const pool = candidates(n, types)
  const options: BoxOption[] = []
  const quotes = new Map<string, BoxPrice>()
  for (const t of pool) {
    // Priced full (the heaviest it gets), or holding the whole order when that's fewer.
    const fill = Math.min(t.kitsPerBox, n)
    const parcel = parcelOf(t, fill)
    if (!parcel) continue
    const p = await price(t, parcel, fill)
    quotes.set(t.id, p)
    options.push({ id: t.id, name: t.name, kitsPerBox: t.kitsPerBox, emptyWeightOz: t.emptyWeightOz ?? null, cost: p.outboundCents + (returns > 0 ? p.returnCents : 0) })
  }
  const priced = options.length > 0
  const plan = priced ? planBoxes(n, options) : planBoxes(n, pool.map((t) => ({ id: t.id, name: t.name, kitsPerBox: t.kitsPerBox, emptyWeightOz: t.emptyWeightOz ?? null })))
  if (!plan) return null
  let mailBack = Math.max(0, Math.min(returns, n))
  const boxes: PlannedShipmentBox[] = []
  let total = 0
  for (const [i, b] of plan.boxes.entries()) {
    const t = pool.find((x) => x.id === b.boxType)!
    const parcel = parcelOf(t, b.kits)
    let outboundCents: number | null = null
    let returnCents: number | null = null
    if (priced && parcel) {
      // Each box priced as it will really be packed: a part-full last box weighs less.
      const p = b.kits === Math.min(t.kitsPerBox, n) ? quotes.get(t.id)! : await price(t, parcel, b.kits)
      outboundCents = p.outboundCents
      returnCents = mailBack > 0 ? p.returnCents : 0
      total += outboundCents + returnCents
    }
    mailBack -= b.kits
    boxes.push({ box: i + 1, boxType: b.boxType, name: b.name, kits: b.kits, parcel, outboundCents, returnCents })
  }
  return { boxes, totalCents: priced ? total : null, priced, emptySlots: plan.emptySlots }
}
