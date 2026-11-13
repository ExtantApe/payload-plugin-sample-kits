import { ActionForm, type Action } from '../client/common.js'
import type { ComponentType } from 'react'

import { LabUploader, type LabUploaderActions, type LabUploaderProps } from '../client/LabUploader.js'
import type { LabPageData } from '../server/lab.js'
import type { ServerResult } from '../server/result.js'
import { KIT_STATUS_LABELS, type KitStatus } from '../status.js'
import { LINK_TARGET } from '../ui/slots.js'
import { day, keyOf, tx } from '../ui/text.js'
import { Badge, emptyOf, Frame, type PageSlots } from './shared.js'

/**
 * The lab portal (`/lab`), as a server component: the labs this person works for, each batch sent to the chosen one
 * with its kits' codes, statuses and tests, "arrived", and result upload. It shows only what `labPage` read out, which
 * never includes a buyer, keeper, address, subject or result.
 */
export function LabPage({
  result,
  actions,
  labPath = '/lab',
  Uploader = LabUploader,
  ...slots
}: PageSlots & {
  result: ServerResult<LabPageData>
  actions: LabUploaderActions & { received: Action<{ batch: string }, { message: string }> }
  /** This page's path, for the lab chooser's links (`?lab=<id>`). */
  labPath?: string
  /**
   * The upload slot. With `results.verifyUpload`, pass the site's `'use client'` wrapper that renders `<LabUploader>`
   * with its own `uploader` (the client upload to its storage, answering a file id). Default: `LabUploader` as is.
   */
  Uploader?: ComponentType<LabUploaderProps>
}) {
  const Empty = emptyOf(slots)
  return (
    <Frame slots={slots} title="labTitle" result={result}>
      {(d, text) => (
        <>
          {d.labs.length > 1 ? (
            <nav aria-label={tx(text, 'chooseLab')}>
              <ul>
                {d.labs.map((l) => (
                  <li key={l.id}>
                    <a href={`${labPath}?lab=${encodeURIComponent(l.id)}`} aria-current={d.lab?.id === l.id ? 'page' : undefined} style={LINK_TARGET}>
                      {l.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {d.lab ? (
            <>
              <h2>{d.lab.name}</h2>
              {d.lab.fileNaming ? <p>{d.lab.fileNaming}</p> : null}
              {d.batches.length ? (
                d.batches.map((b) => (
                  <section key={b.id} aria-labelledby={`sk-b-${b.id}`}>
                    <h3 id={`sk-b-${b.id}`}>
                      {b.title ?? tx(text, 'batch', { n: b.number })}
                      <Badge kind={b.status}>{tx(text, keyOf('batch_', b.status))}</Badge>
                    </h3>
                    <p>
                      {b.shippedAt ? tx(text, 'shippedOn', { date: day(b.shippedAt, slots.locale) }) : ''}
                      {b.receivedAt ? ` · ${tx(text, 'receivedOn', { date: day(b.receivedAt, slots.locale) })}` : ''}
                      {b.trackingNumbers.length ? ` · ${tx(text, 'tracking')}: ${b.trackingNumbers.join(', ')}` : ''}
                    </p>
                    {b.status === 'shipped' ? <ActionForm action={actions.received} fields={[{ name: 'batch', label: '', type: 'hidden', value: b.id }]} submit={tx(text, 'confirmReceived', { n: b.number })} text={text} resetOnDone={false} /> : null}
                    <div style={{ overflowX: 'auto' }}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{tx(text, 'forKit')}</th>
                            <th scope="col">{tx(text, 'status')}</th>
                            <th scope="col">{tx(text, 'marker')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.kits.map((k) => (
                            <tr key={k.code}>
                              <th scope="row" style={{ fontFamily: 'monospace' }}>
                                {k.code}
                              </th>
                              <td>{KIT_STATUS_LABELS[k.status as KitStatus] ?? k.status}</td>
                              <td>{k.marker}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))
              ) : (
                <Empty title={tx(text, 'noLabBatches')} body={tx(text, 'noLabBatchesBody')} />
              )}
              <Uploader lab={d.lab.id} upload={d.upload} actions={actions} text={text} />
            </>
          ) : (
            <p>{tx(text, 'chooseLab')}</p>
          )}
        </>
      )}
    </Frame>
  )
}
