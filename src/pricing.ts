/**
 * Kit prices by quantity and flat shipping by kit count. The tiers live on the kit product (`kit.tiers`,
 * `kit.shippingTiers`), so staff change them in the admin. Prices are in cents; the field keeps the site's
 * name, `priceInUSD`. There are no default prices: a site with no valid tiers has no price.
 */

export type Tier = { minQuantity: number; priceInUSD: number }
export type ShippingTier = { minQuantity: number; shippingCents: number; returnCents: number }

/** Most kits in one order; larger orders are arranged with the site directly. */
export const MAX_KITS_PER_ORDER = 500

const whole = (v: unknown): v is number => Number.isInteger(v)

/** Valid tiers, smallest first. Tiers must start at one kit, or none apply. */
export function cleanTiers(tiers: { minQuantity?: number | null; priceInUSD?: number | null }[] | null | undefined): Tier[] {
  const valid = (tiers ?? [])
    .filter((t) => whole(t.minQuantity) && t.minQuantity >= 1 && whole(t.priceInUSD) && t.priceInUSD > 0)
    .map((t) => ({ minQuantity: t.minQuantity as number, priceInUSD: t.priceInUSD as number }))
    .sort((a, b) => a.minQuantity - b.minQuantity)
  return valid.length && valid[0]!.minQuantity === 1 ? valid : []
}

/** The price per kit for an order of `quantity` kits (every kit gets the tier's price), or null without tiers. */
export function unitPrice(quantity: number, tiers: Parameters<typeof cleanTiers>[0]): number | null {
  const t = cleanTiers(tiers)
  if (!t.length || !(quantity >= 1)) return null
  let price = t[0]!.priceInUSD
  for (const tier of t) if (quantity >= tier.minQuantity) price = tier.priceInUSD
  return price
}

/** The next tier up, to tell the buyer how many more kits lower the price. */
export function nextTier(quantity: number, tiers: Parameters<typeof cleanTiers>[0]): Tier | null {
  return cleanTiers(tiers).find((t) => t.minQuantity > quantity) ?? null
}

/** Valid shipping tiers, smallest first; the return part is never more than the whole. */
export function cleanShippingTiers(tiers: { minQuantity?: number | null; shippingCents?: number | null; returnCents?: number | null }[] | null | undefined): ShippingTier[] {
  const valid = (tiers ?? [])
    .filter((t) => whole(t.minQuantity) && t.minQuantity >= 1 && whole(t.shippingCents) && t.shippingCents >= 0 && t.shippingCents < 100_000)
    .map((t) => ({ minQuantity: t.minQuantity as number, shippingCents: t.shippingCents as number, returnCents: Math.min(Math.max(0, whole(t.returnCents) ? t.returnCents : 0), t.shippingCents as number) }))
    .sort((a, b) => a.minQuantity - b.minQuantity)
  return valid.length && valid[0]!.minQuantity === 1 ? valid : []
}

/**
 * Shipping for an order of `quantity` kits, and the part that pays for its prepaid return labels. Without
 * valid tiers, `fallback` (default: shipping included in the kit price, 0).
 */
export function shippingFor(quantity: number, tiers: Parameters<typeof cleanShippingTiers>[0], fallback: { shipping: number; returnPart: number } = { shipping: 0, returnPart: 0 }): { shipping: number; returnPart: number } {
  const t = cleanShippingTiers(tiers)
  if (!t.length) return { shipping: fallback.shipping, returnPart: Math.min(fallback.returnPart, fallback.shipping) }
  let tier = t[0]!
  for (const x of t) if (quantity >= x.minQuantity) tier = x
  return { shipping: tier.shippingCents, returnPart: tier.returnCents }
}

/** The calendar day (YYYY-MM-DD) a moment falls on in the store's time zone (`policy.storeTimeZone`). */
export const storeDay = (at: Date | string, timeZone = 'UTC') => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
