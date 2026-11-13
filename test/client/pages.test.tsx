// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivatePage, KitsHomePage, LabPage, MyKitPage, MyOrderPage, MyTestsPage, PackOrderPage, ScanPage, STAFF_NAV, UI_TEXT, uiText, type ShellProps } from '../../src/pages/index.js'
import type { KeeperKit, LabPageData, MyKitData, MyOrderData, MyTestsData, PackOrderData } from '../../src/server/index.js'
import { watchStorage } from './storage.js'

// Pages with made-up data, as their server functions would answer.
const storage = watchStorage()
beforeEach(() => storage.reset())
afterEach(() => {
  cleanup()
  storage.check()
})
const noop = vi.fn(async () => ({ ok: true as const, data: { message: 'ok', outcome: 'done', code: '', kits: [], labelUrl: '', label: null, id: '', number: 1, matches: [], result: 'received', rerun: false } })) as never
const STEPS = ['Ordered', 'Shipped', 'Activated', 'Sampled', 'Sent back', 'At the lab', 'Results']
const kit = (over: Partial<KeeperKit> = {}): KeeperKit => ({ code: '272727000001', status: 'activated', statusText: 'Activated', step: 2, problem: null, role: 'both', subject: 'Made-up Tortoise Pebble', next: 'sample', ...over })

/** Every button and link drawn by the plugin is at least 44 pixels high. */
function targetsAre44(root: HTMLElement) {
  for (const el of [...within(root).queryAllByRole('button'), ...within(root).queryAllByRole('link')]) expect(parseInt((el as HTMLElement).style.minHeight, 10), el.textContent ?? '').toBeGreaterThanOrEqual(44)
}

