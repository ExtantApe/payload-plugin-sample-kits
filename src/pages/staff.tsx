import { ActionButton, ActionForm, ScanStation, type Action, type FieldSpec } from '../client/index.js'
import { SlipMaker, type SlipKitView } from '../client/forms.js'
import type { LotInput } from '../kits.js'
import type { ServerResult } from '../server/result.js'
import type { BatchRow, KitsHomeData, PackingQueueRow, PackOrderData, ReturnsData, ScanAnswer } from '../server/staff.js'
import { STAFF_NAV, STAFF_PATHS, type StaffPaths } from '../ui/nav.js'
import { LINK_TARGET } from '../ui/slots.js'
import { KIT_STATUS_LABELS, type KitStatus } from '../status.js'
import { day, keyOf, tx } from '../ui/text.js'

const word = (s: string) => KIT_STATUS_LABELS[s as KitStatus] ?? s
import { Badge, emptyOf, Frame, type PageSlots } from './shared.js'

/**
 * The staff pages (`/kits/*`), as server components. Each takes the answer of its server function (`result`) and the
 * site's server actions (`actions`), each one `(input) => theServerFunction(req, input)` after the site's own checks.
 */

type Msg = { message: string }
type Scan = Action<{ code: string } & Record<string, string>, ScanAnswer>
const navOf = (s: PageSlots) => s.nav ?? STAFF_NAV

