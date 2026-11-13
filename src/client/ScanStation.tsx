'use client'

import { useId, useRef, useState } from 'react'
import type { ComponentType, FormEvent } from 'react'

import type { ScanAnswer } from '../server/staff.js'
import { FIELD, TARGET } from '../ui/slots.js'
import { tx, type UiText } from '../ui/text.js'
import { LiveRegions, useRun, type Action } from './common.js'

/** One thing a scan can do, e.g. receive or look up. */
export type ScanMode = { key: string; label: string; action: Action<{ code: string } & Record<string, string>, ScanAnswer> }

/** The site's camera button (Scan's `CameraScanButton`, through the site's own client wrapper): it calls `onCode`. */
export type CameraSlot = ComponentType<{ onCode: (code: string) => void }>

type LogLine = { id: number; word: 'done' | 'already' | 'warning' | 'notDone'; message: string }

/**
 * A scan station for a USB scanner (it types the code and presses Enter) or typed codes, with an optional camera.
 * Each scan is announced, and kept in a list on the page, newest first, each line starting with what happened in
 * words. The field is cleared and focused again after each scan, so the next one can follow at once.
 */
export function ScanStation({ modes, initialMode, extra = {}, hubs, text, Camera }: { modes: ScanMode[]; initialMode?: string; extra?: Record<string, string>; hubs?: { id: string; name: string }[]; text?: Partial<UiText>; Camera?: CameraSlot }) {
  const base = useId()
  const [mode, setMode] = useState(initialMode && modes.some((m) => m.key === initialMode) ? initialMode : (modes[0]?.key ?? ''))
  const [hub, setHub] = useState(hubs?.[0]?.id ?? '')
  const [log, setLog] = useState<LogLine[]>([])
  const { busy, said, run } = useRun(text)
  const input = useRef<HTMLInputElement | null>(null)
  const counter = useRef(0)

  const scan = async (raw: string) => {
    const code = raw.trim()
    const current = modes.find((m) => m.key === mode)
    if (!code || !current) return
    const r = await run(current.action, { ...extra, ...(hubs && mode === 'checkIn' && hub ? { hub } : {}), code })
    const line: LogLine = r?.ok
      ? { id: ++counter.current, word: r.data.outcome === 'done' ? 'done' : r.data.outcome === 'already' ? 'already' : 'warning', message: r.data.message }
      : { id: ++counter.current, word: 'notDone', message: r && !r.ok ? r.error.message : tx(text, 'tryAgain') }
    setLog((l) => [line, ...l].slice(0, 200))
    if (input.current) {
      input.current.value = ''
      input.current.focus()
    }
  }
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void scan(input.current?.value ?? '')
  }
  const words = { done: tx(text, 'done'), already: tx(text, 'already'), warning: tx(text, 'warning'), notDone: tx(text, 'notDone') }

  return (
    <section className="sk-scan" aria-labelledby={`${base}-h`}>
      <form onSubmit={onSubmit} aria-busy={busy || undefined}>
        {modes.length > 1 ? (
          <fieldset>
            <legend id={`${base}-h`}>{tx(text, 'scanMode')}</legend>
            {modes.map((m) => (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 44 }}>
                <input type="radio" id={`${base}-${m.key}`} name={`${base}-mode`} value={m.key} checked={mode === m.key} onChange={() => setMode(m.key)} style={{ width: 24, height: 24 }} />
                <label htmlFor={`${base}-${m.key}`}>{m.label}</label>
              </div>
            ))}
          </fieldset>
        ) : (
          <h2 id={`${base}-h`}>{modes[0]?.label}</h2>
        )}
        {hubs && mode === 'checkIn' ? (
          <div style={{ marginBlock: '0.75rem' }}>
            <label htmlFor={`${base}-hub`} style={{ display: 'block', fontWeight: 600 }}>
              {tx(text, 'hub')}
            </label>
            <select id={`${base}-hub`} value={hub} onChange={(e) => setHub(e.target.value)} style={FIELD}>
              {hubs.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div style={{ marginBlock: '0.75rem' }}>
          <label htmlFor={`${base}-code`} style={{ display: 'block', fontWeight: 600 }}>
            {tx(text, 'kitCode')}
          </label>
          <input ref={input} id={`${base}-code`} name="code" inputMode="numeric" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby={`${base}-help`} required style={FIELD} />
          <p id={`${base}-help`}>{tx(text, 'kitCodeHelp')}</p>
        </div>
        <button type="submit" style={TARGET} disabled={busy}>
          {tx(text, 'scanSubmit')}
        </button>{' '}
        {Camera ? <Camera onCode={(c) => void scan(c)} /> : null}
        <LiveRegions said={said} busy={busy} text={text} />
      </form>
      {log.length ? (
        <>
          <h3 id={`${base}-log`}>{tx(text, 'scanLog')}</h3>
          <ol aria-labelledby={`${base}-log`} reversed className="sk-scan-log">
            {log.map((l) => (
              <li key={l.id} data-outcome={l.word}>
                <strong>{words[l.word]}:</strong> {l.message}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  )
}
