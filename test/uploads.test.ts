import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { batchKit, checkInKit, createBatch, createLot, findKit, KitError, receiveResult, recordKitEvent, RESULT_UPLOAD_INDEX, sha256Hex, shipBatch, type VerifiedUpload } from '../src/index.js'
import { labPage, submitResultFile, type ServerResult } from '../src/server/index.js'
import { fakeResults, reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo } from './harness.js'

// Result uploads by file id (agreed with the site's team, 2026-11-10), and the base64 cap without it. Made-up people,
// labs, kits and files on made-up site A only; "storage" is a map in memory.
type Person = Awaited<ReturnType<typeof person>>
type Stored = VerifiedUpload & { owner: string }
const res = fakeResults()
const accepted: { fileId: string | null; data: unknown; text: unknown; type: string | null }[] = []
const storage = new Map<string, Stored>()
let byId: Payload, byBytes: Payload
let labUser: Person, stranger: Person, bytesLabUser: Person
let labById = '', labByBytes = ''
let n = 0

const as = (p: Payload, u: Person | null) => reqAs(p, u as never)
async function kitErr(p: Promise<unknown>, code: string): Promise<KitError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `expected KitError ${code}`).toBeInstanceOf(KitError)
  expect((error as KitError).code).toBe(code)
  return error as KitError
}
function refused<T>(r: ServerResult<T>, code: string) {
  expect(r.ok, `expected refusal ${code}`).toBe(false)
  if (r.ok) throw new Error('unreachable')
  expect(r.error.code).toBe(code)
  return r.error
}
/** Puts a made-up file in "storage" for `owner`, as the site's client uploader would, and answers its id. */
function store(owner: Person, name: string, text: string, type = 'text/plain'): string {
  const fileId = `made-up-file-${++n}`
  const data = new TextEncoder().encode(text)
  storage.set(fileId, { fileId, name, size: data.byteLength, type, sha256: sha256Hex(data), owner: String(owner.id) })
  return fileId
}

/** A site with one lab, a batch of `count` kits shipped to it, ready for results. */
async function site(p: Payload, lot: string, count: number, portalUser: Person) {
  const staff = await person(p, 'A', 'staff')
  const keeper = await person(p, 'A')
  const sys = { overrideAccess: true } as const
  await p.create({ collection: 'hubs', data: { tenant: 'A', name: 'Made-up Hub', address: { kind: 'street', name: 'Made-up Hub', line1: '1 Example Way', city: 'Testville', state: 'AZ', postalCode: '85000' }, defaultReturn: true } as never, ...sys })
  const lab = String((await p.create({ collection: 'labs', data: { tenant: 'A', name: 'Made-up Lab', portalUsers: [portalUser.id] } as never, ...sys })).id)
  await createLot(await as(p, staff), { lotNumber: lot, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: count })
  const codes: string[] = []
  const batch = await createBatch(await as(p, staff), { lab, size: count })
  for (let i = 1; i <= count; i++) {
    const code = `${lot}${String(i).padStart(6, '0')}`
    const kit = (await findKit(await as(p, staff), code, 'A'))!
    await recordKitEvent(await as(p, staff), kit, { type: 'activated', set: { activatedBy: keeper.id, activatedAt: new Date().toISOString() } })
    await recordKitEvent(await as(p, staff), kit, { type: 'sampled' })
    await checkInKit(await as(p, staff), { code })
    await batchKit(await as(p, staff), { batch: String(batch.id), code })
    codes.push(code)
  }
  await shipBatch(await as(p, staff), { batch: String(batch.id), tracking: ['9400100000000000000055'], oddSizeOk: true })
  return { lab, codes }
}
let idCodes: string[] = []
let bytesCodes: string[] = []

beforeAll(async () => {
  byId = (
    await startPayload((o) => ({
      ...o,
      results: {
        ...res.results,
        accept: async (args) => {
          accepted.push({ fileId: args.file.fileId, data: args.file.data, text: args.file.text, type: args.file.type })
          // The site reads the stored file itself; made up here: a name saying "refuse" is a file it can't use.
          if (args.file.name.includes('refuse')) return { status: 'failed', summary: 'Made-up: the stored file isn’t a FASTA file.' }
          return res.results.accept(args)
        },
        // The site's own checks: the uploader, and that the file exists. The plugin checks again on top.
        verifyUpload: async ({ fileId, req }) => {
          const f = storage.get(fileId)
          if (!f || f.owner !== String(req.user?.id)) throw new Error('made-up refusal: not this person’s upload')
          if (f.name === 'lies.fasta') return { ...f, fileId: 'someone-else' }
          return { fileId: f.fileId, name: f.name, size: f.size, type: f.type, sha256: f.sha256 }
        },
      },
    }))
  ).payload
  labUser = await person(byId, 'A')
  stranger = await person(byId, 'A')
  ;({ lab: labById, codes: idCodes } = await site(byId, '515151', 6, labUser))
  byBytes = (await startPayload((o) => ({ ...o, results: { ...res.results, maxBytes: 5_000_000, maxBase64Bytes: 1_000 } }))).payload
  bytesLabUser = await person(byBytes, 'A')
  ;({ lab: labByBytes, codes: bytesCodes } = await site(byBytes, '525252', 2, bytesLabUser))
}, 240_000)

afterAll(async () => {
  await byId?.destroy()
  await byBytes?.destroy()
  await stopMongo()
})

