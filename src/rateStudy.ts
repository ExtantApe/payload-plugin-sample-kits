import type { PayloadRequest } from 'payload'

import { type BoxTypeDoc, KIT_WEIGHT_OZ, outside, planShipment, type Pricer, type ShipmentPlan } from './boxes.js'
import { carrierRefusal, hubLabel, returnHub, shipFromHub, shippingOf } from './carrier.js'
import { inTransaction, KitError, optionsOf, READ, requireStaff, scoped, siteOf } from './internal.js'
import type { LabelAddress, ResolvedOptions } from './types.js'

/**
 * The rate study: what kit orders really cost to ship, from Shipping's test-mode quotes, so a site can set flat
 * shipping tiers. For each order size and destination it plans the cheapest boxes (outbound plus one prepaid return
 * per box) and reports the cost per size, the boxes chosen, whether two kits ship cheaper in one box or two, and
 * suggested tiers. Quotes only: nothing is bought. Test mode only: the first quote that comes back in production mode
 * stops the study, and nothing is reported from it. With a fake carrier the report says the prices are made up.
 */

export type Destination = { region: string; address: LabelAddress; remote?: boolean }
export type StudyRow = { kits: number; region: string; remote: boolean; plan: ShipmentPlan }
export type StudyResult = { rows: StudyRow[]; quotes: number; fake: boolean }

/** Sample destinations: one public ZIP per region, a made-up street (quotes don't verify it). */
export const STUDY_DESTINATIONS: Destination[] = [
  ['Northeast', 'New York', 'NY', '10001'],
  ['Southeast', 'Miami', 'FL', '33130'],
  ['Midwest', 'Chicago', 'IL', '60601'],
  ['South Central', 'Dallas', 'TX', '75201'],
  ['Mountain', 'Denver', 'CO', '80202'],
  ['Southwest', 'Phoenix', 'AZ', '85004'],
  ['West Coast', 'Los Angeles', 'CA', '90012'],
  ['Northwest', 'Seattle', 'WA', '98101'],
  ['Alaska', 'Anchorage', 'AK', '99501'],
  ['Hawaii', 'Honolulu', 'HI', '96813'],
].map(([region, city, state, zip]) => ({ region: region!, remote: state === 'AK' || state === 'HI', address: { name: 'Rate Study', company: null, street1: '100 Example St', street2: null, city: city!, state: state!, zip: zip!, country: 'US' as const, phone: null } }))

/** Order sizes worth pricing: every size a box ladder changes at, and both ends of common price tiers. */
export const STUDY_COUNTS = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 20, 24, 25, 30, 36, 40, 48, 49, 50, 60, 72, 96, 99, 100]

/** Where tiers start, a starting point only: pass your own price tiers' sizes. */
export const STUDY_TIER_STARTS = [1, 5, 10, 25, 50, 100]

/**
 * Runs the study (kit staff), from the site's ship-from hub to each destination, with the return hub's address for
 * the return labels and the site's active box types. Refuses without Shipping's label functions, and stops at the
 * first quote that isn't in test mode.
 */
export async function rateStudy(req: PayloadRequest, input: { counts?: number[]; destinations?: Destination[]; onProgress?: (line: string) => void } = {}): Promise<StudyResult> {
  const o = optionsOf(req.payload)
  await requireStaff(o, req)
  const s = shippingOf(o)
  const site = await siteOf(o, req)
  const counts = (input.counts ?? STUDY_COUNTS).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000)
  const destinations = input.destinations ?? STUDY_DESTINATIONS
  const setup = await inTransaction(req, async (req) => {
    const from = hubLabel(s, await shipFromHub(req, o, site)).to
    const hub = await returnHub(req, o, site)
    const types = ((await req.payload.find({ collection: 'box-types', where: scoped(o, site, { active: { equals: true } }), ...READ, req })).docs as unknown as BoxTypeDoc[]).map((t) => ({ ...t, id: String(t.id) }))
    return { from, hub: { address: hub.address, placeholder: hub.placeholder }, types }
  })
  const parcelOf = (t: BoxTypeDoc, kits: number) => s.parcelFor({ outside: outside(t), emptyWeightOz: t.emptyWeightOz }, kits * (o.policy?.kitWeightOz ?? KIT_WEIGHT_OZ))
  const types = setup.types.filter((t) => !s.mailability || !parcelOf(t, t.kitsPerBox) || s.mailability(parcelOf(t, t.kitsPerBox)!).mailable)
  const rows: StudyRow[] = []
  let quotes = 0
  let fake = false
  const testOnly = (mode: unknown) => {
    if (mode !== 'test') throw new KitError('productionMode', 'The rate study runs only against Shipping’s test mode. Nothing was reported.')
  }
  const cache = new Map<string, { outboundCents: number; returnCents: number }>()
  for (const kits of counts) {
    for (const d of destinations) {
      const price: Pricer = async (box, parcel, fill) => {
        const key = `${d.region}|${box.id}|${fill}`
        const hit = cache.get(key)
        if (hit) return hit
        const reference = `rate-study-${box.kitsPerBox}-${fill}`
        const out = await s.quote(req.payload, { from: setup.from, to: d.address, parcel, reference }, req).catch((e: unknown) => {
          throw carrierRefusal(e)
        })
        testOnly(out.mode)
        const back = await s.quoteReturn(req.payload, { customer: d.address, hub: setup.hub, parcel, reference }, req).catch((e: unknown) => {
          throw carrierRefusal(e)
        })
        testOnly(back.mode)
        quotes += 2
        fake ||= Boolean(out.fake || out.rate.fake || back.fake)
        const p = { outboundCents: out.rateCents, returnCents: back.rateCents }
        cache.set(key, p)
        return p
      }
      const plan = await planShipment(kits, types, price, parcelOf)
      if (plan) rows.push({ kits, region: d.region, remote: Boolean(d.remote), plan })
    }
    input.onProgress?.(`${kits} kits: done`)
  }
  return { rows, quotes, fake }
}

