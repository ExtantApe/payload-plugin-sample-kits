import type { ReactNode } from 'react'

import type { ServerResult } from '../server/result.js'
import { DefaultEmpty, DefaultShell, PageProblem, type EmptySlot, type NavItem, type ShellSlot } from '../ui/slots.js'
import { tx, uiText, type Translate, type UiKey, type UiText } from '../ui/text.js'

/** What every page takes besides its data and actions. All optional. */
export type PageSlots = {
  /** The page shell and menu. */
  Shell?: ShellSlot
  /** The empty state. */
  Empty?: EmptySlot
  /** The site's translator (the plugin's `i18n.t`): keys `sampleKits.ui.<key>`. English when missing. */
  t?: Translate
  /** For dates and amounts. Default `en-US`. */
  locale?: string
  /** The menu for staff pages. Default `STAFF_NAV`. */
  nav?: readonly NavItem[]
  /** Where "Sign in" goes when the person isn't signed in. */
  signInHref?: string
}

/** The shell, the title, and either the page or the plain reason it couldn't load. */
export function Frame<T>({ slots, title, intro, current, staff, result, children }: { slots: PageSlots; title: UiKey | ((text: UiText) => string); intro?: UiKey; current?: string; staff?: readonly NavItem[]; result: ServerResult<T>; children: (data: T, text: UiText) => ReactNode }) {
  const Shell = slots.Shell ?? DefaultShell
  const text = uiText(slots.t)
  const heading = typeof title === 'function' ? title(text) : tx(text, title)
  return (
    <Shell title={heading} intro={intro ? tx(text, intro) : undefined} nav={staff} current={current}>
      {result.ok ? children(result.data, text) : <PageProblem code={result.error.code} message={result.error.message} signInHref={slots.signInHref} text={text} />}
    </Shell>
  )
}

export const emptyOf = (slots: PageSlots) => slots.Empty ?? DefaultEmpty

/** A status in words, with its name for styling (never color alone). */
export function Badge({ children, kind }: { children: ReactNode; kind: string }) {
  return (
    <span className="sk-badge" data-kind={kind} style={{ border: '1px solid currentColor', borderRadius: 4, padding: '0 0.35rem', marginInlineStart: '0.5rem', fontSize: '0.875rem' }}>
      {children}
    </span>
  )
}

export { tx }
