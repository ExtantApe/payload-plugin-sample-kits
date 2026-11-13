// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

import { ActivationWizard, secretFromFragment, type ActivationActions, type WizardLike } from '../../src/client/index.js'
import type { ActivateData } from '../../src/server/index.js'
import { watchStorage } from './storage.js'

// Made-up kits, secrets and animals only.
const data = (over: Partial<ActivateData> = {}): ActivateData => ({
  choices: [
    { ref: { kind: 'animal', id: 'a1' }, label: 'Made-up Tortoise Pebble', suggested: false },
    { ref: { kind: 'animal', id: 'a2' }, label: 'Made-up Skink Dot', suggested: true },
  ],
  guided: false,
  code: '272727000001',
  stage: 'activate',
  ...over,
})
const okActions = (): ActivationActions & { activate: ReturnType<typeof vi.fn>; sampled: ReturnType<typeof vi.fn> } => ({
  activate: vi.fn(async (input: { code: string }) => ({ ok: true as const, data: { code: input.code, label: 'Made-up Skink Dot', message: `Kit ${input.code} is activated for Made-up Skink Dot.` } })),
  sampled: vi.fn(async (input: { code: string }) => ({ ok: true as const, data: { code: input.code, message: 'Sample recorded.' } })),
})
const heading = () => screen.getByRole('heading', { level: 2 })
const storage = watchStorage()

beforeEach(() => {
  window.history.replaceState(null, '', '/my-tests/activate?kit=272727000001')
  storage.reset()
})
afterEach(() => {
  cleanup()
  storage.check()
})

describe('secretFromFragment', () => {
  it('reads only s= from the fragment', () => {
    expect(secretFromFragment('#s=ab12-cd34')).toBe('AB12-CD34')
    expect(secretFromFragment('#x=1&s=MADEUP1234')).toBe('MADEUP1234')
    expect(secretFromFragment('#notes=MADEUP1234')).toBeNull()
    expect(secretFromFragment('')).toBeNull()
  })
})

