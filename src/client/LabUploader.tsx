'use client'

import { useId, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'

import type { PreviewRow, UploadAnswer } from '../server/lab.js'
import { FIELD, TARGET } from '../ui/slots.js'
import { tx, type UiText } from '../ui/text.js'
import { LiveRegions, useRun, type Action } from './common.js'

export type LabUploaderActions = {
  preview: Action<{ lab: string; items: { name: string; header: string | null; sha256: string | null; size: number }[] }, { matches: PreviewRow[] }>
  upload: Action<{ lab: string; name: string; data: string } | { lab: string; fileId: string }, UploadAnswer>
}

/**
 * The site's own client uploader, for uploads by file id (`results.verifyUpload`): puts one file in the site's private
 * storage and answers its id. Pass it from a `'use client'` wrapper of the site's, since functions can't come from a
 * server component. A throw shows a plain "couldn't be uploaded" for that file.
 */
export type ResultUploader = (file: { name: string; type: string; data: Uint8Array }) => Promise<{ fileId: string }>

export type LabUploaderProps = { lab: string; upload: { extensions: string[]; maxBytes: number; by?: 'fileId' | 'base64' }; actions: LabUploaderActions; text?: Partial<UiText>; uploader?: ResultUploader }

/** Most files from one choice, and the most bytes, so a phone doesn't run out of memory. */
const MAX_FILES = 1000
const MAX_TOTAL = 100 * 1024 * 1024

type Entry = { name: string; type: string; data: Uint8Array }

const headerOf = (data: Uint8Array) => {
  const first = new TextDecoder().decode(data.subarray(0, 400)).replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  return first.startsWith('>') ? first : null
}
async function sha256(data: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const buf = await subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** Base64, in chunks, so a large file doesn't overflow the call stack. */
export function toBase64(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(s)
}
const sizeWords = (bytes: number) => (bytes >= 1_000_000 ? `${Math.round(bytes / 100_000) / 10} MB` : `${Math.round(bytes / 1000)} KB`)

/**
 * Result upload for the lab portal: choose files, see which kit each is for and why any can't go, then send. Nothing is
 * written before "Send"; each file then goes up on its own and is matched again on the server. Files stay in memory
 * only.
 */
export function LabUploader({ lab, upload, actions, text, uploader }: LabUploaderProps) {
  const base = useId()
  const [entries, setEntries] = useState<Entry[]>([])
  const [matches, setMatches] = useState<PreviewRow[] | null>(null)
  const [results, setResults] = useState<{ name: string; answer: UploadAnswer | null; error: string | null }[] | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const { busy, said, setSaid, run } = useRun(text)
  const summary = useRef<HTMLParagraphElement | null>(null)

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    setResults(null)
    setMatches(null)
    if (!files.length) return
    setProgress(tx(text, 'reading'))
    try {
      if (files.length > MAX_FILES || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new Error('too many')
      const list: Entry[] = []
      for (const f of files) list.push({ name: f.name, type: f.type, data: new Uint8Array(await f.arrayBuffer()) })
      const items = []
      for (const x of list) items.push({ name: x.name, header: headerOf(x.data), sha256: await sha256(x.data), size: x.data.byteLength })
      const r = await run(actions.preview, { lab, items })
      setProgress(null)
      if (!r?.ok) return
      setEntries(list)
      setMatches(r.data.matches)
      setSaid({ kind: 'status', message: r.data.matches.some((m) => m.outcome === 'ready' || m.outcome === 'rerun') ? tx(text, 'sendFiles', { n: r.data.matches.filter((m) => m.outcome === 'ready' || m.outcome === 'rerun').length }) : tx(text, 'noFilesToSend') })
    } catch {
      setProgress(null)
      setSaid({ kind: 'error', message: tx(text, 'unreadable') })
    }
  }

  const toSend = (matches ?? []).map((m, i) => ({ m, e: entries[i]! })).filter(({ m }) => m.outcome === 'ready' || m.outcome === 'rerun')

  const send = async () => {
    const out: { name: string; answer: UploadAnswer | null; error: string | null }[] = []
    for (const [i, { e }] of toSend.entries()) {
      setProgress(tx(text, 'sending', { n: i + 1, of: toSend.length }))
      let input: { lab: string; name: string; data: string } | { lab: string; fileId: string }
      if (upload.by === 'fileId') {
        // The file goes to the site's storage first; only its id goes through the action.
        const stored = uploader ? await uploader({ name: e.name, type: e.type, data: e.data }).catch(() => null) : null
        if (!stored || typeof stored.fileId !== 'string' || !stored.fileId) {
          out.push({ name: e.name, answer: null, error: tx(text, 'uploadFailed') })
          continue
        }
        input = { lab, fileId: stored.fileId }
      } else input = { lab, name: e.name, data: toBase64(e.data) }
      const r = await run(actions.upload, input)
      out.push({ name: e.name, answer: r?.ok ? r.data : null, error: r && !r.ok ? r.error.message : r ? null : tx(text, 'tryAgain') })
    }
    setProgress(null)
    setResults(out)
    setMatches(null)
    setEntries([])
    const failed = out.filter((x) => !x.answer || x.answer.result === 'refused' || x.answer.result === 'unmatched').length
    setSaid({ kind: failed ? 'error' : 'status', message: tx(text, 'sent', { n: out.length - failed, failed }) })
    requestAnimationFrame(() => summary.current?.focus())
  }

  return (
    <section className="sk-upload" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{tx(text, 'uploadTitle')}</h2>
      <label htmlFor={`${base}-files`} style={{ display: 'block', fontWeight: 600 }}>
        {tx(text, 'chooseFiles')}
      </label>
      <input id={`${base}-files`} type="file" multiple accept={upload.extensions.join(',')} onChange={choose} disabled={busy} aria-describedby={`${base}-help`} style={FIELD} />
      <p id={`${base}-help`}>{tx(text, 'chooseHelp', { size: sizeWords(upload.maxBytes) })}</p>
      {progress ? <p aria-hidden="true">{progress}</p> : null}
      {matches?.length ? (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption>{tx(text, 'outcome')}</caption>
              <thead>
                <tr>
                  <th scope="col">{tx(text, 'fileName')}</th>
                  <th scope="col">{tx(text, 'forKit')}</th>
                  <th scope="col">{tx(text, 'outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => (
                  <tr key={`${m.name}-${i}`} data-outcome={m.outcome}>
                    <th scope="row" style={{ wordBreak: 'break-all' }}>
                      {m.name}
                    </th>
                    <td>{m.code ?? '—'}</td>
                    <td>{m.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {toSend.length ? (
            <button type="button" style={TARGET} onClick={send} disabled={busy}>
              {tx(text, 'sendFiles', { n: toSend.length })}
            </button>
          ) : null}
        </>
      ) : null}
      {results ? (
        <>
          <p ref={summary} tabIndex={-1}>
            {tx(text, 'sent', { n: results.filter((x) => x.answer && (x.answer.result === 'received' || x.answer.result === 'already')).length, failed: results.filter((x) => !x.answer || x.answer.result === 'refused' || x.answer.result === 'unmatched').length })}
          </p>
          <ul>
            {results.map((x, i) => (
              <li key={`${x.name}-${i}`}>
                <strong>{x.answer && (x.answer.result === 'received' || x.answer.result === 'already') ? tx(text, 'done') : tx(text, 'notDone')}:</strong> {x.name}: {x.answer?.message ?? x.error}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <LiveRegions said={progress ? { kind: 'status', message: progress } : said} busy={false} text={text} />
    </section>
  )
}
