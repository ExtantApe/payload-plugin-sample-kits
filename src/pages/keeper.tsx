import type { ReactNode } from 'react'

import { ActivationWizard, type ActivationActions } from '../client/ActivationWizard.js'
import { MissedChoiceForm, OrderHelpForm, ReturnLabelButton } from '../client/forms.js'
import type { Action } from '../client/common.js'
import type { ActivateData, KeeperKit, MyKitData, MyOrder, MyOrderData, MyTestsData } from '../server/keeper.js'
import type { ServerResult } from '../server/result.js'
import { KEEPER_PATHS, type KeeperPaths } from '../ui/nav.js'
import { DefaultPrice, DefaultResultCard, DefaultSubjectPicker, LINK_TARGET, type PriceSlot, type ResultCardSlot, type SubjectPickerSlot } from '../ui/slots.js'
import { day, keyOf, tx, type UiText } from '../ui/text.js'
import { emptyOf, Frame, type PageSlots } from './shared.js'

/**
 * The keeper's pages (`/my-tests/*`) and the activation page, as server components. They show only what the server
 * functions gave them, which is already limited to the person's own kits and orders.
 */

type Msg = { message: string }
const pathsOf = (p?: Partial<KeeperPaths>) => ({ ...KEEPER_PATHS, ...p })

/** Where a kit is, as an ordered list of steps, each marked in words (done, now, to do), never by color alone. */
export function KitProgress({ steps, step, problem, statusText, text }: { steps: string[]; step: number; problem: string | null; statusText: string; text: Partial<UiText> }) {
  if (problem) return <p className="sk-progress-problem">{tx(text, 'offPath', { status: statusText })}</p>
  return (
    <ol className="sk-progress" aria-label={tx(text, 'progress')}>
      {steps.map((s, i) => (
        <li key={s} aria-current={i === step ? 'step' : undefined} data-state={i < step ? 'done' : i === step ? 'now' : 'todo'}>
          {s} <span>({i < step ? tx(text, 'stepDone') : i === step ? tx(text, 'stepNow') : tx(text, 'stepToDo')})</span>
        </li>
      ))}
    </ol>
  )
}

