import type { Payload } from 'payload'

import { hasShipping } from './carrier.js'
import type { ResolvedOptions } from './types.js'

/**
 * The indexes money and uploads depend on. Each is a unique partial index that lets only one claim exist at a time, so
 * two requests can never both pay: one label purchase per order box (or kit), one refund per order, and one result
 * per uploaded file id. Payload's `indexes`
 * can't say "partial", so they're made through the database adapter (MongoDB only, for now).
 *
 * `ensureIndexes: 'startup'` (the default) makes them when Payload starts. `'manual'` leaves that to the site's own
 * index script, which calls `ensureSampleKitsIndexes(payload)`, and only checks at start-up that they're there.
 */

export const SLOT_INDEX = 'sampleKits_slotKey_claim'
export const REFUND_CLAIM_INDEX = 'sampleKits_refund_claim'
/** One result per uploaded file id (`results.verifyUpload`), whichever kit it's for. */
export const RESULT_UPLOAD_INDEX = 'sampleKits_result_upload'
/** One shipment notice per parcel, notice and person (`kit-notices`), so a repeated carrier update sends nothing new. */
export const NOTICE_INDEX = 'sampleKits_notice_key'

type IndexSpec = { collection: string; name: string; key: Record<string, 1>; partial: Record<string, unknown>; neededBy: (o: ResolvedOptions) => boolean; why: string }

export const SAMPLE_KITS_INDEXES: readonly IndexSpec[] = [
  { collection: 'return-labels', name: SLOT_INDEX, key: { slotKey: 1 }, partial: { slotKey: { $type: 'string' } }, neededBy: hasShipping, why: 'one label purchase per order box' },
  { collection: 'kit-refunds', name: REFUND_CLAIM_INDEX, key: { claimKey: 1 }, partial: { claimKey: { $type: 'string' } }, neededBy: (o) => Boolean(o.payments?.refund), why: 'one refund at a time per order' },
  { collection: 'kit-events', name: RESULT_UPLOAD_INDEX, key: { 'details.uploadFileId': 1 }, partial: { 'details.uploadFileId': { $type: 'string' } }, neededBy: (o) => Boolean(o.results?.verifyUpload), why: 'one result per uploaded file' },
  { collection: 'kit-notices', name: NOTICE_INDEX, key: { noticeKey: 1 }, partial: { noticeKey: { $type: 'string' } }, neededBy: (o) => Boolean(o.notify), why: 'one shipment notice per parcel and person' },
]

type IndexInfo = { name?: string; key?: Record<string, unknown>; unique?: boolean; partialFilterExpression?: unknown }
type NativeCollection = { createIndex: (k: object, o: object) => Promise<unknown>; indexes: () => Promise<IndexInfo[]> }

function nativeOf(payload: Payload, slug: string): NativeCollection {
  const model = (payload.db as unknown as { collections?: Record<string, { collection?: Partial<NativeCollection> }> }).collections?.[slug]
  const c = model?.collection
  if (!c?.createIndex || !c.indexes) throw new Error('Sample Kits: label purchases, refunds and result uploads need unique partial indexes, which this database adapter can’t make. Only MongoDB is supported for now.')
  return c as NativeCollection
}

/**
 * Makes every index Sample Kits needs for money. Safe to run again: an index that's already there, the same, is
 * left alone. Call it from your index script when you start Payload with `ensureIndexes: 'manual'`.
 */
export async function ensureSampleKitsIndexes(payload: Payload): Promise<void> {
  for (const spec of SAMPLE_KITS_INDEXES) await nativeOf(payload, spec.collection).createIndex(spec.key, { name: spec.name, unique: true, partialFilterExpression: spec.partial })
}

/** Why an index isn't right, or null. Read-only. */
export async function indexProblem(payload: Payload, spec: IndexSpec): Promise<string | null> {
  let list: IndexInfo[]
  try {
    list = await nativeOf(payload, spec.collection).indexes()
  } catch (error) {
    // A collection that doesn't exist yet has no indexes; anything else is a real failure.
    if ((error as { code?: unknown } | null)?.code === 26 || /ns does not exist|NamespaceNotFound/i.test(String((error as Error | null)?.message ?? ''))) list = []
    else throw error
  }
  const found = list.find((i) => i.name === spec.name)
  if (!found) return 'missing'
  if (JSON.stringify(found.key) !== JSON.stringify(spec.key)) return `on ${JSON.stringify(found.key)}, not ${JSON.stringify(spec.key)}`
  if (found.unique !== true) return 'not unique'
  if (JSON.stringify(found.partialFilterExpression ?? null) !== JSON.stringify(spec.partial)) return `without the partial filter ${JSON.stringify(spec.partial)} (it has ${JSON.stringify(found.partialFilterExpression ?? null)})`
  return null
}

/** Start-up. `'startup'` makes what's needed; `'manual'` refuses to start, loudly, when something's missing or wrong. */
export async function indexesAtStartup(payload: Payload, o: ResolvedOptions): Promise<void> {
  const needed = SAMPLE_KITS_INDEXES.filter((spec) => spec.neededBy(o))
  if (!needed.length) return
  if ((o.ensureIndexes ?? 'startup') === 'startup') {
    await ensureSampleKitsIndexes(payload)
    return
  }
  const problems: string[] = []
  for (const spec of needed) {
    const problem = await indexProblem(payload, spec)
    if (problem) problems.push(`${spec.collection}.${spec.name} (${spec.why}) is ${problem}`)
  }
  if (problems.length)
    throw new Error(
      `Sample Kits won’t start: ${problems.join('; ')}. With ensureIndexes: 'manual', run ensureSampleKitsIndexes(payload) from your index script first. Without these unique indexes, two requests at once could pay twice or use one upload twice.`,
    )
}
