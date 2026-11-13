import { createHash } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { audit, busy, idOf, inTransaction, isStaff, isWriteConflict, KitError, optionsOf, personOf, READ, scoped, siteOf, sysReq } from './internal.js'
import { findKit, recordKitEvent } from './kits.js'
import { labForRequest, type BatchDoc, type LabDoc } from './lab.js'
import { RESULTABLE } from './status.js'
import type { KitDoc, ResolvedOptions, ResultFile, ResultView, VerifiedUpload } from './types.js'

/**
 * Result files from the lab's portal. The plugin checks each file's name, type and size, takes its SHA-256, and
 * matches it to a kit sent to that lab, by the kit code in the file name or the FASTA header. What the file means
 * is the site's: `results.accept` stores and reads it, and `results.view` shows it to the kit's keeper. A lab sees
 * whether a file was taken, never a result, a keeper or a subject.
 */

/** File types the portal takes by default. A zip of them is unpacked in the browser first. */
export const RESULT_EXTENSIONS = ['.fasta', '.fa', '.fas', '.fna', '.ffn', '.seq', '.txt'] as const
/** Largest single result file by default: a cyt-b FASTA is about 1 KB, and server actions take about 1 MB. */
export const MAX_RESULT_BYTES = 900_000
/** Content types taken from `results.verifyUpload` by default. Browsers often call a FASTA file unknown binary. */
export const RESULT_TYPES = ['text/plain', 'text/x-fasta', 'application/x-fasta', 'chemical/seq-na-fasta', 'application/octet-stream'] as const
/**
 * Without `verifyUpload`: the largest file taken as base64. Hosts cap a request body (Vercel at 4.5 MB) and base64 adds
 * a third, so 3 MB of file is about 4 MB on the wire.
 */
export const MAX_BASE64_BYTES = 3_000_000
/** Where a result event keeps the uploaded file's id: one use per id, held by a unique index (`RESULT_UPLOAD_INDEX`). */
export const UPLOAD_ID_PATH = 'details.uploadFileId'

const codeIn = (s: string | null | undefined) => /(?<!\d)(\d{8,20})(?!\d)/.exec(s ?? '')?.[1] ?? null
const baseName = (name: string) => String(name ?? '').split(/[\\/]/).pop() ?? ''
const extensionsOf = (o: ResolvedOptions) => (o.results?.extensions?.length ? o.results.extensions : RESULT_EXTENSIONS).map((e) => e.toLowerCase())
const maxBytesOf = (o: ResolvedOptions) => (Number.isInteger(o.results?.maxBytes) && o.results!.maxBytes! > 0 ? o.results!.maxBytes! : MAX_RESULT_BYTES)
export const maxBase64Of = (o: ResolvedOptions) => (Number.isInteger(o.results?.maxBase64Bytes) && o.results!.maxBase64Bytes! > 0 ? o.results!.maxBase64Bytes! : MAX_BASE64_BYTES)
/** The largest file a lab can send here: the result limit, and for base64 the request's limit too. */
export const uploadLimitOf = (o: ResolvedOptions) => (o.results?.verifyUpload ? maxBytesOf(o) : Math.min(maxBytesOf(o), maxBase64Of(o)))
const typesOf = (o: ResolvedOptions) => (o.results?.types?.length ? o.results.types : RESULT_TYPES).map((t) => t.toLowerCase())
export const hasResultExtension = (name: string, extensions: readonly string[] = RESULT_EXTENSIONS) => extensions.some((e) => baseName(name).toLowerCase().endsWith(e.toLowerCase()))
export const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/** The first line of a file, if it's a FASTA header. */
export const fastaHeader = (text: string) => {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  return first.startsWith('>') ? first.slice(0, 300) : null
}

const DNA = /^[ACGTURYKMSWBDHVN.-]+$/i

/**
 * Why a FASTA file can't be used, in plain words, or null: one record, not empty, DNA letters. A site may pass it
 * as `results.check`, so most refusals happen before anything is stored.
 */
export function fastaProblem(text: string): string | null {
  const body = text.replace(/^﻿/, '').trim()
  if (!body) return 'The file is empty.'
  const lines = body.split(/\r?\n/)
  if (!lines[0]!.startsWith('>')) return 'This isn’t a FASTA file: the first line should start with ">" and the kit code.'
  const headers = lines.filter((l) => l.startsWith('>')).length
  if (headers > 1) return `The file has ${headers} records. Upload one sample per file.`
  const sequence = lines.slice(1).join('').replace(/\s/g, '')
  if (!sequence) return 'The file has a header but no sequence.'
  if (!DNA.test(sequence)) return 'The sequence has letters that aren’t DNA (A, C, G, T and the usual ambiguity codes).'
  return null
}

// ---------------------------------------------------------------- matching

