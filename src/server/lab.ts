import type { PayloadRequest } from 'payload'

import { confirmBatchReceived, labPortal, labsFor, type PortalBatch } from '../lab.js'
import { matchResults, maxBase64Of, receiveResult, RESULT_EXTENSIONS, tooBigForBase64, uploadLimitOf, type ResultMatch } from '../results.js'
import { KitError } from '../internal.js'
import { KIT_STATUS_LABELS, type KitStatus } from '../status.js'
import { say, serve, text, type ServerResult } from './result.js'

/**
 * Server functions for the lab portal (`/lab`): the lab's portal users and kit staff. What a lab sees is only what
 * `labPortal` reads out: kit codes, statuses and markers. Never a buyer, a keeper, an address, a subject or a result.
 */

export type LabPageData = {
  labs: { id: string; name: string }[]
  /** The lab shown, or null when the person must choose one (or has none). */
  lab: { id: string; name: string; fileNaming: string | null } | null
  batches: PortalBatch[]
  /**
   * How files go up: `fileId` when the site set `results.verifyUpload` (the page's uploader puts the file in the site's
   * storage first and sends its id), else `base64` through the action. `maxBytes` is the largest file either way.
   */
  upload: { extensions: string[]; maxBytes: number; by: 'fileId' | 'base64' }
}

/** `/lab`: the labs this person works for, and the chosen one's batches. Anyone with no lab gets the same refusal. */
export function labPage(req: PayloadRequest, input: { lab?: string } = {}): Promise<ServerResult<LabPageData>> {
  return serve(req, async (o) => {
    const labs = await labsFor(req)
    if (!labs.length) throw new KitError('notLab', 'This page is for the labs we work with. If you work at one, ask us to add you to its portal.')
    const wanted = input?.lab ? text(input.lab, 64) : labs.length === 1 ? labs[0]!.id : null
    const upload = { extensions: o.results?.extensions ?? [...RESULT_EXTENSIONS], maxBytes: uploadLimitOf(o), by: o.results?.verifyUpload ? ('fileId' as const) : ('base64' as const) }
    if (!wanted) return { labs, lab: null, batches: [], upload }
    const portal = await labPortal(req, { lab: wanted })
    return { labs, lab: portal.lab, batches: portal.batches, upload }
  })
}

/** The lab says a shipped batch arrived. */
export function submitBatchReceived(req: PayloadRequest, input: { batch: string }): Promise<ServerResult<{ kits: number; already: boolean; message: string }>> {
  return serve(req, async (o) => {
    const r = await confirmBatchReceived(req, { batch: text(input?.batch, 64) })
    return { ...r, message: r.already ? say(o, 'lab.alreadyReceived', 'This batch was already marked as received.') : say(o, 'lab.received', 'Thanks. Kits marked as at the lab: {n}.', { n: r.kits }) }
  })
}

export type PreviewRow = ResultMatch & { explanation: string }

const REASON_WORDS: Record<NonNullable<ResultMatch['reason']>, string> = {
  noCode: 'No kit code in the file name or the first line. Rename the file to start with the kit code.',
  notThisLab: 'That kit wasn’t sent to this lab. Check the code.',
  conflict: 'The file name and the first line name different kits. Fix one so they match.',
  notReady: 'That kit can’t take a result now (it’s {status}). Contact us if that looks wrong.',
  tooBig: 'The file is too big. Results are one sample per file.',
  fileType: 'Not a result file. Use a FASTA or plain text file.',
}