export function KitsHomePage({ result, actions, ...slots }: PageSlots & { result: ServerResult<KitsHomeData>; actions: { releasePreorders: Action<void, Msg>; addLot: Action<LotInput, Msg> } }) {
  return (
    <Frame slots={slots} title="staffTitle" current="home" staff={navOf(slots)} result={result}>
      {(d, text) => {
        const lotFields: FieldSpec[] = [
          { name: 'lotNumber', label: tx(text, 'lotNumber'), type: 'text', required: true, inputMode: 'numeric', help: tx(text, 'lotNumberHelp') },
          { name: 'manufacturer', label: tx(text, 'manufacturer'), type: 'text' },
          { name: 'model', label: tx(text, 'model'), type: 'text' },
          { name: 'expiresOn', label: tx(text, 'expires'), type: 'date' },
          { name: 'firstSerial', label: tx(text, 'firstSerial'), type: 'number', inputMode: 'numeric', help: tx(text, 'serialHelp') },
          { name: 'lastSerial', label: tx(text, 'lastSerial'), type: 'number', inputMode: 'numeric' },
        ]
        return (
          <>
            {d.placeholders.length ? <p role="note">{tx(text, 'placeholders', { items: d.placeholders.join(', ') })}</p> : null}
            {d.counts.preorders > 0 ? (
              <section aria-labelledby="sk-preorders">
                <h2 id="sk-preorders">{tx(text, 'preorders', { n: d.counts.preorders })}</h2>
                <p>{tx(text, 'preordersHelp')}</p>
                <ActionButton action={actions.releasePreorders} label={tx(text, 'preordersRelease')} confirm={tx(text, 'preordersConfirm', { n: d.counts.preorders })} text={text} />
              </section>
            ) : null}
            {d.atEvents.length ? (
              <section aria-labelledby="sk-events">
                <h2 id="sk-events">{tx(text, 'atEvents')}</h2>
                <ul>
                  {d.atEvents.map((e) => (
                    <li key={e.dateId}>
                      {tx(text, 'atEventsLine', { event: e.event, date: day(e.starts, slots.locale), place: e.place, kits: e.kits, orders: e.orders })}
                      {e.state && e.state !== 'upcoming' ? <Badge kind={e.state}>{e.state}</Badge> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <dl className="sk-counts">
              <div>
                <dt>{tx(text, 'inStock')}</dt>
                <dd>{d.counts.inStock}</dd>
              </div>
              <div>
                <dt>{tx(text, 'toPack')}</dt>
                <dd>{d.counts.toPack}</dd>
              </div>
              <div>
                <dt>{tx(text, 'packedWaiting')}</dt>
                <dd>{d.counts.packed}</dd>
              </div>
            </dl>
            <section aria-labelledby="sk-lots">
              <h2 id="sk-lots">{tx(text, 'lots')}</h2>
              {d.lots.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{tx(text, 'lot')}</th>
                        <th scope="col">{tx(text, 'model')}</th>
                        <th scope="col">{tx(text, 'expires')}</th>
                        <th scope="col">{tx(text, 'free')}</th>
                        <th scope="col">{tx(text, 'kitsTotal')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.lots.map((l) => (
                        <tr key={l.id}>
                          <th scope="row">
                            {l.lotNumber}
                            {l.recalled ? <Badge kind="recalled">{tx(text, 'recalled')}</Badge> : l.expired ? <Badge kind="expired">{tx(text, 'expired')}</Badge> : null}
                          </th>
                          <td>{l.maker}</td>
                          <td>{l.expiresOn ? day(l.expiresOn, slots.locale) : '—'}</td>
                          <td>{l.free}</td>
                          <td>{l.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>{tx(text, 'none')}</p>
              )}
            </section>
            <section aria-labelledby="sk-new-lot">
              <h2 id="sk-new-lot">{tx(text, 'newLot')}</h2>
              <ActionForm action={actions.addLot} fields={lotFields} submit={tx(text, 'addLot')} text={text} />
            </section>
          </>
        )
      }}
    </Frame>
  )
}

/** `/kits/scan`: look up, receive and check in, by scanner or typed code. `hubs` lets check-in choose a hub. */
export function ScanPage({ actions, hubs, mode, ...slots }: PageSlots & { actions: { lookup: Scan; receive: Scan; checkIn: Scan }; hubs?: { id: string; name: string }[]; mode?: string }) {
  const result: ServerResult<null> = { ok: true, data: null }
  return (
    <Frame slots={slots} title="scanTitle" current="scan" staff={navOf(slots)} result={result}>
      {(_d, text) => (
        <ScanStation
          text={text}
          hubs={hubs}
          initialMode={mode}
          modes={[
            { key: 'lookup', label: tx(text, 'modeLookup'), action: actions.lookup },
            { key: 'receive', label: tx(text, 'modeReceive'), action: actions.receive },
            { key: 'checkIn', label: tx(text, 'modeCheckIn'), action: actions.checkIn },
          ]}
        />
      )}
    </Frame>
  )
}

export function PackingPage({ result, paths, ...slots }: PageSlots & { result: ServerResult<{ orders: PackingQueueRow[] }>; paths?: Partial<StaffPaths> }) {
  const Empty = emptyOf(slots)
  const p = { ...STAFF_PATHS, ...paths }
  return (
    <Frame slots={slots} title="packingTitle" current="packing" staff={navOf(slots)} result={result}>
      {(d, text) =>
        d.orders.length ? (
          <ul className="sk-queue">
            {d.orders.map((o) => (
              <li key={o.id}>
                <a href={`${p.packOrder}${o.id}`} style={LINK_TARGET}>
                  {tx(text, 'order')} {o.id.slice(-6)}
                </a>{' '}
                · {tx(text, 'ordered')} {day(o.createdAt, slots.locale)} · {tx(text, 'kitsPacked', { packed: o.packed, kits: o.kits })} · {o.slipMade ? tx(text, 'slipMade') : tx(text, 'slipNotMade')}
                {o.dropOff ? ` · ${tx(text, 'dropOffAt', { event: o.dropOff })}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={tx(text, 'nothingToPack')} body={tx(text, 'nothingToPackBody')} />
        )
      }
    </Frame>
  )
}

export function PackOrderPage({
  result,
  actions,
  ...slots
}: PageSlots & {
  result: ServerResult<PackOrderData>
  /** The slip's activation links use the plugin's `site.origin`, never an address from the page. */
  actions: { pack: Scan; unpack: Scan; slip: Action<{ order: string }, { kits: SlipKitView[] }>; ship: Action<{ order: string; tracking: string }, Msg>; labels?: Action<{ order: string }, Msg>; returnLabels?: Action<{ order: string }, Msg> }
}) {
  return (
    <Frame slots={slots} title="packOrder" current="packing" staff={navOf(slots)} result={result}>
      {(d, text) => (
        <>
          <p>
            {tx(text, 'order')} {d.id.slice(-6)} · {tx(text, 'ordered')} {day(d.createdAt, slots.locale)} · {tx(text, 'kitsPacked', { packed: d.packed, kits: d.total })}
            {d.dropOff ? ` · ${tx(text, 'dropOffAt', { event: d.dropOff.event })}` : ''}
          </p>
          <h2>{tx(text, 'lines')}</h2>
          <ul>
            {d.lines.map((l) => (
              <li key={l.index}>
                {tx(text, 'line', { quantity: l.quantity, kind: l.kind })}: {tx(text, 'kitsPacked', { packed: l.packed, kits: l.quantity })}
              </li>
            ))}
          </ul>
          {d.status !== 'shipped' ? (
            <ScanStation
              text={text}
              extra={{ order: d.id }}
              modes={[
                { key: 'pack', label: tx(text, 'modePack'), action: actions.pack },
                { key: 'unpack', label: tx(text, 'modeUnpack'), action: actions.unpack },
              ]}
            />
          ) : null}
          <h2>{tx(text, 'packedKits')}</h2>
          {d.kits.length ? (
            <ul>
              {d.kits.map((k) => (
                <li key={k.code}>
                  <span style={{ fontFamily: 'monospace' }}>{k.code}</span>
                  {k.label ? ` · ${k.label}` : ''}
                  <Badge kind={k.status}>{word(k.status)}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p>{tx(text, 'none')}</p>
          )}
          {d.status === 'packed' && d.packed === d.total ? <SlipMaker order={d.id} action={actions.slip} text={text} /> : null}
          {d.labels.enabled ? (
            <section aria-labelledby="sk-labels">
              <h2 id="sk-labels">{tx(text, 'labels')}</h2>
              {d.labels.state === 'failed' && d.labels.error ? <p role="note">{d.labels.error}</p> : null}
              <ul>
                {d.outbound.map((l) => (
                  <li key={`o${l.box}`}>
                    {l.unknown ? (
                      tx(text, 'labelUnknown', { box: l.box })
                    ) : l.labelUrl ? (
                      <a href={l.labelUrl} target="_blank" rel="noopener noreferrer" style={LINK_TARGET}>
                        {tx(text, 'labelLink', { box: l.box })} {tx(text, 'opensNewTab')}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
              {actions.labels ? <ActionForm action={actions.labels} fields={[{ name: 'order', label: '', type: 'hidden', value: d.id }]} submit={tx(text, 'buyLabels')} text={text} resetOnDone={false} /> : null}
              {actions.returnLabels ? <ActionForm action={actions.returnLabels} fields={[{ name: 'order', label: '', type: 'hidden', value: d.id }]} submit={tx(text, 'buyReturnLabels')} text={text} resetOnDone={false} /> : null}
            </section>
          ) : null}
          {d.canShip ? (
            <section aria-labelledby="sk-ship">
              <h2 id="sk-ship">{tx(text, 'ship')}</h2>
              <ActionForm
                action={actions.ship}
                fields={[
                  { name: 'order', label: '', type: 'hidden', value: d.id },
                  { name: 'tracking', label: tx(text, 'tracking'), type: 'textarea', help: tx(text, 'trackingHelp') },
                ]}
                submit={tx(text, 'ship')}
                text={text}
              />
            </section>
          ) : null}
        </>
      )}
    </Frame>
  )
}

export function ReturnsPage({
  result,
  actions,
  replaceReasons = ['lost', 'expired', 'recalled', 'failed'],
  ...slots
}: PageSlots & {
  result: ServerResult<ReturnsData>
  actions: { checkIn: Scan; reprint?: Action<{ label: string }, Msg>; recall: Action<{ lotNumber: string; reason: string; confirm: boolean }, Msg>; replace: Action<{ code: string; reason: string; note?: string }, Msg> }
  /** The reasons staff can replace for. Add `damaged` when `orderHelp.reasons.damaged` is on. */
  replaceReasons?: string[]
}) {
  return (
    <Frame slots={slots} title="returnsTitle" current="returns" staff={navOf(slots)} result={result}>
      {(d, text) => (
        <>
          <ScanStation text={text} hubs={d.hubs} modes={[{ key: 'checkIn', label: tx(text, 'checkIn'), action: actions.checkIn }]} />
          {d.atEvents.length ? (
            <section aria-labelledby="sk-r-events">
              <h2 id="sk-r-events">{tx(text, 'atEvents')}</h2>
              <ul>
                {d.atEvents.map((e) => (
                  <li key={e.dateId}>{tx(text, 'atEventsLine', { event: e.event, date: day(e.starts, slots.locale), place: e.place, kits: e.kits, orders: e.orders })}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {d.staleLabels.length ? (
            <section aria-labelledby="sk-stale">
              <h2 id="sk-stale">{tx(text, 'staleLabels')}</h2>
              <ul>
                {d.staleLabels.map((l) => (
                  <li key={l.id}>
                    {tx(text, 'order')} {l.order.slice(-6)} · {l.tracking}
                    {actions.reprint ? <ActionForm action={actions.reprint} fields={[{ name: 'label', label: '', type: 'hidden', value: l.id }]} submit={tx(text, 'reprint')} text={text} resetOnDone={false} /> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {d.labelProblems.length ? (
            <section aria-labelledby="sk-lp">
              <h2 id="sk-lp">{tx(text, 'labelProblems')}</h2>
              <ul>
                {d.labelProblems.map((p) => (
                  <li key={p.id}>
                    {tx(text, 'order')} {p.id.slice(-6)}: {p.error}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {d.recalled.length ? (
            <section aria-labelledby="sk-rc">
              <h2 id="sk-rc">{tx(text, 'recalledWaiting')}</h2>
              <ul>
                {d.recalled.map((k) => (
                  <li key={k.code} style={{ fontFamily: 'monospace' }}>
                    {k.code}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {d.toReview.length ? (
            <section aria-labelledby="sk-tr">
              <h2 id="sk-tr">{tx(text, 'toReview')}</h2>
              <ul>
                {d.toReview.map((r) => (
                  <li key={r.order}>
                    {tx(text, 'order')} {r.order.slice(-6)} · {day(r.at, slots.locale)} · {r.reasons.join(', ')}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="sk-replace">
            <h2 id="sk-replace">{tx(text, 'replaceTitle')}</h2>
            <ActionForm
              action={actions.replace}
              fields={[
                { name: 'code', label: tx(text, 'kitCode'), type: 'text', required: true, inputMode: 'numeric' },
                { name: 'reason', label: tx(text, 'replaceReason'), type: 'select', required: true, options: replaceReasons.map((r) => ({ value: r, label: r })) },
                { name: 'note', label: tx(text, 'note'), type: 'textarea' },
              ]}
              submit={tx(text, 'replace')}
              text={text}
            />
          </section>
          <section aria-labelledby="sk-recall">
            <h2 id="sk-recall">{tx(text, 'recallTitle')}</h2>
            <ActionForm
              action={actions.recall}
              fields={[
                { name: 'lotNumber', label: tx(text, 'lotNumber'), type: 'text', required: true, inputMode: 'numeric' },
                { name: 'reason', label: tx(text, 'reason'), type: 'textarea', required: true },
                { name: 'confirm', label: tx(text, 'recallConfirm'), type: 'checkbox', required: true },
              ]}
              submit={tx(text, 'recall')}
              text={text}
            />
          </section>
        </>
      )}
    </Frame>
  )
}

export function BatchesPage({ result, actions, paths, ...slots }: PageSlots & { result: ServerResult<{ batches: BatchRow[]; labs: { id: string; name: string; sizes: number[] }[] }>; actions: { newBatch: Action<{ lab: string; size: number | null }, { id: string; number: number }> }; paths?: Partial<StaffPaths> }) {
  const Empty = emptyOf(slots)
  const p = { ...STAFF_PATHS, ...paths }
  return (
    <Frame slots={slots} title="batchesTitle" current="batches" staff={navOf(slots)} result={result}>
      {(d, text) => (
        <>
          {d.labs.length ? (
            <section aria-labelledby="sk-nb">
              <h2 id="sk-nb">{tx(text, 'newBatch')}</h2>
              <ActionForm
                action={actions.newBatch}
                fields={[
                  { name: 'lab', label: tx(text, 'lab'), type: 'select', required: true, options: d.labs.map((l) => ({ value: l.id, label: l.name })), value: d.labs.length === 1 ? d.labs[0]!.id : undefined },
                  { name: 'size', label: tx(text, 'size'), type: 'number', inputMode: 'numeric', value: String(d.labs[0]?.sizes[0] ?? '') },
                ]}
                submit={tx(text, 'newBatch')}
                text={text}
              />
            </section>
          ) : null}
          {d.batches.length ? (
            <ul className="sk-batches">
              {d.batches.map((b) => (
                <li key={b.id}>
                  <a href={`${p.batch}${b.id}`} style={LINK_TARGET}>
                    {b.title ?? tx(text, 'batch', { n: b.number })}
                  </a>{' '}
                  · {b.lab} · {b.kits}/{b.size}
                  <Badge kind={b.status}>{tx(text, keyOf('batch_', b.status))}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title={tx(text, 'noBatches')} body={tx(text, 'noBatchesBody')} />
          )}
        </>
      )}
    </Frame>
  )
}

export function BatchPage({
  result,
  actions,
  ...slots
}: PageSlots & {
  result: ServerResult<BatchRow & { kitList: { code: string; status: string }[]; trackingNumbers: string[]; sizes: number[] }>
  /** The lab's notice takes the site's name and portal address from the plugin's `site` option, never from the page. */
  actions: { add: Scan; remove: Scan; ship: Action<{ batch: string; tracking: string; oddSizeOk: boolean }, Msg> }
}) {
  return (
    <Frame slots={slots} title="batchesTitle" current="batches" staff={navOf(slots)} result={result}>
      {(d, text) => (
        <>
          <h2>
            {d.title ?? tx(text, 'batch', { n: d.number })} · {d.lab}
            <Badge kind={d.status}>{tx(text, keyOf('batch_', d.status))}</Badge>
          </h2>
          <p>
            {d.kits}/{d.size}
            {d.shippedAt ? ` · ${tx(text, 'shippedOn', { date: day(d.shippedAt, slots.locale) })}` : ''}
          </p>
          {d.status === 'assembling' ? (
            <>
              <ScanStation
                text={text}
                extra={{ batch: d.id }}
                modes={[
                  { key: 'add', label: tx(text, 'modeAdd'), action: actions.add },
                  { key: 'remove', label: tx(text, 'modeRemove'), action: actions.remove },
                ]}
              />
              <section aria-labelledby="sk-sb">
                <h2 id="sk-sb">{tx(text, 'shipBatch')}</h2>
                <ActionForm
                  action={actions.ship}
                  fields={[
                    { name: 'batch', label: '', type: 'hidden', value: d.id },
                    { name: 'tracking', label: tx(text, 'tracking'), type: 'textarea', required: true, help: tx(text, 'trackingHelp') },
                    { name: 'oddSizeOk', label: tx(text, 'oddSizeOk'), type: 'checkbox' },
                  ]}
                  submit={tx(text, 'shipBatch')}
                  text={text}
                />
              </section>
            </>
          ) : null}
          <ul>
            {d.kitList.map((k) => (
              <li key={k.code}>
                <span style={{ fontFamily: 'monospace' }}>{k.code}</span>
                <Badge kind={k.status}>{word(k.status)}</Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </Frame>
  )
}
