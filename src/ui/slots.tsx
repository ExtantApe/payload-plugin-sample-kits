import type { ComponentType, CSSProperties, ReactNode } from 'react'

import type { ResultView, Subject } from '../types.js'
import { tx, type UiText } from './text.js'

/**
 * The site's slots. Each has a plain default here, so every page works on its own; a site passes its own to match its
 * design. Slots that are components (`Shell`, `Empty`, `Price`, `ResultCard`) are used by the server pages; slots the
 * browser needs (`SubjectPicker`, `Wizard`, `Camera`) go through the site's own client wrapper, since a component
 * can't be sent from the server to the browser.
 */

/** One item of the page's menu. */
export type NavItem = { key: string; label: string; href: string }

/** The page shell and menu. `nav` is the plugin's menu for the page; the site may show its own instead. */
export type ShellProps = { title: string; intro?: string; nav?: readonly NavItem[]; current?: string; children: ReactNode }
export type ShellSlot = ComponentType<ShellProps>

/** The empty state. `action` is a link. */
export type EmptyProps = { title: string; body?: string; action?: { href: string; label: string } }
export type EmptySlot = ComponentType<EmptyProps>

/** The price, currency and tax line: an amount in cents. `kind` says what it is, for the site's own wording. */
export type PriceProps = { cents: number; kind: 'refund' | 'kept-back' | 'paid'; currency?: string; locale?: string }
export type PriceSlot = ComponentType<PriceProps>

/** The result card: the keeper's result as the results provider gave it. */
export type ResultCardProps = { code: string; result: ResultView }
export type ResultCardSlot = ComponentType<ResultCardProps>

/**
 * The subject picker (animal and group). It's a form control: it must submit the chosen subject as `name`, its value
 * `<kind>:<id>`. Render it in the server page with the page's `choices`, and pass the element to the activation wizard.
 */
export type SubjectPickerProps = { name: string; choices: Subject[]; legend: string; help?: string; suggestedText: string; emptyText: string }
export type SubjectPickerSlot = ComponentType<SubjectPickerProps>

/** At least 44 by 44 CSS pixels: every button and link the plugin draws. */
export const TARGET: CSSProperties = { minHeight: 44, minWidth: 44, padding: '0.5rem 1rem', boxSizing: 'border-box' }
export const LINK_TARGET: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0.25rem 0' }
export const FIELD: CSSProperties = { display: 'block', width: '100%', maxWidth: '32rem', minHeight: 44, fontSize: '1rem', boxSizing: 'border-box' }

export function DefaultShell({ title, intro, nav, current, children }: ShellProps) {
  return (
    <main className="sk-page" style={{ maxWidth: '60rem', margin: '0 auto', padding: '1rem' }}>
      {nav?.length ? (
        <nav aria-label="Kit pages" className="sk-nav">
          <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1rem', listStyle: 'none', padding: 0, margin: 0 }}>
            {nav.map((n) => (
              <li key={n.key}>
                <a href={n.href} aria-current={n.key === current ? 'page' : undefined} style={{ ...LINK_TARGET, fontWeight: n.key === current ? 700 : 400 }}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <h1>{title}</h1>
      {intro ? <p>{intro}</p> : null}
      {children}
    </main>
  )
}

export function DefaultEmpty({ title, body, action }: EmptyProps) {
  return (
    <div className="sk-empty" role="note">
      <p>
        <strong>{title}</strong>
      </p>
      {body ? <p>{body}</p> : null}
      {action ? (
        <p>
          <a href={action.href} style={LINK_TARGET}>
            {action.label}
          </a>
        </p>
      ) : null}
    </div>
  )
}

export function DefaultPrice({ cents, currency = 'USD', locale = 'en-US' }: PriceProps) {
  return <span className="sk-price">{new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)}</span>
}

export function DefaultResultCard({ code, result }: ResultCardProps) {
  return (
    <section className="sk-result" aria-label={`Result for kit ${code}`}>
      <p>
        <strong>{result.status === 'ready' ? 'Ready' : result.status === 'review' ? 'Being checked' : 'Couldn’t be read'}</strong>
      </p>
      {result.summary ? <p>{result.summary}</p> : null}
    </section>
  )
}

export function DefaultSubjectPicker({ name, choices, legend, help, suggestedText, emptyText }: SubjectPickerProps) {
  if (!choices.length) return <p className="sk-no-subjects">{emptyText}</p>
  const helpId = `${name}-help`
  return (
    <fieldset className="sk-subjects" aria-describedby={help ? helpId : undefined}>
      <legend>{legend}</legend>
      {help ? <p id={helpId}>{help}</p> : null}
      {choices.map((c, i) => {
        const id = `${name}-${i}`
        return (
          <div key={`${c.ref.kind}:${c.ref.id}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: 44 }}>
            <input type="radio" id={id} name={name} value={`${c.ref.kind}:${c.ref.id}`} defaultChecked={c.suggested === true} required style={{ width: 24, height: 24 }} />
            <label htmlFor={id} style={{ flex: 1, padding: '0.5rem 0' }}>
              {c.label} {c.suggested ? <span>{suggestedText}</span> : null}
            </label>
          </div>
        )
      })}
    </fieldset>
  )
}

/** A page that couldn't load: the plain message, and a sign-in link when that's what's needed. */
export function PageProblem({ code, message, signInHref, text }: { code: string; message: string; signInHref?: string; text?: Partial<UiText> }) {
  return (
    <div role="alert" className="sk-problem">
      <p>{message}</p>
      {code === 'signIn' && signInHref ? (
        <p>
          <a href={signInHref} style={LINK_TARGET}>
            {tx(text, 'signIn')}
          </a>
        </p>
      ) : null}
    </div>
  )
}