type LabKits = { byCode: Map<string, KitDoc>; received: Map<string, Set<string>> }

/** Kits in batches that went to this lab, by code, with the SHA-256 of results already taken. */
async function labKits(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, lab: LabDoc): Promise<LabKits> {
  const batches = (await req.payload.find({ collection: 'lab-batches', where: scoped(o, site, { and: [{ lab: { equals: lab.id } }, { status: { in: ['shipped', 'received', 'complete'] } }] }), ...READ, req })).docs as unknown as BatchDoc[]
  const kits = batches.length ? ((await req.payload.find({ collection: 'kits', where: scoped(o, site, { labBatch: { in: batches.map((b) => b.id) } }), ...READ, req })).docs as unknown as KitDoc[]) : []
  const events = kits.length ? (await req.payload.find({ collection: 'kit-events', where: { and: [{ kit: { in: kits.map((k) => k.id) } }, { type: { equals: 'results-in' } }] }, ...READ, req })).docs : []
  const received = new Map<string, Set<string>>()
  for (const e of events) {
    const sha = (e.details as { sha256?: string } | null)?.sha256
    const kit = idOf(e.kit)!
    if (sha) received.set(kit, (received.get(kit) ?? new Set()).add(sha))
  }
  return { byCode: new Map(kits.map((k) => [k.code, k])), received }
}

export type ResultItem = { name: string; header?: string | null; sha256?: string | null; size?: number | null }
export type ResultMatch = {
  name: string
  code: string | null
  outcome: 'ready' | 'rerun' | 'already' | 'unmatched'
  /** Why a file can't be matched: no code in it, a code not sent to this lab, two codes, a kit not ready, too big, not a result file. */
  reason?: 'noCode' | 'notThisLab' | 'conflict' | 'notReady' | 'tooBig' | 'fileType'
  status?: string
}

function matchOne(o: ResolvedOptions, item: ResultItem, kits: LabKits): ResultMatch {
  const name = baseName(item.name).slice(0, 300)
  if (!hasResultExtension(name, extensionsOf(o))) return { name, code: null, outcome: 'unmatched', reason: 'fileType' }
  if ((Number(item.size) || 0) > maxBytesOf(o)) return { name, code: null, outcome: 'unmatched', reason: 'tooBig' }
  const fromHeader = codeIn(item.header)
  const fromName = codeIn(name)
  const known = [fromHeader, fromName].filter((c): c is string => Boolean(c && kits.byCode.has(c)))
  if (new Set(known).size > 1) return { name, code: null, outcome: 'unmatched', reason: 'conflict' }
  const code = known[0] ?? null
  if (!code) return { name, code: fromHeader ?? fromName, outcome: 'unmatched', reason: fromHeader || fromName ? 'notThisLab' : 'noCode' }
  const kit = kits.byCode.get(code)!
  if (!RESULTABLE.includes(kit.status)) return { name, code, outcome: 'unmatched', reason: 'notReady', status: kit.status }
  const shas = kits.received.get(String(kit.id))
  if (item.sha256 && shas?.has(item.sha256)) return { name, code, outcome: 'already' }
  return { name, code, outcome: shas?.size ? 'rerun' : 'ready' }
}

/** The preview (the lab's portal users, or kit staff): which kit each file is for, and which don't match. Writes nothing. */
export async function matchResults(req: PayloadRequest, input: { lab: string; items: ResultItem[] }): Promise<ResultMatch[]> {
  const o = optionsOf(req.payload)
  if (!personOf(o, req)) throw new KitError('notLab', 'Only this lab’s portal users can do this.')
  const site = await siteOf(o, req)
  const lab = await labForRequest(req, o, site, input?.lab)
  const kits = await labKits(req, o, site, lab)
  // A second file for the same kit in one upload is saved after the first, so it's a re-run.
  const seen = new Set<string>()
  return (Array.isArray(input.items) ? input.items : []).slice(0, 1000).map((raw) => {
    // With uploads by file id the server never sees the contents, so files are matched by name alone, here too.
    const item = { name: String(raw?.name ?? ''), header: raw?.header && !o.results?.verifyUpload ? String(raw.header).slice(0, 300) : null, sha256: /^[a-f0-9]{64}$/.test(String(raw?.sha256)) ? String(raw.sha256) : null, size: Number(raw?.size) || 0 }
    const m = matchOne(o, item, kits)
    if (m.outcome === 'ready' || m.outcome === 'rerun') {
      if (seen.has(m.code!)) m.outcome = 'rerun'
      seen.add(m.code!)
    }
    return m
  })
}

// ---------------------------------------------------------------- receiving

export type ReceiveResultOutcome =
  | { result: 'received'; code: string; rerun: boolean }
  | { result: 'already'; code: string }
  | { result: 'refused'; code: string; message: string }
  | { result: 'unmatched'; match: ResultMatch }