function KitRows({ kits, text, paths }: { kits: KeeperKit[]; text: Partial<UiText>; paths: KeeperPaths }) {
  return (
    <ul className="sk-kits">
      {kits.map((k) => (
        <li key={k.code}>
          <a href={`${paths.kit}${k.code}`} style={LINK_TARGET}>
            <span style={{ fontFamily: 'monospace' }}>{k.code}</span>
          </a>{' '}
          · {k.subject ?? tx(text, 'noSubjectYet')} · {k.statusText}
          {k.next === 'activate' ? (
            <>
              {' '}
              ·{' '}
              <a href={`${paths.activate}?kit=${encodeURIComponent(k.code)}`} style={LINK_TARGET}>
                {tx(text, 'nextActivate')}
              </a>
            </>
          ) : k.next === 'sample' ? (
            <>
              {' '}
              ·{' '}
              <a href={`${paths.activate}?kit=${encodeURIComponent(k.code)}`} style={LINK_TARGET}>
                {tx(text, 'nextSample')}
              </a>
            </>
          ) : k.next === 'return' ? (
            <>
              {' '}
              ·{' '}
              <a href={`${paths.kit}${k.code}`} style={LINK_TARGET}>
                {tx(text, 'nextReturn')}
              </a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function summaryLine(o: MyOrder, text: Partial<UiText>, steps: string[]) {
  const s = o.summary
  if (s.stage !== 'underway') return tx(text, keyOf('stage_', s.stage))
  const stepNames = ['ordered', 'shipped', 'activated', 'sampled', 'returned', 'lab', 'results']
  return [
    ...s.steps.map((x) => tx(text, 'atStep', { n: x.n, step: steps[stepNames.indexOf(x.step)] ?? x.step })),
    ...(s.attention ? [tx(text, 'attention', { n: s.attention })] : []),
    ...(s.replaced ? [tx(text, 'replacedCount', { n: s.replaced })] : []),
  ].join(' · ')
}

const helpLink = { refund: 'helpRefund', help: 'helpHelp', missed: 'helpMissed', closed: 'helpClosed' } as const

export function MyTestsPage({ result, paths, orderSection, ...slots }: PageSlots & { result: ServerResult<MyTestsData>; paths?: Partial<KeeperPaths>; /** The site's own "order kits" section (its checkout, address form and price line). */ orderSection?: ReactNode }) {
  const p = pathsOf(paths)
  const Empty = emptyOf(slots)
  return (
    <Frame slots={{ signInHref: p.signIn, ...slots }} title="myTitle" intro="myIntro" result={result}>
      {(d, text) => (
        <>
          <p>
            <a href={p.activate} style={LINK_TARGET}>
              {tx(text, 'activate')}
            </a>
          </p>
          {!d.orders.length && !d.otherKits.length ? (
            <Empty title={tx(text, 'noKits')} body={tx(text, 'noKitsBody')} action={{ href: p.activate, label: tx(text, 'activate') }} />
          ) : (
            <ul className="sk-orders" style={{ listStyle: 'none', padding: 0 }}>
              {d.orders.map((o) => (
                <li key={o.id}>
                  <h2>
                    {tx(text, 'orderOf', { date: day(o.createdAt, slots.locale) })} · {tx(text, 'kitCount', { n: o.kitCount })}
                  </h2>
                  <p>{summaryLine(o, text, d.steps)}</p>
                  {o.promisedBy ? <p>{tx(text, 'promised', { date: day(o.promisedBy, slots.locale) })}</p> : null}
                  <p>
                    <a href={`${p.order}${o.id}`} style={{ ...LINK_TARGET, fontWeight: o.help === 'missed' ? 700 : 400 }}>
                      {tx(text, helpLink[o.help])}
                    </a>
                  </p>
                  {o.kits.length ? <KitRows kits={o.kits} text={text} paths={p} /> : null}
                </li>
              ))}
              {d.otherKits.length ? (
                <li>
                  <h2>{tx(text, 'activatedByYou')}</h2>
                  <KitRows kits={d.otherKits} text={text} paths={p} />
                </li>
              ) : null}
            </ul>
          )}
          {orderSection}
        </>
      )}
    </Frame>
  )
}

export function MyKitPage({ result, actions, ResultCard = DefaultResultCard, paths, ...slots }: PageSlots & { result: ServerResult<MyKitData>; actions: { returnLabel?: Action<{ code: string; extra?: boolean }, { labelUrl: string; message: string }> }; ResultCard?: ResultCardSlot; paths?: Partial<KeeperPaths> }) {
  const p = pathsOf(paths)
  const title = (text: UiText) => tx(text, 'kitTitle', { code: result.ok ? result.data.code : '' }).trim()
  return (
    <Frame slots={{ signInHref: p.signIn, ...slots }} title={title} result={result}>
      {(k, text) => (
        <>
          <h2>{k.statusText}</h2>
          <KitProgress steps={k.steps} step={k.step} problem={k.problem} statusText={k.statusText} text={text} />
          <dl>
            <dt>{tx(text, 'subject')}</dt>
            <dd>{k.subject ?? tx(text, 'noSubjectYet')}</dd>
            {k.attempt > 1 ? (
              <>
                <dt>{tx(text, 'attempt')}</dt>
                <dd>{k.attempt}</dd>
              </>
            ) : null}
            {k.dates.map((d) => (
              <div key={d.step}>
                <dt>{d.label}</dt>
                <dd>{day(d.at, slots.locale)}</dd>
              </div>
            ))}
          </dl>
          {k.trackingNumbers.length ? (
            <p>
              {tx(text, 'tracking')}: {k.trackingNumbers.join(', ')}
            </p>
          ) : null}
          {k.next === 'activate' || k.next === 'sample' ? (
            <p>
              <a href={`${p.activate}?kit=${encodeURIComponent(k.code)}`} style={LINK_TARGET}>
                {tx(text, k.next === 'activate' ? 'nextActivate' : 'nextSample')}
              </a>
            </p>
          ) : null}
          {k.inPerson ? <p>{tx(text, 'inPerson', { event: k.inPerson })}</p> : null}
          {k.next === 'return' && actions.returnLabel ? (
            <section aria-labelledby="sk-rl">
              <h2 id="sk-rl">{tx(text, 'returnLabelTitle')}</h2>
              <p>{tx(text, 'returnLabelHelp')}</p>
              <ReturnLabelButton code={k.code} action={actions.returnLabel} text={text} />
            </section>
          ) : null}
          {k.role !== 'buyer' ? (
            <section aria-labelledby="sk-result">
              <h2 id="sk-result">{tx(text, 'result')}</h2>
              {k.result ? <ResultCard code={k.code} result={k.result} /> : <p>{tx(text, 'noResultYet')}</p>}
            </section>
          ) : null}
          <p>
            <a href={p.myTests} style={LINK_TARGET}>
              {tx(text, 'backToTests')}
            </a>
          </p>
        </>
      )}
    </Frame>
  )
}

export function MyOrderPage({
  result,
  actions,
  Price = DefaultPrice,
  currency,
  paths,
  ...slots
}: PageSlots & { result: ServerResult<MyOrderData>; actions: { help: Action<{ order: string; reasons: string[]; details: string; confirmKeptBack: number }, Msg & { outcome: string }>; missed: Action<{ order: string; choice: string; item?: string }, Msg & { outcome: string }> }; Price?: PriceSlot; currency?: string; paths?: Partial<KeeperPaths> }) {
  const p = pathsOf(paths)
  const title = (text: UiText) => (result.ok ? tx(text, 'orderTitle', { date: day(result.data.createdAt, slots.locale) }) : tx(text, 'helpTitle'))
  return (
    <Frame slots={{ signInHref: p.signIn, ...slots }} title={title} result={result}>
      {(o, text) => (
        <>
          <p>{summaryLine(o, text, o.steps)}</p>
          {o.promisedBy ? <p>{tx(text, 'promised', { date: day(o.promisedBy, slots.locale) })}</p> : null}
          {o.kits.length ? <KitRows kits={o.kits} text={text} paths={p} /> : null}
          {o.options.phase === 'missed' ? (
            <section aria-labelledby="sk-missed">
              <h2 id="sk-missed">{tx(text, 'missedTitle')}</h2>
              <MissedChoiceForm order={o.id} choices={o.missedChoices} action={actions.missed} text={text} />
            </section>
          ) : o.options.phase === 'refund' || o.options.phase === 'help' ? (
            <section aria-labelledby="sk-help">
              <h2 id="sk-help">{tx(text, o.options.phase === 'refund' ? 'helpRefund' : 'helpHelp')}</h2>
              {o.options.phase === 'refund' ? <p>{tx(text, 'refundWindow', { n: o.options.daysLeft })}</p> : null}
              {o.options.refundableCents > 0 && !o.options.shipped ? (
                <p>
                  {tx(text, 'refundable')} <Price cents={Math.max(0, o.options.refundableCents - o.options.keptBackCents)} kind="refund" currency={currency} locale={slots.locale} />
                </p>
              ) : null}
              <OrderHelpForm order={o.id} reasons={o.options.reasons} keptBackCents={o.options.keptBackCents} keptBackLine={<Price cents={o.options.keptBackCents} kind="kept-back" currency={currency} locale={slots.locale} />} action={actions.help} text={text} />
            </section>
          ) : null}
          {o.options.requests.length ? (
            <section aria-labelledby="sk-requests">
              <h2 id="sk-requests">{tx(text, 'requests')}</h2>
              <ul>
                {o.options.requests.map((r, i) => (
                  <li key={i}>
                    {day(r.at, slots.locale)} · {r.reasons.map((x) => tx(text, keyOf('reason_', x))).join(', ')} · {r.outcome}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p>
            <a href={p.myTests} style={LINK_TARGET}>
              {tx(text, 'backToTests')}
            </a>
          </p>
        </>
      )}
    </Frame>
  )
}

/**
 * `/my-tests/activate` (route id `kit-activate`). Without Wizards, the plugin's own steps run. With Wizards, pass your
 * client wrapper as `wizard` (an `<ActivationWizard>` given Wizards' `<Wizard>` and the flow's screens), since a
 * component can't be sent from the server to the browser.
 */
export function ActivatePage({ result, actions, SubjectPicker = DefaultSubjectPicker, wizard, paths, ...slots }: PageSlots & { result: ServerResult<ActivateData>; actions: ActivationActions; SubjectPicker?: SubjectPickerSlot; wizard?: ReactNode; paths?: Partial<KeeperPaths> }) {
  const p = pathsOf(paths)
  return (
    <Frame slots={{ signInHref: p.signIn, ...slots }} title="activateTitle" intro="activateIntro" result={result}>
      {(d, text) =>
        wizard ?? (
          <ActivationWizard
            data={d}
            actions={actions}
            text={text}
            paths={{ myTests: p.myTests }}
            subjectPicker={d.choices ? <SubjectPicker name="subject" choices={d.choices} legend={tx(text, 'chooseSubject')} help={tx(text, 'chooseSubjectHelp')} suggestedText={tx(text, 'suggested')} emptyText={tx(text, 'noSubjects')} /> : undefined}
          />
        )
      }
    </Frame>
  )
}