export type SuggestedTier = { minQuantity: number; upTo: number | null; shippingCents: number; returnCents: number; overTen: boolean; remoteCents: number | null }

/**
 * Suggested flat tiers at `starts`: each covers the dearest order in its range to the 48 contiguous states, rounded up
 * to the next 50 cents. Alaska and Hawaii are reported apart, since one far destination shouldn't set everyone's price.
 */
export function suggestTiers(rows: StudyRow[], starts: number[] = STUDY_TIER_STARTS): SuggestedTier[] {
  const up = (c: number) => Math.ceil(c / 50) * 50
  return starts.map((min, i) => {
    const next = starts[i + 1] ?? null
    const inRange = rows.filter((r) => r.kits >= min && (next === null || r.kits < next) && r.plan.totalCents !== null)
    const main = inRange.filter((r) => !r.remote)
    const worst = main.length ? main.reduce((m, r) => (r.plan.totalCents! > m.plan.totalCents! ? r : m), main[0]!) : null
    const remote = inRange.filter((r) => r.remote).reduce((m, r) => Math.max(m, r.plan.totalCents!), 0)
    const shippingCents = worst ? up(worst.plan.totalCents!) : 0
    const returnCents = worst ? Math.min(shippingCents, up(worst.plan.boxes.reduce((t, b) => t + (b.returnCents ?? 0), 0))) : 0
    return { minQuantity: min, upTo: next ? next - 1 : null, shippingCents, returnCents, overTen: shippingCents > 1000, remoteCents: remote ? up(remote) : null }
  })
}

/** Two kits: one box with one return label, or two boxes with two, per region. */
export function twoKitsAnswer(rows: StudyRow[]): { region: string; oneBox: string; boxes: number; totalCents: number }[] {
  return rows.filter((r) => r.kits === 2 && r.plan.totalCents !== null).map((r) => ({ region: r.region, oneBox: r.plan.boxes.length === 1 ? 'one box' : `${r.plan.boxes.length} boxes`, boxes: r.plan.boxes.length, totalCents: r.plan.totalCents! }))
}

const usd = (c: number | null) => (c === null ? 'n/a' : `$${(c / 100).toFixed(2)}`)

/** The report, in Markdown. Names regions only, never the sender or the hub, so it can be shared. */
export function studyReport(r: StudyResult, when: string, starts: number[] = STUDY_TIER_STARTS, o?: Pick<ResolvedOptions, 'policy'>): string {
  const lines: string[] = []
  lines.push(`# Kit shipping rate study (${when})`, '')
  lines.push(r.fake ? '**Made-up prices: this ran against a fake carrier. Don’t set prices from it.**' : `Shipping's test mode, ${r.quotes} quotes, nothing bought.`, '')
  lines.push(`Each cost is the cheapest box plan for the order: outbound labels plus one prepaid return label per box.${o?.policy?.kitWeightOz === undefined ? ' Kit weights are placeholders.' : ''}`, '')
  const regions = [...new Set(r.rows.map((x) => x.region))]
  lines.push('## Cost per order size', '', `| Kits | ${regions.join(' | ')} | Boxes (dearest) |`, `|---|${regions.map(() => '---|').join('')}---|`)
  for (const kits of [...new Set(r.rows.map((x) => x.kits))]) {
    const row = r.rows.filter((x) => x.kits === kits)
    const dearest = row.reduce((m, x) => ((x.plan.totalCents ?? 0) > (m.plan.totalCents ?? 0) ? x : m), row[0]!)
    lines.push(`| ${kits} | ${regions.map((g) => usd(row.find((x) => x.region === g)?.plan.totalCents ?? null)).join(' | ')} | ${dearest.plan.boxes.map((b) => `${b.name} ×${b.kits}`).join(', ')} |`)
  }
  lines.push('', '## Two kits: one box or two?', '')
  for (const a of twoKitsAnswer(r.rows)) lines.push(`- ${a.region}: ${a.oneBox}, ${usd(a.totalCents)}`)
  lines.push('', '## Suggested flat tiers', '', 'Each covers the dearest order in its range to the 48 contiguous states, rounded up to 50 cents. Alaska and Hawaii are shown apart.', '', '| Kits | Shipping | Of which returns | Alaska/Hawaii dearest | Under $10? |', '|---|---|---|---|---|')
  for (const t of suggestTiers(r.rows, starts)) lines.push(`| ${t.minQuantity}${t.upTo ? `–${t.upTo}` : '+'} | ${usd(t.shippingCents)} | ${usd(t.returnCents)} | ${usd(t.remoteCents)} | ${t.overTen ? 'no' : 'yes'} |`)
  lines.push('')
  return lines.join('\n')
}