describe('uploads by file id', () => {
  it('takes a stored file by its id: accept gets the id, never bytes', async () => {
    const page = await labPage(await as(byId, labUser))
    expect(page.ok && page.data.upload).toMatchObject({ by: 'fileId', maxBytes: 900_000 })
    const fileId = store(labUser, `${idCodes[0]}.fasta`, `>${idCodes[0]}\nACGT\n`)
    const r = await submitResultFile(await as(byId, labUser), { lab: labById, fileId })
    expect(r).toMatchObject({ ok: true, data: { result: 'received', code: idCodes[0] } })
    expect(accepted.at(-1)).toEqual({ fileId, data: null, text: null, type: 'text/plain' })
    const events = (await byId.find({ collection: 'kit-events', where: { type: { equals: 'results-in' } }, overrideAccess: true, depth: 0 })).docs as unknown as { details: Record<string, unknown> }[]
    expect(events.at(-1)!.details).toMatchObject({ uploadFileId: fileId, sha256: storage.get(fileId)!.sha256 })
  })

  it('refuses bytes when uploads go by file id', async () => {
    const data = Buffer.from(`>${idCodes[1]}\nACGT\n`).toString('base64')
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, name: `${idCodes[1]}.fasta`, data }), 'uploadById')
    await kitErr(receiveResult(await as(byId, labUser), { lab: labById, name: `${idCodes[1]}.fasta`, data: new Uint8Array([62, 65]) }), 'uploadById')
  })

  it('refuses when the site’s verifyUpload throws or answers for another file, and refuses a type that isn’t a result', async () => {
    // Someone else's upload: the site refuses it.
    const theirs = store(stranger, `${idCodes[1]}.fasta`, `>${idCodes[1]}\nACGT\n`)
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: theirs }), 'uploadRefused')
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: 'no-such-file' }), 'uploadRefused')
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: store(labUser, 'lies.fasta', '>x\nACGT\n') }), 'uploadRefused')
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: store(labUser, `${idCodes[1]}.fasta`, '%PDF', 'application/pdf') }), 'fileType')
    // The plugin's own checks still run: the name must be a result file.
    const r = await submitResultFile(await as(byId, labUser), { lab: labById, fileId: store(labUser, `${idCodes[1]}.pdf`, `>${idCodes[1]}\nACGT\n`) })
    expect(r).toMatchObject({ ok: true, data: { result: 'unmatched' } })
    // Someone who isn't the lab's learns nothing, whatever the id.
    refused(await submitResultFile(await as(byId, stranger), { lab: labById, fileId: theirs }), 'notLab')
  })

  it('refuses an id any kit’s result already used, one after another or at the same moment', async () => {
    const once = store(labUser, `${idCodes[2]}.fasta`, `>${idCodes[2]}\nACGT\n`)
    expect(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: once })).toMatchObject({ ok: true, data: { result: 'received' } })
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: once }), 'fileUsed')
    // A refused file used its id too.
    const bad = store(labUser, `${idCodes[3]}-refuse.fasta`, 'not a fasta file')
    expect(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: bad })).toMatchObject({ ok: true, data: { result: 'refused' } })
    refused(await submitResultFile(await as(byId, labUser), { lab: labById, fileId: bad }), 'fileUsed')
    // Two sends of one id at once: one is recorded, the other refused.
    const twice = store(labUser, `${idCodes[4]}.fasta`, `>${idCodes[4]}\nACGT\n`)
    const both = await Promise.all([1, 2].map(async () => submitResultFile(await as(byId, labUser), { lab: labById, fileId: twice })))
    expect(both.filter((r) => r.ok && r.data.result === 'received')).toHaveLength(1)
    for (const r of both.filter((r) => !r.ok)) expect(['fileUsed', 'busy']).toContain((r as { error: { code: string } }).error.code)
    expect((await byId.count({ collection: 'kit-events', where: { 'details.uploadFileId': { equals: twice } }, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('backs single use with a unique index, made at start-up', async () => {
    const coll = (byId.db.collections['kit-events'] as unknown as { collection: { indexes: () => Promise<{ name: string; unique?: boolean; partialFilterExpression?: unknown }[]> } }).collection
    expect((await coll.indexes()).find((i) => i.name === RESULT_UPLOAD_INDEX)).toMatchObject({ unique: true, partialFilterExpression: { 'details.uploadFileId': { $type: 'string' } } })
  })
})

describe('base64, without verifyUpload', () => {
  it('takes bytes up to results.maxBase64Bytes, refuses past it in plain words, and refuses a file id', async () => {
    const me = bytesLabUser
    const page = await labPage(await as(byBytes, me))
    expect(page.ok && page.data.upload).toMatchObject({ by: 'base64', maxBytes: 1_000 })
    const small = Buffer.from(`>${bytesCodes[0]}\nACGT\n`).toString('base64')
    expect(await submitResultFile(await as(byBytes, me), { lab: labByBytes, name: `${bytesCodes[0]}.fasta`, data: small })).toMatchObject({ ok: true, data: { result: 'received' } })
    const big = Buffer.from(`>${bytesCodes[1]}\n${'ACGT'.repeat(400)}\n`).toString('base64')
    const e = refused(await submitResultFile(await as(byBytes, me), { lab: labByBytes, name: `${bytesCodes[1]}.fasta`, data: big }), 'uploadTooBig')
    expect(e.message).toMatch(/too big to send here \(the limit is 1 KB\)/)
    await kitErr(receiveResult(await as(byBytes, me), { lab: labByBytes, name: `${bytesCodes[1]}.fasta`, data: new Uint8Array(1_001) }), 'uploadTooBig')
    // An oversized body is refused before it's decoded, even if it would decode small.
    refused(await submitResultFile(await as(byBytes, me), { lab: labByBytes, name: `${bytesCodes[1]}.fasta`, data: small + ' '.repeat(2_000) }), 'uploadTooBig')
    refused(await submitResultFile(await as(byBytes, me), { lab: labByBytes, fileId: 'made-up-file-1' }), 'noUploadById')
  })
})
