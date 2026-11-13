import type { Payload } from 'payload'
import { afterAll, describe, expect, it } from 'vitest'

import { ensureSampleKitsIndexes, NOTICE_INDEX, REFUND_CLAIM_INDEX, SLOT_INDEX } from '../src/index.js'
import { fakePayments, fakeShipping } from '../src/testing.js'
import { startPayload, stopMongo } from './harness.js'

// Index building left to the site's own script (`ensureIndexes: 'manual'`). Each test uses its own made-up database.
const started: Payload[] = []
const money = { adapters: { shipping: fakeShipping().adapter }, payments: fakePayments().payments }
type Native = { createIndex: (k: object, o: object) => Promise<unknown>; indexes: () => Promise<{ name: string; unique?: boolean; partialFilterExpression?: unknown }[]> }
const native = (payload: Payload, slug: string) => (payload.db as unknown as { collections: Record<string, { collection: Native }> }).collections[slug]!.collection

/** A Payload on `db` with no money adapters wired, so start-up neither makes nor checks the indexes. */
const plain = async (db: string) => {
  const h = await startPayload((o) => o, {}, db)
  started.push(h.payload)
  return h.payload
}
const manual = async (db: string) => {
  const h = await startPayload((o) => ({ ...o, ...money, ensureIndexes: 'manual' }), {}, db)
  started.push(h.payload)
  return h.payload
}

afterAll(async () => {
  for (const p of started) await p.destroy().catch(() => undefined)
  await stopMongo()
})

describe('index building left to the site', () => {
  it('refuses to start in manual mode while the indexes are missing, naming the function to run', async () => {
    await expect(manual('manual-missing')).rejects.toThrow(/ensureSampleKitsIndexes.*two requests at once could pay twice/s)
    await expect(manual('manual-missing')).rejects.toThrow(new RegExp(`return-labels\\.${SLOT_INDEX}.*missing.*kit-refunds\\.${REFUND_CLAIM_INDEX}.*missing`))
  })

  it('starts in manual mode once ensureSampleKitsIndexes has run, and running it twice is fine', async () => {
    const setup = await plain('manual-ready')
    expect((await native(setup, 'return-labels').indexes()).some((i) => i.name === SLOT_INDEX)).toBe(false)
    await ensureSampleKitsIndexes(setup)
    await ensureSampleKitsIndexes(setup)
    const slot = (await native(setup, 'return-labels').indexes()).find((i) => i.name === SLOT_INDEX)
    expect(slot).toMatchObject({ unique: true, partialFilterExpression: { slotKey: { $type: 'string' } } })
    expect((await native(setup, 'kit-refunds').indexes()).find((i) => i.name === REFUND_CLAIM_INDEX)).toMatchObject({ unique: true })
    expect((await native(setup, 'kit-notices').indexes()).find((i) => i.name === NOTICE_INDEX)).toMatchObject({ unique: true, partialFilterExpression: { noticeKey: { $type: 'string' } } })
    await expect(manual('manual-ready')).resolves.toBeTruthy()
  })

  it('refuses a wrong index: not unique, or without its partial filter', async () => {
    const setup = await plain('manual-wrong')
    await ensureSampleKitsIndexes(setup)
    // Swap the slot index for one that isn't unique, under the same name.
    const db = (setup.db as unknown as { connection: { db: { collection: (n: string) => { dropIndex: (n: string) => Promise<unknown>; createIndex: (k: object, o: object) => Promise<unknown> } } } }).connection.db
    await db.collection('return-labels').dropIndex(SLOT_INDEX)
    await db.collection('return-labels').createIndex({ slotKey: 1, box: 1 }, { name: SLOT_INDEX })
    await expect(manual('manual-wrong')).rejects.toThrow(/return-labels\.sampleKits_slotKey_claim .* is on \{"slotKey":1,"box":1\}/)
    await db.collection('return-labels').dropIndex(SLOT_INDEX)
    await db.collection('return-labels').createIndex({ slotKey: 1 }, { name: SLOT_INDEX, partialFilterExpression: { slotKey: { $type: 'string' } } })
    await expect(manual('manual-wrong')).rejects.toThrow(/sampleKits_slotKey_claim .* is not unique/)
    await db.collection('kit-refunds').dropIndex(REFUND_CLAIM_INDEX)
    await db.collection('kit-refunds').createIndex({ claimKey: 1 }, { name: REFUND_CLAIM_INDEX, unique: true })
    await expect(manual('manual-wrong')).rejects.toThrow(/sampleKits_refund_claim .* is without the partial filter .*\(it has null\)/)
  })

  it('makes the indexes itself at start-up by default', async () => {
    const h = await startPayload((o) => ({ ...o, ...money }), {}, 'startup-default')
    started.push(h.payload)
    expect((await native(h.payload, 'kit-refunds').indexes()).find((i) => i.name === REFUND_CLAIM_INDEX)).toMatchObject({ unique: true, partialFilterExpression: { claimKey: { $type: 'string' } } })
  })
})
