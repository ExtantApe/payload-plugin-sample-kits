'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { code128SVG } from '../barcode.js'
import { FIELD, LINK_TARGET, TARGET } from '../ui/slots.js'
import { keyOf, tx, type UiText } from '../ui/text.js'
import { LiveRegions, useRun, type Action } from './common.js'

type Outcome = { outcome: string; message: string }

/**
 * "Request a refund" / "Get help with this order": the reasons as checkboxes in a fieldset, optional details, and the
 * amount kept back shown in words (the site's price line, rendered on the server) before anything is sent.
 */
export function OrderHelpForm({ order, reasons, keptBackCents, keptBackLine, action, text }: { order: string; reasons: string[]; keptBackCents: number; keptBackLine?: ReactNode; action: Action<{ order: string; reasons: string[]; details: string; confirmKeptBack: number }, Outcome>; text?: Partial<UiText> }) {
  const base = useId()
  const { busy, said, run } = useRun(text)
  const [sent, setSent] = useState(false)
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const chosen = data.getAll('reason').map(String)
    const r = await run(action, { order, reasons: chosen, details: String(data.get('details') ?? '').trim(), confirmKeptBack: keptBackCents })
    if (r?.ok) setSent(true)
    else (e.currentTarget.querySelector('input[type=checkbox]') as HTMLElement | null)?.focus()
  }
  return (
    <form onSubmit={onSubmit} className="sk-help" aria-busy={busy || undefined}>
      <fieldset disabled={sent} aria-describedby={`${base}-help`}>
        <legend>{tx(text, 'reasons')}</legend>
        <p id={`${base}-help`}>{tx(text, 'reasonsHelp')}</p>
        {reasons.map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 44 }}>
            <input type="checkbox" id={`${base}-${r}`} name="reason" value={r} style={{ width: 24, height: 24 }} />
            <label htmlFor={`${base}-${r}`}>{tx(text, keyOf('reason_', r))}</label>
          </div>
        ))}
      </fieldset>
      <div style={{ marginBlock: '0.75rem' }}>
        <label htmlFor={`${base}-details`} style={{ display: 'block', fontWeight: 600 }}>
          {tx(text, 'helpDetails')}
        </label>
        <textarea id={`${base}-details`} name="details" rows={3} maxLength={1000} disabled={sent} style={FIELD} />
      </div>
      {keptBackCents > 0 && keptBackLine ? (
        <p>
          {tx(text, 'keptBack')} {keptBackLine}
        </p>
      ) : null}
      <button type="submit" style={TARGET} disabled={busy || sent}>
        {tx(text, 'sendRequest')}
      </button>
      <LiveRegions said={said} busy={busy} text={text} />
    </form>
  )
}

/** After a missed pre-order date: one choice from a radio group, with where the vote goes when moving it. */
export function MissedChoiceForm({ order, choices, action, text }: { order: string; choices: string[]; action: Action<{ order: string; choice: string; item?: string }, Outcome>; text?: Partial<UiText> }) {
  const base = useId()
  const { busy, said, run } = useRun(text)
  const [choice, setChoice] = useState('')
  const [sent, setSent] = useState(false)
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const item = String(new FormData(e.currentTarget).get('item') ?? '').trim()
    const r = await run(action, { order, choice, ...(choice === 'reallocate' && item ? { item } : {}) })
    if (r?.ok) setSent(true)
  }
  return (
    <form onSubmit={onSubmit} className="sk-missed" aria-busy={busy || undefined}>
      <fieldset disabled={sent}>
        <legend>{tx(text, 'missedHelp')}</legend>
        {choices.map((c) => (
          <div key={c} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 44 }}>
            <input type="radio" id={`${base}-${c}`} name="choice" value={c} required checked={choice === c} onChange={() => setChoice(c)} style={{ width: 24, height: 24 }} />
            <label htmlFor={`${base}-${c}`}>{tx(text, keyOf('choice_', c))}</label>
          </div>
        ))}
        {choice === 'reallocate' ? (
          <div style={{ marginBlock: '0.75rem' }}>
            <label htmlFor={`${base}-item`} style={{ display: 'block', fontWeight: 600 }}>
              {tx(text, 'voteItem')}
            </label>
            <input id={`${base}-item`} name="item" required autoComplete="off" style={FIELD} />
          </div>
        ) : null}
      </fieldset>
      <button type="submit" style={TARGET} disabled={busy || sent || !choice}>
        {tx(text, 'choose')}
      </button>
      <LiveRegions said={said} busy={busy} text={text} />
    </form>
  )
}

