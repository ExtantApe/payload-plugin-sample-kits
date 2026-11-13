'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentType, FormEvent, ReactNode } from 'react'

import type { ActivateData } from '../server/keeper.js'
import type { SubjectRef } from '../types.js'
import { KEEPER_PATHS } from '../ui/nav.js'
import { DefaultSubjectPicker, FIELD, LINK_TARGET, TARGET } from '../ui/slots.js'
import { tx, type UiText } from '../ui/text.js'
import { LiveRegions, useRun, type Action } from './common.js'

/** Wizards' `<Wizard>`, as far as this needs it. The site passes Wizards' own component; it's never imported here. */
export type WizardLike = ComponentType<{
  slots: unknown[]
  renderCode: Record<string, (ctx: { next: (value?: unknown) => void; back: () => void }) => ReactNode>
  onFinish: (result: { answers: unknown[] }) => void | Promise<void>
  labels?: Record<string, unknown>
}>

export type ActivationActions = {
  activate: Action<{ code: string; secret: string; subject: SubjectRef }, { code: string; label: string | null; message: string }>
  sampled: Action<{ code: string; answers?: unknown; locale?: string; confirmed?: Record<string, unknown> }, { code: string; message: string }>
}

export type ActivationWizardProps = {
  data: ActivateData
  actions: ActivationActions
  /** The site's subject picker, rendered with `data.choices`: a form control that submits `subject` as `<kind>:<id>`. */
  subjectPicker?: ReactNode
  /** Wizards' `<Wizard>` and the flow's screens from Wizards' `flowSteps('kit-activation')`. Both, or neither. */
  Wizard?: WizardLike
  wizardSlots?: unknown[]
  /** The language the guided steps were read in, sent with the answers. */
  locale?: string
  text?: Partial<UiText>
  paths?: { myTests?: string }
}

type Screen = 'find' | 'subject' | 'sample' | 'done'