describe('<ActivationWizard> without Wizards', () => {
  it('takes the secret from the link’s fragment, then clears the fragment, and never puts it in a query', async () => {
    window.history.replaceState(null, '', '/my-tests/activate?kit=272727000001#s=madeup12ab')
    const actions = okActions()
    render(<ActivationWizard data={data()} actions={actions} />)
    const secret = screen.getByLabelText('Secret') as HTMLInputElement
    await waitFor(() => expect(secret.value).toBe('MADEUP12AB'))
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?kit=272727000001')
    expect(window.location.href).not.toMatch(/madeup12ab/i)
    expect(screen.getByText('The secret came from the slip’s link.')).toBeTruthy()
    fireEvent.submit(secret.closest('form')!)
    fireEvent.submit(screen.getByRole('button', { name: 'Activate' }).closest('form')!)
    await waitFor(() => expect(actions.activate).toHaveBeenCalledTimes(1))
    // The secret goes in the action's body, once.
    expect(actions.activate).toHaveBeenCalledWith({ code: '272727000001', secret: 'MADEUP12AB', subject: { kind: 'animal', id: 'a2' } })
    expect(window.location.href).not.toMatch(/madeup12ab/i)
  })

  it('walks the steps by keyboard: Enter moves on, focus goes to each new heading, and the step is said in words', async () => {
    const actions = okActions()
    render(<ActivationWizard data={data()} actions={actions} />)
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
    // Not focused on first load, so the page doesn't jump.
    expect(document.activeElement).not.toBe(heading())
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'madeup12ab' } })
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('MADEUP12AB')
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    expect(heading().textContent).toBe('Who is the sample from?')
    expect(document.activeElement).toBe(heading())
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
    expect(heading().getAttribute('aria-describedby')).toBe(screen.getByText('Step 2 of 3').id)
    // Radios are labeled; the suggested one says so in words.
    fireEvent.click(screen.getByLabelText(/Made-up Tortoise Pebble/))
    expect(screen.getByText('(what it was ordered for)')).toBeTruthy()
    fireEvent.submit(screen.getByRole('button', { name: 'Activate' }).closest('form')!)
    await waitFor(() => expect(heading().textContent).toBe('Take the sample'))
    expect(document.activeElement).toBe(heading())
    expect(screen.getByRole('status').textContent).toContain('is activated')
    fireEvent.click(screen.getByRole('button', { name: 'I’ve taken the sample' }))
    await waitFor(() => expect(heading().textContent).toBe('All done'))
    expect(document.activeElement).toBe(heading())
    expect(actions.sampled).toHaveBeenCalledWith({ code: '272727000001', confirmed: { form: 'sample-kits', at: expect.any(String) } })
    // Back to the start for another kit, with nothing left over.
    fireEvent.click(screen.getByRole('button', { name: 'Activate another kit' }))
    expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Kit code') as HTMLInputElement).value).toBe('')
  })

  it('says what’s missing in the alert region, which is on the page from the start', async () => {
    const actions = okActions()
    render(<ActivationWizard data={data({ code: null })} actions={actions} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('')
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    expect(alert.textContent).toContain('Enter the kit code from the slip.')
    fireEvent.change(screen.getByLabelText('Kit code'), { target: { value: '272727000001' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    expect(screen.getByRole('alert').textContent).toContain('Enter the secret from the slip.')
    expect(screen.getByRole('alert').textContent).toMatch(/^Not done:/)
    expect(actions.activate).not.toHaveBeenCalled()
  })

  it('shows a refusal in plain words and stays on the step, with a way back', async () => {
    const actions = okActions()
    actions.activate.mockResolvedValueOnce({ ok: false, error: { code: 'badSecret', message: 'That code and secret don’t match a kit. Check both on the slip.' } })
    render(<ActivationWizard data={data()} actions={actions} />)
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'WRONG12345' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    fireEvent.submit(screen.getByRole('button', { name: 'Activate' }).closest('form')!)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Check both on the slip.'))
    expect(heading().textContent).toBe('Who is the sample from?')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(heading().textContent).toBe('Find your kit')
    expect(document.activeElement).toBe(heading())
  })

  it('needs a subject chosen, and says so when there’s nothing to choose', async () => {
    const actions = okActions()
    render(<ActivationWizard data={data({ choices: [] })} actions={actions} />)
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'MADEUP12AB' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    expect(screen.getByText(/You have nothing to sample yet/)).toBeTruthy()
    fireEvent.submit(screen.getByRole('button', { name: 'Activate' }).closest('form')!)
    expect(screen.getByRole('alert').textContent).toContain('Choose who the sample is from.')
    expect(actions.activate).not.toHaveBeenCalled()
  })

  it('takes the site’s own subject picker as a slot', async () => {
    const actions = okActions()
    const picker = (
      <label>
        Site picker
        <select name="subject" defaultValue="group:g9">
          <option value="group:g9">Made-up group 9</option>
        </select>
      </label>
    )
    render(<ActivationWizard data={data()} actions={actions} subjectPicker={picker} />)
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'MADEUP12AB' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    fireEvent.submit(screen.getByLabelText('Site picker').closest('form')!)
    await waitFor(() => expect(actions.activate).toHaveBeenCalledWith(expect.objectContaining({ subject: { kind: 'group', id: 'g9' } })))
  })

  it('starts at the sample when the kit is already activated by this person', () => {
    render(<ActivationWizard data={data({ stage: 'sample' })} actions={okActions()} />)
    expect(heading().textContent).toBe('Take the sample')
    expect(screen.queryByLabelText('Secret')).toBeNull()
  })

  it('uses the site’s translated words', () => {
    render(<ActivationWizard data={data()} actions={okActions()} text={{ findKit: 'Encuentra tu kit', stepOf: 'Paso {n} de {m}' }} />)
    expect(heading().textContent).toBe('Encuentra tu kit')
    expect(screen.getByText('Paso 1 de 3')).toBeTruthy()
  })

  it('keeps every button at least 44 pixels high', () => {
    render(<ActivationWizard data={data()} actions={okActions()} />)
    for (const b of screen.getAllByRole('button')) expect(parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    for (const i of [screen.getByLabelText('Kit code'), screen.getByLabelText('Secret')]) expect(parseInt((i as HTMLElement).style.minHeight, 10)).toBeGreaterThanOrEqual(44)
  })
})

/** A stand-in with the shape of Wizards' `<Wizard>`: one screen per slot, `next` moves on, the last calls onFinish. */
const FakeWizard: WizardLike = ({ slots, renderCode, onFinish }) => {
  const [i, setI] = useState(0)
  const slot = slots[i] as { code?: string; step?: { key: string } }
  const next = () => (i < slots.length - 1 ? setI(i + 1) : void Promise.resolve(onFinish({ answers: [{ key: 'safe', hash: 'h', value: 'yes' }] })).catch(() => undefined))
  let body: ReactNode
  if (slot?.code) body = renderCode[slot.code]!({ next, back: () => setI(Math.max(0, i - 1)) })
  else
    body = (
      <button type="button" onClick={next}>
        Yes, safe
      </button>
    )
  return <div data-testid="wizard" data-slots={slots.map((s) => (s as { code?: string }).code ?? 'step').join(',')}>{body}</div>
}
const SLOTS = [{ code: 'find-kit' }, { code: 'choose-subject' }, { step: { key: 'safe' } }, { code: 'sampled' }]

describe('<ActivationWizard> with Wizards passed in', () => {
  it('runs the guided steps between choosing and the sample, and sends the answers with the language', async () => {
    window.history.replaceState(null, '', '/my-tests/activate?kit=272727000001#s=MADEUP12AB')
    const actions = okActions()
    render(<ActivationWizard data={data({ guided: true })} actions={actions} Wizard={FakeWizard} wizardSlots={SLOTS} locale="es" />)
    await waitFor(() => expect((screen.getByLabelText('Secret') as HTMLInputElement).value).toBe('MADEUP12AB'))
    expect(window.location.hash).toBe('')
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    fireEvent.submit(screen.getByRole('button', { name: 'Activate' }).closest('form')!)
    await waitFor(() => screen.getByRole('button', { name: 'Yes, safe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, safe' }))
    fireEvent.click(screen.getByRole('button', { name: 'I’ve taken the sample' }))
    await waitFor(() => expect(actions.sampled).toHaveBeenCalledWith({ code: '272727000001', answers: [{ key: 'safe', hash: 'h', value: 'yes' }], locale: 'es' }))
    await waitFor(() => expect(heading().textContent).toBe('All done'))
    expect(actions.sampled.mock.calls[0]![0]).not.toHaveProperty('confirmed')
  })

  it('skips finding and choosing for a kit already activated', () => {
    render(<ActivationWizard data={data({ guided: true, stage: 'sample' })} actions={okActions()} Wizard={FakeWizard} wizardSlots={SLOTS} />)
    expect(screen.getByTestId('wizard').dataset.slots).toBe('step,sampled')
  })

  it('announces a refused sample, and lets the person try again', async () => {
    const actions = okActions()
    actions.sampled.mockResolvedValueOnce({ ok: false, error: { code: 'stepsChanged', message: 'The steps changed while you were reading them.' } })
    render(<ActivationWizard data={data({ guided: true, stage: 'sample' })} actions={actions} Wizard={FakeWizard} wizardSlots={SLOTS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, safe' }))
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'I’ve taken the sample' })))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The steps changed'))
    expect(screen.queryByText('All done')).toBeNull()
  })
})
