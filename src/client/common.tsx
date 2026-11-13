'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import type { ServerResult } from '../server/result.js'
import { FIELD, TARGET } from '../ui/slots.js'
import { tx, type UiText } from '../ui/text.js'

/** A server action as the components take it: the site's route, wrapping one of `./server`'s functions. */
export type Action<I, O> = (input: I) => Promise<ServerResult<O>>

/** What the last run said, for the live regions. */
export type Said = { kind: 'status' | 'error'; message: string } | null

const messageOf = (data: unknown): string | null => (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string' ? (data as { message: string }).message : null)

/**
 * Runs an action once at a time: `busy` while it runs, then a status or an error to announce. A network failure or a
 * thrown action is shown in plain words, never as a stack.
 */
export function useRun(text?: Partial<UiText>) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Said>(null)
  const running = useRef(false)
  const run = useCallback(
    async <I, O>(action: Action<I, O>, input: I): Promise<ServerResult<O> | null> => {
      if (running.current) return null
      running.current = true
      setBusy(true)
      setSaid(null)
      try {
        const r = await action(input)
        if (r && r.ok) setSaid({ kind: 'status', message: messageOf(r.data) ?? tx(text, 'done') })
        else setSaid({ kind: 'error', message: r?.error?.message ?? tx(text, 'tryAgain') })
        return r
      } catch {
        setSaid({ kind: 'error', message: `${tx(text, 'notDone')}. ${tx(text, 'tryAgain')}.` })
        return null
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [text],
  )
  return { busy, said, setSaid, run }
}

/**
 * The two live regions every component keeps on the page from the start (so screen readers hear each change):
 * `role="status"` for progress and success, `role="alert"` for errors. Each message starts with a word, so its meaning
 * never rests on color.
 */
export function LiveRegions({ said, busy, text }: { said: Said; busy?: boolean; text?: Partial<UiText> }) {
  return (
    <>
      <div role="status" aria-live="polite" className="sk-status">
        {busy ? <p>{tx(text, 'working')}</p> : said?.kind === 'status' ? <p>{said.message}</p> : null}
      </div>
      <div role="alert" className="sk-error">
        {said?.kind === 'error' ? (
          <p>
            <strong>{tx(text, 'notDone')}:</strong> {said.message}
          </p>
        ) : null}
      </div>
    </>
  )
}

/**
 * A button that runs one action. With `confirm`, the first press asks in the page (not a browser dialog), and focus
 * moves to the question; "Cancel" puts it back.
 */
export function ActionButton<O>({ action, label, confirm, text, onDone }: { action: Action<void, O>; label: string; confirm?: string; text?: Partial<UiText>; onDone?: (data: O) => void }) {
  const { busy, said, run } = useRun(text)
  const qid = useId()
  const [asking, setAsking] = useState(false)
  const questionRef = useRef<HTMLParagraphElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (asking) questionRef.current?.focus()
  }, [asking])
  const go = async () => {
    setAsking(false)
    const r = await run(action, undefined as void)
    if (r?.ok) onDone?.(r.data)
  }
  return (
    <div className="sk-action">
      {asking ? (
        <div role="group" aria-labelledby={qid}>
          <p id={qid} tabIndex={-1} ref={questionRef}>
            {tx(text, 'areYouSure', { what: confirm ?? '' })}
          </p>
          <button type="button" style={TARGET} onClick={go} disabled={busy}>
            {tx(text, 'confirm')}
          </button>{' '}
          <button
            type="button"
            style={TARGET}
            onClick={() => {
              setAsking(false)
              requestAnimationFrame(() => buttonRef.current?.focus())
            }}
          >
            {tx(text, 'cancel')}
          </button>
        </div>
      ) : (
        <button type="button" ref={buttonRef} style={TARGET} disabled={busy} aria-busy={busy || undefined} onClick={() => (confirm ? setAsking(true) : go())}>
          {label}
        </button>
      )}
      <LiveRegions said={said} busy={busy} text={text} />
    </div>
  )
}

/** One field of an `ActionForm`, as plain data (so a server page can describe it). */
export type FieldSpec = {
  name: string
  label: string
  type: 'text' | 'number' | 'date' | 'textarea' | 'select' | 'checkbox' | 'hidden'
  help?: string
  required?: boolean
  value?: string
  options?: { value: string; label: string }[]
  inputMode?: 'numeric' | 'text'
}

/** What a form's fields become: numbers as numbers, checkboxes as true/false, the rest as trimmed text. */
export function formValues(form: HTMLFormElement, fields: FieldSpec[]): Record<string, unknown> {
  const data = new FormData(form)
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = data.get(f.name)
    if (f.type === 'checkbox') out[f.name] = raw === 'on'
    else if (f.type === 'number') out[f.name] = raw === null || String(raw).trim() === '' ? null : Number(raw)
    else out[f.name] = raw === null ? '' : String(raw).trim()
  }
  return out
}

/**
 * A labeled form for one action. Every field has a visible label and its help tied to it; a refusal is announced and
 * the first field gets focus again, so the person can fix it.
 */
export function ActionForm<I, O>({ action, fields, submit, text, onDone, resetOnDone = true, children }: { action: Action<I, O>; fields: FieldSpec[]; submit: string; text?: Partial<UiText>; onDone?: (data: O) => void; resetOnDone?: boolean; children?: ReactNode }) {
  const base = useId()
  const { busy, said, run } = useRun(text)
  const formRef = useRef<HTMLFormElement | null>(null)
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const r = await run(action, formValues(form, fields) as I)
    if (r?.ok) {
      if (resetOnDone) form.reset()
      onDone?.(r.data)
    } else (form.querySelector('input:not([type=hidden]), select, textarea') as HTMLElement | null)?.focus()
  }
  return (
    <form ref={formRef} onSubmit={onSubmit} className="sk-form" aria-busy={busy || undefined}>
      {fields.map((f) => {
        const id = `${base}-${f.name}`
        const helpId = f.help ? `${id}-help` : undefined
        if (f.type === 'hidden') return <input key={f.name} type="hidden" name={f.name} value={f.value ?? ''} />
        if (f.type === 'checkbox')
          return (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 44 }}>
              <input type="checkbox" id={id} name={f.name} required={f.required} aria-describedby={helpId} style={{ width: 24, height: 24 }} />
              <label htmlFor={id}>{f.label}</label>
              {f.help ? <p id={helpId}>{f.help}</p> : null}
            </div>
          )
        return (
          <div key={f.name} className="sk-field" style={{ marginBlock: '0.75rem' }}>
            <label htmlFor={id} style={{ display: 'block', fontWeight: 600 }}>
              {f.label}
            </label>
            {f.type === 'textarea' ? (
              <textarea id={id} name={f.name} required={f.required} aria-describedby={helpId} defaultValue={f.value} rows={3} style={FIELD} />
            ) : f.type === 'select' ? (
              <select id={id} name={f.name} required={f.required} aria-describedby={helpId} defaultValue={f.value ?? ''} style={FIELD}>
                {!f.value ? <option value="">—</option> : null}
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input id={id} name={f.name} type={f.type} required={f.required} aria-describedby={helpId} defaultValue={f.value} inputMode={f.inputMode} autoComplete="off" style={FIELD} />
            )}
            {f.help ? <p id={helpId}>{f.help}</p> : null}
          </div>
        )
      })}
      {children}
      <button type="submit" style={TARGET} disabled={busy}>
        {submit}
      </button>
      <LiveRegions said={said} busy={busy} text={text} />
    </form>
  )
}