/** The secret from the slip's link: `#s=<secret>` in the fragment, which the browser never sends to a server. */
export function secretFromFragment(hash: string): string | null {
  const m = /(?:^#|[#&])s=([A-Za-z0-9-]{4,40})(?:&|$)/.exec(hash)
  return m ? m[1]!.toUpperCase() : null
}

const subjectOf = (raw: FormDataEntryValue | null): SubjectRef | null => {
  const v = typeof raw === 'string' ? raw : ''
  const i = v.indexOf(':')
  return i > 0 && i < v.length - 1 ? { kind: v.slice(0, i), id: v.slice(i + 1) } : null
}

/**
 * Activation at `/my-tests/activate` (route id `kit-activate`), mobile-first: find the kit (code and secret), choose
 * who the sample is from, take the sample. With Wizards passed in, its guided safety steps run between choosing and
 * the sample, and their answers are checked on the server.
 *
 * The secret: read from the link's fragment once, then the fragment is removed from the address bar. It's kept only in
 * memory and sent once, in the activation request's body; never in a query, a cookie or web storage.
 */
export function ActivationWizard({ data, actions, subjectPicker, Wizard, wizardSlots, locale, text, paths }: ActivationWizardProps) {
  const base = useId()
  const myTests = paths?.myTests ?? KEEPER_PATHS.myTests
  const guided = Boolean(Wizard && wizardSlots?.length)
  const start: Screen = data.stage === 'sample' && data.code ? 'sample' : 'find'
  const [screen, setScreen] = useState<Screen>(start)
  const [code, setCode] = useState(data.code ?? '')
  const [secret, setSecret] = useState('')
  const [fromLink, setFromLink] = useState(false)
  const [round, setRound] = useState(0)
  const { busy, said, setSaid, run } = useRun(text)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const mounted = useRef(false)

  // The slip's QR puts the secret after "#". Take it, then take it off the address bar so it isn't left in history.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const s = secretFromFragment(window.location.hash)
    if (s) {
      setSecret(s)
      setFromLink(true)
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
  }, [])

  // Focus the new screen's heading when the screen changes (not on first load, so the page doesn't jump).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    heading.current?.focus()
  }, [screen, round])

  const plainSteps: Screen[] = ['find', 'subject', 'sample']
  const stepLine = (s: Screen) => (guided || s === 'done' ? null : <p id={`${base}-step`}>{tx(text, 'stepOf', { n: plainSteps.indexOf(s) + 1, m: plainSteps.length })}</p>)
  const h2 = (key: Parameters<typeof tx>[1], s: Screen) => (
    <h2 ref={heading} tabIndex={-1} aria-describedby={!guided && s !== 'done' ? `${base}-step` : undefined}>
      {tx(text, key)}
    </h2>
  )

  const findKit = (onNext: () => void) => (
    <form
      noValidate
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!code.trim()) return setSaid({ kind: 'error', message: tx(text, 'needCode') })
        if (!secret.trim()) return setSaid({ kind: 'error', message: tx(text, 'needSecret') })
        setSaid(null)
        onNext()
      }}
    >
      {guided ? <h2>{tx(text, 'findKit')}</h2> : null}
      <p id={`${base}-find-help`}>{tx(text, 'findKitHelp')}</p>
      <div style={{ marginBlock: '0.75rem' }}>
        <label htmlFor={`${base}-code`} style={{ display: 'block', fontWeight: 600 }}>
          {tx(text, 'kitCode')}
        </label>
        <input id={`${base}-code`} name="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="off" spellCheck={false} required style={FIELD} />
      </div>
      <div style={{ marginBlock: '0.75rem' }}>
        <label htmlFor={`${base}-secret`} style={{ display: 'block', fontWeight: 600 }}>
          {tx(text, 'secretField')}
        </label>
        <input
          id={`${base}-secret`}
          name="secret"
          value={secret}
          onChange={(e) => setSecret(e.target.value.toUpperCase())}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          aria-describedby={`${base}-secret-help`}
          style={FIELD}
        />
        <p id={`${base}-secret-help`}>{fromLink ? tx(text, 'secretFromLink') : tx(text, 'secretHelp')}</p>
      </div>
      <button type="submit" style={TARGET}>
        {tx(text, 'next')}
      </button>
    </form>
  )

  const chooseSubject = (onActivated: () => void, onBack: () => void) => (
    <form
      noValidate
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const subject = subjectOf(new FormData(e.currentTarget).get('subject'))
        if (!subject) return setSaid({ kind: 'error', message: tx(text, 'needSubject') })
        const r = await run(actions.activate, { code: code.trim(), secret: secret.trim(), subject })
        if (r?.ok) {
          setCode(r.data.code)
          // The secret has done its job: forget it.
          setSecret('')
          onActivated()
        }
      }}
    >
      {guided ? <h2>{tx(text, 'chooseSubject')}</h2> : null}
      {subjectPicker ?? <DefaultSubjectPicker name="subject" choices={data.choices ?? []} legend={tx(text, 'chooseSubject')} help={tx(text, 'chooseSubjectHelp')} suggestedText={tx(text, 'suggested')} emptyText={tx(text, 'noSubjects')} />}
      <button type="submit" style={TARGET} disabled={busy}>
        {tx(text, 'activateNow')}
      </button>{' '}
      {!guided ? (
        <button type="button" style={TARGET} onClick={onBack} disabled={busy}>
          {tx(text, 'back')}
        </button>
      ) : null}
    </form>
  )

  const done = (
    <section aria-labelledby={`${base}-done`}>
      <h2 id={`${base}-done`} ref={heading} tabIndex={-1}>
        {tx(text, 'sampleDone')}
      </h2>
      <p>{tx(text, 'sampleDoneHelp')}</p>
      <p>
        <a href={myTests} style={LINK_TARGET}>
          {tx(text, 'backToTests')}
        </a>
      </p>
      <button
        type="button"
        style={TARGET}
        onClick={() => {
          setCode('')
          setSecret('')
          setFromLink(false)
          setSaid(null)
          setRound((n) => n + 1)
          setScreen('find')
        }}
      >
        {tx(text, 'anotherKit')}
      </button>
    </section>
  )

  if (guided && Wizard && screen !== 'done') {
    const skip = new Set(start === 'sample' || screen === 'sample' ? ['find-kit', 'choose-subject'] : [])
    const slots = wizardSlots!.filter((s) => !(s && typeof s === 'object' && 'code' in s && skip.has(String((s as { code: unknown }).code))))
    return (
      <div className="sk-activate">
        <Wizard
          key={round}
          slots={slots}
          renderCode={{
            'find-kit': (ctx) => findKit(() => ctx.next()),
            'choose-subject': (ctx) => chooseSubject(() => ctx.next(), () => ctx.back()),
            sampled: (ctx) => (
              <div>
                <h2>{tx(text, 'takeSample')}</h2>
                <p>{tx(text, 'takeSampleHelp')}</p>
                <button type="button" style={TARGET} disabled={busy} onClick={() => ctx.next()}>
                  {tx(text, 'sampleTaken')}
                </button>
              </div>
            ),
          }}
          onFinish={async ({ answers }) => {
            const r = await run(actions.sampled, { code: code.trim(), answers, ...(locale ? { locale } : {}) })
            // Throwing lets the Wizard bring its buttons back so the person can try again; the reason is announced here.
            if (!r?.ok) throw new Error('not recorded')
            setScreen('done')
          }}
          labels={{ finishFailed: tx(text, 'wizardFailed') }}
        />
        <LiveRegions said={said} busy={busy} text={text} />
      </div>
    )
  }

  return (
    <section className="sk-activate" aria-labelledby={`${base}-title`}>
      <span id={`${base}-title`} hidden>
        {tx(text, 'activateTitle')}
      </span>
      {screen === 'find' ? (
        <>
          {stepLine('find')}
          {h2('findKit', 'find')}
          {findKit(() => setScreen('subject'))}
        </>
      ) : screen === 'subject' ? (
        <>
          {stepLine('subject')}
          {h2('chooseSubject', 'subject')}
          {chooseSubject(() => setScreen('sample'), () => (setSaid(null), setScreen('find')))}
        </>
      ) : screen === 'sample' ? (
        <>
          {stepLine('sample')}
          {h2('takeSample', 'sample')}
          <p>{tx(text, 'takeSampleHelp')}</p>
          <button
            type="button"
            style={TARGET}
            disabled={busy}
            onClick={async () => {
              const r = await run(actions.sampled, { code: code.trim(), confirmed: { form: 'sample-kits', at: new Date().toISOString() } })
              if (r?.ok) setScreen('done')
            }}
          >
            {tx(text, 'sampleTaken')}
          </button>
        </>
      ) : (
        done
      )}
      <LiveRegions said={said} busy={busy} text={text} />
    </section>
  )
}