describe('staff pages', () => {
  it('KitsHomePage: counts, lots with recalled and expired in words, the menu with the current page', () => {
    const { container } = render(
      <KitsHomePage
        result={{ ok: true, data: { counts: { preorders: 2, inStock: 9, toPack: 1, packed: 0 }, lots: [{ id: 'l1', lotNumber: '272727', maker: 'Made-up tube', expiresOn: '2099-01-01', expired: false, recalled: true, free: 3, total: 10 }, { id: 'l2', lotNumber: '282828', maker: '', expiresOn: '2020-01-01', expired: true, recalled: false, free: 0, total: 1 }], placeholders: ['hubs'], atEvents: [] } }}
        actions={{ releasePreorders: noop, addLot: noop }}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sample kits')
    expect(screen.getByRole('link', { name: 'Kits' }).getAttribute('aria-current')).toBe('page')
    const rows = screen.getAllByRole('row')
    expect(within(rows[1]!).getByText('Recalled')).toBeTruthy()
    expect(within(rows[2]!).getByText('Expired')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('hubs')
    expect(screen.getByLabelText('Lot number')).toBeTruthy()
    targetsAre44(container)
  })

  it('a refused page shows the plain reason in an alert, and nothing else', () => {
    render(<KitsHomePage result={{ ok: false, error: { code: 'notStaff', message: 'This page is for kit staff.' } }} actions={{ releasePreorders: noop, addLot: noop }} />)
    expect(screen.getByRole('alert').textContent).toBe('This page is for kit staff.')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('uses the site’s shell and translations', () => {
    const Shell = ({ title, nav, children }: ShellProps) => (
      <div data-testid="site-shell" data-nav={nav?.length}>
        <h1>{title}</h1>
        {children}
      </div>
    )
    render(<ScanPage Shell={Shell} t={(k) => (k === 'sampleKits.ui.scanTitle' ? 'Escanear kits' : undefined)} actions={{ lookup: noop, receive: noop, checkIn: noop }} />)
    expect(screen.getByTestId('site-shell').dataset.nav).toBe(String(STAFF_NAV.length))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Escanear kits')
    expect(screen.getByRole('group', { name: 'What happens when you scan' })).toBeTruthy()
  })

  it('PackOrderPage offers the slip only when every kit is packed, and shipping only once the slip is made', () => {
    const order = (over: Partial<PackOrderData>): PackOrderData => ({ id: 'o1', createdAt: '2026-11-01', status: 'to-pack', lines: [{ index: 0, kind: 'count', quantity: 1, packed: 0 }], kits: [], total: 1, packed: 0, slipMadeAt: null, shippedAt: null, trackingNumbers: [], dropOff: null, labels: { state: null, error: null, enabled: false }, boxes: [], outbound: [], returns: [], canShip: false, ...over })
    const actions = { pack: noop, unpack: noop, slip: noop, ship: noop }
    render(<PackOrderPage result={{ ok: true, data: order({}) }} actions={actions} />)
    expect(screen.queryByRole('button', { name: 'Make the slip' })).toBeNull()
    expect(screen.queryByLabelText('Tracking numbers')).toBeNull()
    cleanup()
    render(<PackOrderPage result={{ ok: true, data: order({ status: 'packed', packed: 1, kits: [{ code: '272727000001', status: 'packed', line: 0, label: null, inPerson: null }] }) }} actions={actions} />)
    expect(screen.getByRole('button', { name: 'Make the slip' })).toBeTruthy()
    expect(screen.getByText('Packed')).toBeTruthy()
    cleanup()
    render(<PackOrderPage result={{ ok: true, data: order({ status: 'packed', packed: 1, slipMadeAt: '2026-11-02', canShip: true }) }} actions={actions} />)
    expect(screen.getByLabelText('Tracking numbers')).toBeTruthy()
  })
})

describe('the lab page', () => {
  it('shows codes, statuses and tests in a table, and offers "arrived" only for a shipped batch', () => {
    const data: LabPageData = {
      labs: [{ id: 'lab-1', name: 'Made-up Lab' }],
      lab: { id: 'lab-1', name: 'Made-up Lab', fileNaming: null },
      batches: [
        { id: 'b1', number: 1, title: null, status: 'shipped', shippedAt: '2026-11-01', receivedAt: null, trackingNumbers: ['9400 0000'], kits: [{ code: '272727000001', status: 'returned', marker: 'cytb' }] },
        { id: 'b2', number: 2, title: null, status: 'received', shippedAt: '2026-10-01', receivedAt: '2026-10-03', trackingNumbers: [], kits: [] },
      ],
      upload: { extensions: ['.fasta'], maxBytes: 900_000, by: 'base64' },
    }
    const { container } = render(<LabPage result={{ ok: true, data }} actions={{ received: noop, preview: noop, upload: noop }} />)
    expect(screen.getAllByRole('button', { name: /arrived/ }).map((b) => b.textContent)).toEqual(['Confirm batch 1 arrived'])
    expect(screen.getByRole('rowheader', { name: '272727000001' })).toBeTruthy()
    expect(screen.getByText('Back at the hub')).toBeTruthy()
    expect(screen.getByText('At the lab')).toBeTruthy()
    expect(screen.getByLabelText('Choose result files')).toBeTruthy()
    targetsAre44(container)
  })
})

describe('keeper pages', () => {
  it('MyTestsPage: the empty state, with the way to activate', () => {
    render(<MyTestsPage result={{ ok: true, data: { steps: STEPS, orders: [], otherKits: [] } }} />)
    expect(screen.getByRole('note').textContent).toContain('No kits yet')
    expect(screen.getAllByRole('link', { name: 'Activate a kit' }).length).toBe(2)
  })

  it('MyTestsPage: orders with their kits and what to do next, and the site’s order section', () => {
    const data: MyTestsData = {
      steps: STEPS,
      orders: [{ id: 'o1', createdAt: '2026-11-01T10:00:00Z', status: 'shipped', kitCount: 1, summary: { stage: 'underway', steps: [{ step: 'activated', n: 1 }], attention: 0, replaced: 0 }, promisedBy: null, trackingNumbers: [], help: 'refund', kits: [kit()] }],
      otherKits: [kit({ code: '383838000001', role: 'keeper', next: null, subject: 'Made-up Gecko Fern' })],
    }
    const { container } = render(<MyTestsPage result={{ ok: true, data }} orderSection={<section aria-label="Order kits">site checkout</section>} />)
    expect(screen.getByRole('heading', { name: /Order of November 1, 2026/ })).toBeTruthy()
    expect(screen.getByText('Activated: 1')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Take the sample' }).getAttribute('href')).toBe('/my-tests/activate?kit=272727000001')
    expect(screen.getByRole('link', { name: 'Request a refund' }).getAttribute('href')).toBe('/my-tests/orders/o1')
    expect(screen.getByRole('heading', { name: 'Kits you activated' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Order kits' })).toBeTruthy()
    targetsAre44(container)
  })

  it('MyTestsPage: signed out gets the plain reason and a sign-in link', () => {
    render(<MyTestsPage result={{ ok: false, error: { code: 'signIn', message: 'Sign in to continue.' } }} />)
    expect(screen.getByRole('alert').textContent).toContain('Sign in to continue.')
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login')
  })

  it('MyKitPage: progress in words with the current step marked, and the result card only for the keeper', () => {
    const data: MyKitData = { ...kit({ status: 'sampled', statusText: 'Sampled', step: 3, next: 'return' }), steps: STEPS, attempt: 1, dates: [{ step: 'activated', label: 'Activated', at: '2026-11-02T00:00:00Z' }], trackingNumbers: [], inPerson: null, result: { status: 'ready', summary: 'Made-up result summary' } }
    const ResultCard = vi.fn(({ result }: { code: string; result: { summary?: string } }) => <p>Site card: {result.summary}</p>)
    render(<MyKitPage result={{ ok: true, data }} actions={{ returnLabel: noop }} ResultCard={ResultCard} />)
    const steps = within(screen.getByRole('list', { name: 'Progress' })).getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual(['Ordered (done)', 'Shipped (done)', 'Activated (done)', 'Sampled (now)', 'Sent back (to do)', 'At the lab (to do)', 'Results (to do)'])
    expect(steps[3]!.getAttribute('aria-current')).toBe('step')
    expect(screen.getByText('Site card: Made-up result summary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Get my return label' })).toBeTruthy()
    cleanup()
    render(<MyKitPage result={{ ok: true, data: { ...data, role: 'buyer', result: null } }} actions={{}} ResultCard={ResultCard} />)
    expect(screen.queryByRole('heading', { name: 'Result' })).toBeNull()
  })

  it('MyKitPage: a kit off the usual path says so in words', () => {
    const data: MyKitData = { ...kit({ status: 'recalled', statusText: 'Recalled', step: -1, problem: 'recalled', next: null }), steps: STEPS, attempt: 2, dates: [], trackingNumbers: [], inPerson: null, result: null }
    render(<MyKitPage result={{ ok: true, data }} actions={{}} />)
    expect(screen.getByText('Needs attention: Recalled')).toBeTruthy()
    expect(screen.getByText('Attempt')).toBeTruthy()
  })

  it('MyOrderPage: the help form with amounts through the site’s price line, or the missed-date choices', () => {
    const base: MyOrderData = {
      id: 'o1', createdAt: '2026-11-01T00:00:00Z', status: 'to-pack', kitCount: 2, summary: { stage: 'packing' }, promisedBy: null, trackingNumbers: [], help: 'help', kits: [], steps: STEPS,
      options: { phase: 'help', daysLeft: 0, shipped: false, missed: false, refundableCents: 5000, keptBackCents: 850, reasons: ['changed-mind', 'other'], canCredit: false, canMoveVote: false, revisedBy: null, requests: [] },
      missedChoices: ['wait', 'refund'],
    }
    const Price = ({ cents, kind }: { cents: number; kind: string }) => <span data-kind={kind}>€{(cents / 100).toFixed(2)}</span>
    render(<MyOrderPage result={{ ok: true, data: base }} actions={{ help: noop, missed: noop }} Price={Price} />)
    expect(screen.getByText('Being packed.')).toBeTruthy()
    expect(screen.getByText(/Refund if canceled/).textContent).toContain('€41.50')
    expect(screen.getByText(/Postage already spent/).textContent).toContain('€8.50')
    cleanup()
    render(<MyOrderPage result={{ ok: true, data: { ...base, options: { ...base.options, phase: 'missed' } } }} actions={{ help: noop, missed: noop }} />)
    expect(screen.getByRole('radio', { name: 'Cancel for a full refund' })).toBeTruthy()
    expect(screen.queryByRole('radio', { name: /credit/ })).toBeNull()
  })

  it('ActivatePage: the site’s subject picker gets the choices, and a site wizard replaces the plugin’s', () => {
    const data = { choices: [{ ref: { kind: 'group', id: 'g1' }, label: 'Made-up group 1' }], guided: false, code: null, stage: 'activate' as const }
    const Picker = vi.fn(({ choices, name }: { choices: { label: string }[]; name: string }) => <input aria-label={`picker ${choices[0]!.label}`} name={name} />)
    render(<ActivatePage result={{ ok: true, data }} actions={{ activate: noop, sampled: noop }} SubjectPicker={Picker} />)
    fireEvent.change(screen.getByLabelText('Kit code'), { target: { value: '272727000001' } })
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'MADEUP12AB' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    expect(screen.getByLabelText('picker Made-up group 1')).toBeTruthy()
    expect(Picker).toHaveBeenCalled()
    expect(Picker.mock.calls[0]![0]).toMatchObject({ name: 'subject', choices: data.choices })
    cleanup()
    render(<ActivatePage result={{ ok: true, data }} actions={{ activate: noop, sampled: noop }} wizard={<p>Site wizard</p>} />)
    expect(screen.getByText('Site wizard')).toBeTruthy()
    expect(screen.queryByLabelText('Secret')).toBeNull()
  })
})

describe('text', () => {
  it('uiText keeps English for keys the site doesn’t translate, and never throws', () => {
    const text = uiText((k) => {
      if (k === 'sampleKits.ui.done') return 'Hecho'
      if (k === 'sampleKits.ui.back') throw new Error('made-up translator failure')
      return k
    })
    expect(text.done).toBe('Hecho')
    expect(text.back).toBe(UI_TEXT.back)
    expect(text.next).toBe(UI_TEXT.next)
  })
})