/** A result file as given: bytes (base64 came in through the page), or the id of a file the site already stored. */
export type ResultInput = { lab: string; name: string; data: Uint8Array } | { lab: string; fileId: string }

const SHA = /^[a-f0-9]{64}$/

/** The site's answer about an uploaded file, checked again here: the same id, a name, a size within the limit, a SHA-256. */
async function verified(o: ResolvedOptions, req: PayloadRequest, fileId: string): Promise<VerifiedUpload> {
  let answer: VerifiedUpload
  try {
    answer = await o.results!.verifyUpload!({ fileId, req })
  } catch (error) {
    if (error instanceof KitError) throw error
    throw new KitError('uploadRefused', 'That upload couldn’t be checked. Choose the file and send it again.')
  }
  const a = answer as Partial<VerifiedUpload> | null
  if (!a || typeof a !== 'object' || String(a.fileId) !== fileId || typeof a.name !== 'string' || !a.name || !Number.isInteger(a.size) || a.size! <= 0 || typeof a.type !== 'string' || typeof a.sha256 !== 'string' || !SHA.test(a.sha256.toLowerCase()))
    throw new KitError('uploadRefused', 'That upload couldn’t be checked. Choose the file and send it again.')
  return { fileId, name: a.name, size: a.size!, type: a.type, sha256: a.sha256.toLowerCase() }
}

/** Has any kit's result (taken or refused) used this upload already? */
async function uploadUsed(req: PayloadRequest, fileId: string): Promise<boolean> {
  const { totalDocs } = await req.payload.count({ collection: 'kit-events', where: { [UPLOAD_ID_PATH]: { equals: fileId } }, overrideAccess: true, req })
  return totalDocs > 0
}
const fileUsed = () => new KitError('fileUsed', 'That upload was already used for a result. Choose the file and send it again.')
const duplicateKey = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null
  return e?.code === 11000 || e?.cause?.code === 11000 || /E11000|duplicate key/i.test(String(e?.message ?? ''))
}

/**
 * Take one confirmed result file (the lab's portal users, or kit staff): matched again on the server (the browser's
 * preview isn't trusted), checked, handed to `results.accept`, and recorded as a kit event, all in one transaction.
 * A refusal (`results.check`, or `accept` answering `failed`) is recorded on the kit and returned in plain words. If
 * `accept` throws, nothing is written.
 *
 * With `results.verifyUpload`, only `{ fileId }` is taken (bytes are refused, `uploadById`): the site checks its stored
 * file, the plugin checks name, type and size again, matches by the code in the name, and refuses an id already used.
 * Without it, bytes are taken up to `results.maxBase64Bytes` and a file id is refused (`noUploadById`).
 */