/** The keeper's return label: fetched on request, then a link to open it. */
export function ReturnLabelButton({ code, action, text }: { code: string; action: Action<{ code: string; extra?: boolean }, { labelUrl: string; message: string }>; text?: Partial<UiText> }) {
  const { busy, said, run } = useRun(text)
  const [url, setUrl] = useState<string | null>(null)
  const link = useRef<HTMLAnchorElement | null>(null)
  useEffect(() => {
    if (url) link.current?.focus()
  }, [url])
  return (
    <div className="sk-return-label">
      <button type="button" style={TARGET} disabled={busy} onClick={async () => {
        const r = await run(action, { code })
        if (r?.ok && r.data.labelUrl) setUrl(r.data.labelUrl)
      }}>
        {tx(text, 'getReturnLabel')}
      </button>
      {url ? (
        <p>
          <a ref={link} href={url} target="_blank" rel="noopener noreferrer" style={LINK_TARGET}>
            {tx(text, 'openLabel')} {tx(text, 'opensNewTab')}
          </a>
        </p>
      ) : null}
      <LiveRegions said={said} busy={busy} text={text} />
    </div>
  )
}

export type SlipKitView = { code: string; secret: string; link: string | null; label: string | null }

/**
 * Make the order's slip: asks first (a new slip cancels older printouts), then shows each kit's code as a barcode, its
 * secret and its link, ready to print. The secrets are in this page's memory only and gone when it's left.
 */
export function SlipMaker({ order, action, text }: { order: string; action: Action<{ order: string }, { kits: SlipKitView[] }>; text?: Partial<UiText> }) {
  const { busy, said, run } = useRun(text)
  const [asking, setAsking] = useState(false)
  const [kits, setKits] = useState<SlipKitView[] | null>(null)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const question = useRef<HTMLParagraphElement | null>(null)
  useEffect(() => {
    if (kits) heading.current?.focus()
  }, [kits])
  useEffect(() => {
    if (asking) question.current?.focus()
  }, [asking])
  const go = async () => {
    setAsking(false)
    const r = await run(action, { order })
    if (r?.ok) setKits(r.data.kits)
  }
  return (
    <div className="sk-slip">
      {asking ? (
        <div role="group">
          <p ref={question} tabIndex={-1}>
            {tx(text, 'areYouSure', { what: tx(text, 'makeSlipConfirm') })}
          </p>
          <button type="button" style={TARGET} onClick={go}>
            {tx(text, 'confirm')}
          </button>{' '}
          <button type="button" style={TARGET} onClick={() => setAsking(false)}>
            {tx(text, 'cancel')}
          </button>
        </div>
      ) : (
        <button type="button" style={TARGET} disabled={busy} onClick={() => setAsking(true)}>
          {tx(text, 'makeSlip')}
        </button>
      )}
      <LiveRegions said={said} busy={busy} text={text} />
      {kits ? (
        <section aria-labelledby="sk-slip-h">
          <h2 id="sk-slip-h" ref={heading} tabIndex={-1}>
            {tx(text, 'slipTitle')}
          </h2>
          <p>{tx(text, 'slipHelp')}</p>
          <button type="button" style={TARGET} onClick={() => window.print()}>
            {tx(text, 'print')}
          </button>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {kits.map((k) => (
              <li key={k.code} style={{ breakInside: 'avoid', marginBlock: '1rem' }}>
                <div style={{ height: 48, maxWidth: 320 }} dangerouslySetInnerHTML={{ __html: code128SVG(k.code, { title: `Kit ${k.code}` }) }} />
                <p>
                  {tx(text, 'kitCode')}: <span style={{ fontFamily: 'monospace' }}>{k.code}</span>
                  {k.label ? ` (${k.label})` : ''}
                </p>
                <p>
                  {tx(text, 'secret')}: <span style={{ fontFamily: 'monospace', fontSize: '1.25rem' }}>{k.secret}</span>
                </p>
                {k.link ? (
                  <p style={{ wordBreak: 'break-all' }}>
                    {tx(text, 'activateAt')}: {k.link}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