/** Which kit each chosen file is for, before anything is sent. Writes nothing. */
export function previewResultFiles(req: PayloadRequest, input: { lab: string; items: { name: string; header?: string | null; sha256?: string | null; size?: number | null }[] }): Promise<ServerResult<{ matches: PreviewRow[] }>> {
  return serve(req, async (o) => {
    const matches = await matchResults(req, { lab: text(input?.lab, 64), items: Array.isArray(input?.items) ? input.items.slice(0, 1000) : [] })
    return {
      matches: matches.map((m) => ({
        ...m,
        explanation:
          m.outcome === 'ready'
            ? say(o, 'lab.outcome.ready', 'Ready to send.')
            : m.outcome === 'rerun'
              ? say(o, 'lab.outcome.rerun', 'Ready to send, as a re-run: this kit already has a result.')
              : m.outcome === 'already'
                ? say(o, 'lab.outcome.already', 'Already received. It won’t be sent again.')
                : say(o, `lab.reason.${m.reason ?? 'noCode'}`, REASON_WORDS[m.reason ?? 'noCode'], { status: m.status ? (KIT_STATUS_LABELS[m.status as KitStatus] ?? m.status).toLowerCase() : '' }),
      })),
    }
  })
}

export type UploadAnswer = { result: 'received' | 'already' | 'refused' | 'unmatched'; code: string | null; rerun: boolean; message: string }

/**
 * One confirmed result file. With `results.verifyUpload`, `{ lab, fileId }`: the file is already in the site's storage,
 * and bytes are refused (`uploadById`). Without it, `{ lab, name, data }`, with `data` as bytes or base64, up to
 * `results.maxBase64Bytes` (`uploadTooBig` past it), and a file id is refused. Matched again on the server, checked,
 * handed to `results.accept` and recorded, in one transaction.
 */
export function submitResultFile(req: PayloadRequest, input: { lab: string; name: string; data: Uint8Array | string } | { lab: string; fileId: string }): Promise<ServerResult<UploadAnswer>> {
  return serve(req, async (o) => {
    const lab = text(input?.lab, 64)
    const byId = Boolean(o.results?.verifyUpload)
    const given = (input ?? {}) as { name?: unknown; data?: unknown; fileId?: unknown }
    let r
    if (byId || given.fileId !== undefined) {
      if (byId && given.data !== undefined) throw new KitError('uploadById', 'Files are uploaded to storage first here, then sent by their id. Reload the page and send the file again.')
      r = await receiveResult(req, { lab, fileId: text(given.fileId, 200) })
    } else {
      const raw = given.data
      const cap = maxBase64Of(o)
      // Measured on the text before it's decoded, so an oversized body is never turned into bytes.
      if (typeof raw === 'string' && raw.length > Math.ceil((cap * 4) / 3) + 4) throw tooBigForBase64(o)
      const data = raw instanceof Uint8Array ? raw : typeof raw === 'string' ? new Uint8Array(Buffer.from(raw, 'base64')) : null
      if (!data || !data.byteLength) throw new KitError('noFile', 'No file came through. Choose the file again.')
      if (data.byteLength > cap) throw tooBigForBase64(o)
      if (data.byteLength > uploadLimitOf(o)) throw new KitError('tooBig', 'The file is too big. Results are one sample per file.')
      r = await receiveResult(req, { lab, name: text(given.name, 300), data })
    }
    if (r.result === 'received') return { result: 'received', code: r.code, rerun: r.rerun, message: r.rerun ? say(o, 'lab.rerunIn', 'Kit {code}: re-run received.', { code: r.code }) : say(o, 'lab.resultIn', 'Kit {code}: result received.', { code: r.code }) }
    if (r.result === 'already') return { result: 'already', code: r.code, rerun: false, message: say(o, 'lab.outcome.already', 'Already received. It won’t be sent again.') }
    if (r.result === 'refused') return { result: 'refused', code: r.code, rerun: false, message: say(o, 'lab.refused', 'Kit {code}: not taken. {reason}', { code: r.code, reason: r.message }) }
    const m = r.match
    return { result: 'unmatched', code: m.code, rerun: false, message: say(o, `lab.reason.${m.reason ?? 'noCode'}`, REASON_WORDS[m.reason ?? 'noCode'], { status: m.status ? (KIT_STATUS_LABELS[m.status as KitStatus] ?? m.status).toLowerCase() : '' }) }
  })
}