export async function receiveResult(req: PayloadRequest, input: ResultInput): Promise<ReceiveResultOutcome> {
  const o = optionsOf(req.payload)
  if (!o.results) throw new KitError('noResults', 'Results aren’t set up here, so no files can be taken.')
  if (!personOf(o, req)) throw new KitError('notLab', 'Only this lab’s portal users can do this.')
  const site = await siteOf(o, req)
  const byId = Boolean(o.results.verifyUpload)
  const fileId = input && 'fileId' in input && input.fileId !== undefined ? String(input.fileId ?? '').trim() : null
  const bytes = input && 'data' in input ? input.data : undefined
  if (byId && bytes !== undefined) throw new KitError('uploadById', 'Files are uploaded to storage first here, then sent by their id. Reload the page and send the file again.')
  if (!byId && fileId !== null) throw new KitError('noUploadById', 'Uploads by file id aren’t set up here. Send the file itself.')
  if (byId && (!fileId || fileId.length > 200)) throw new KitError('noFile', 'No file came through. Choose the file again.')
  return inTransaction(req, async (req) => {
    // The lab first, so someone who isn't the lab's learns nothing about any upload.
    const lab = await labForRequest(req, o, site, (input as { lab?: string } | null)?.lab ?? '')
    let file: ResultFile
    if (byId) {
      const v = await verified(o, req, fileId!)
      if (!typesOf(o).includes(v.type.toLowerCase().split(';')[0]!.trim() || 'application/octet-stream')) throw new KitError('fileType', 'Not a result file. Use a FASTA or plain text file.')
      if (await uploadUsed(req, fileId!)) throw fileUsed()
      file = { name: baseName(v.name).slice(0, 300), data: null, text: null, sha256: v.sha256, size: v.size, fileId: fileId!, type: v.type }
    } else {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array()
      if (data.byteLength > maxBase64Of(o)) throw tooBigForBase64(o)
      file = { name: baseName(String((input as { name?: unknown } | null)?.name ?? '')).slice(0, 300), data, text: new TextDecoder('utf-8').decode(data), sha256: sha256Hex(data), size: data.byteLength, fileId: null, type: null }
    }
    const kits = await labKits(req, o, site, lab)
    const match = matchOne(o, { name: file.name, header: file.text === null ? null : fastaHeader(file.text), sha256: file.sha256, size: file.size }, kits)
    if (match.outcome === 'unmatched') return { result: 'unmatched' as const, match }
    if (match.outcome === 'already') return { result: 'already' as const, code: match.code! }
    const kit = (await findKit(req, match.code!, site))!
    if (!RESULTABLE.includes(kit.status)) throw new KitError('notReady', `Kit ${kit.code} isn’t ready for results: it’s ${kit.status}.`, { code: kit.code, status: kit.status })
    const upload = file.fileId ? { uploadFileId: file.fileId } : {}
    const { name, sha256 } = file
    const record = async (event: Parameters<typeof recordKitEvent>[2]) => {
      try {
        await recordKitEvent(req, kit, event)
      } catch (error) {
        // Two sends of one upload at once: the unique index lets only one record it.
        if (file.fileId && duplicateKey(error)) throw fileUsed()
        if (isWriteConflict(error)) throw busy()
        throw error
      }
    }
    const refuse = async (message: string) => {
      await record({ type: 'result-refused', source: 'portal', lab: String(lab.id), labBatch: idOf(kit.labBatch), note: message, details: { name, sha256, ...upload } })
      return { result: 'refused' as const, code: kit.code, message: message.slice(0, 300) }
    }
    const problem = file.text === null ? null : (o.results!.check?.(file.text) ?? null)
    if (problem) return refuse(problem)
    const rerun = match.outcome === 'rerun'
    const answer = await o.results!.accept({ kit, file, lab: { id: lab.id, name: lab.name }, rerun, req })
    if (!answer || !['ready', 'review', 'failed'].includes(answer.status)) throw new Error('results.accept must answer { status: "ready" | "review" | "failed" }.')
    if (answer.status === 'failed') return refuse(String(answer.summary ?? '').trim() || 'The file couldn’t be used.')
    if (kit.status === 'returned') await recordKitEvent(req, kit, { type: 'at-lab', source: 'portal', lab: String(lab.id), labBatch: idOf(kit.labBatch) })
    await record({
      type: 'results-in',
      source: 'portal',
      lab: String(lab.id),
      labBatch: idOf(kit.labBatch),
      file: idOf(answer.file),
      details: { sha256, name, marker: kit.test ?? null, rerun, status: answer.status, ...upload },
    })
    await completeBatchIfDone(req, o, site, idOf(kit.labBatch))
    return { result: 'received' as const, code: kit.code, rerun }
  })
}

/** A base64 file over the cap, in plain words with the limit. */
export const tooBigForBase64 = (o: ResolvedOptions) => {
  const bytes = maxBase64Of(o)
  const limit = bytes >= 1_000_000 ? `${Math.floor(bytes / 100_000) / 10} MB` : `${Math.max(1, Math.floor(bytes / 1000))} KB`
  return new KitError('uploadTooBig', `The file is too big to send here (the limit is ${limit}). Results are one sample per file; if yours is one sample, contact us.`, { limit })
}

/** A batch is complete once every kit in it has a result. */
async function completeBatchIfDone(req: PayloadRequest, o: ResolvedOptions, site: string | undefined, batchId: string | null) {
  if (!batchId) return
  const kits = (await req.payload.find({ collection: 'kits', where: scoped(o, site, { labBatch: { equals: batchId } }), ...READ, req })).docs as unknown as KitDoc[]
  if (kits.length && kits.every((k) => ['results-in', 'analysis', 'released'].includes(k.status)))
    await req.payload.update({ collection: 'lab-batches', id: batchId, data: { status: 'complete' } as never, overrideAccess: true, depth: 0, req: sysReq(req, audit('lab batch complete')) })
}

// ---------------------------------------------------------------- the keeper's view

/**
 * A kit's result, for its keeper (whoever activated it) and kit staff only. Anyone else, the buyer of a gift, a lab
 * and a stranger included, gets null, and the results provider isn't asked. The provider's own answer is final
 * beyond that: it may still say null.
 */
export async function resultView(req: PayloadRequest, input: { code: string }): Promise<ResultView | null> {
  const o = optionsOf(req.payload)
  const me = personOf(o, req)
  if (!me || !o.results) return null
  let site: string | undefined
  try {
    site = await siteOf(o, req)
  } catch {
    return null
  }
  const kit = await findKit(req, String(input?.code ?? ''), site)
  if (!kit) return null
  const keeper = idOf(kit.activatedBy) === String(me.id)
  if (!keeper && !(await isStaff(o, req))) return null
  const { secretHash: _secret, ...plain } = kit
  return (await o.results.view({ kit: plain as KitDoc, user: me, req })) ?? null
}

