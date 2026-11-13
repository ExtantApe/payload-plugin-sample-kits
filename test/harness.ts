import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Config, type Payload, type PayloadRequest } from 'payload'

import { KIT_COLLECTION_SLUGS, sampleKits, type SampleKitsOptions } from '../src/index.js'
import { fakeAccess, fakeSubjects } from '../src/testing.js'

/**
 * Payload on an in-memory MongoDB replica set, with made-up people on two made-up sites (A and B).
 * Each person has a `site` and maybe a `kitRole`. A small plugin after Sample Kits adds a `tenant`
 * field to its collections, as a site's multi-tenant plugin would.
 */

let mongo: MongoMemoryReplSet | null = null
let n = 0

export async function startMongo() {
  mongo ??= await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  return mongo
}
export async function stopMongo() {
  await mongo?.stop()
  mongo = null
}

const addTenantField = (config: Config): Config => ({
  ...config,
  collections: (config.collections ?? []).map((c) =>
    (KIT_COLLECTION_SLUGS as readonly string[]).includes(c.slug) || c.slug === 'orders' ? { ...c, fields: [...c.fields, { name: 'tenant', type: 'text', index: true }] } : c,
  ),
})

export const scopeBySite = { field: 'tenant', of: (req: PayloadRequest) => ((req.user as { site?: string } | null)?.site ?? null) }

export type Harness = { payload: Payload; subjects: ReturnType<typeof fakeSubjects>; key: string }

/** A Payload instance with Sample Kits; `change` adjusts the options, `extra` adds collections, plugins (after Sample Kits) and config. Each gets its own database. */
export async function startPayload(change: (o: SampleKitsOptions) => SampleKitsOptions = (o) => o, extra: Partial<Config> = {}, dbName?: string): Promise<Harness> {
  const m = await startMongo()
  const subjects = fakeSubjects()
  const options = change({ access: fakeAccess(), subjects, tests: [{ label: 'Made-up test A', value: 'test-a' }, { label: 'Made-up test B', value: 'test-b' }], scope: scopeBySite })
  const key = `kits-${++n}`
  const payload = await getPayload({
    key,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: m.getUri(dbName ?? key), ensureIndexes: true }),
      collections: [
        { slug: 'users', auth: true, fields: [{ name: 'site', type: 'text' }, { name: 'kitRole', type: 'select', options: ['staff', 'admin', 'maintainer'] }] },
        {
          slug: 'orders',
          fields: [
            { name: 'ref', type: 'text' },
            { name: 'customer', type: 'relationship', relationTo: 'users' },
            { name: 'shipTo', type: 'json' },
            { name: 'amount', type: 'number' },
            { name: 'totals', type: 'group', fields: [{ name: 'shipping', type: 'number' }] },
          ],
        },
        { slug: 'products', fields: [{ name: 'title', type: 'text' }] },
        { slug: 'files', fields: [{ name: 'name', type: 'text' }] },
        ...(extra.collections ?? []),
      ],
      plugins: [sampleKits(options), addTenantField, ...(extra.plugins ?? [])],
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'collections' && k !== 'plugins')),
    }),
  } as never)
  // Build indexes first, so no index build aborts a transaction.
  const db = payload.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<void> }> }
  await Promise.all([...KIT_COLLECTION_SLUGS, 'orders'].map((c) => db.collections[c]!.ensureIndexes()))
  return { payload, subjects, key }
}

let people = 0
export async function person(payload: Payload, site: string, kitRole?: 'staff' | 'admin' | 'maintainer') {
  const i = ++people
  const password = `made-up-password-${i}`
  const doc = (await payload.create({ collection: 'users', data: { email: `person-${i}@example.test`, password, site, kitRole } as never })) as unknown as { id: string; site: string; kitRole?: string; email: string }
  return Object.assign(doc, { password })
}
