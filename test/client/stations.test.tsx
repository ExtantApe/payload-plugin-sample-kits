// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionButton, ActionForm, LabUploader, MissedChoiceForm, OrderHelpForm, ReturnLabelButton, ScanStation, SlipMaker, toBase64 } from '../../src/client/index.js'
import { watchStorage } from './storage.js'

// Made-up codes, files and messages only.
const storage = watchStorage()
beforeEach(() => storage.reset())
afterEach(() => {
  cleanup()
  storage.check()
})

const scanOk = (outcome: 'done' | 'already' | 'warning' = 'done') => vi.fn(async (input: { code: string }) => ({ ok: true as const, data: { code: input.code, outcome, message: `Kit ${input.code}: made-up answer.` } }))

describe('<ScanStation>', () => {
  it('takes a scanner’s Enter, sends the code with the page’s own fields, logs it in words, and is ready for the next', async () => {
    const pack = scanOk()
    const unpack = scanOk()
    render(<ScanStation extra={{ order: 'order-1' }} modes={[{ key: 'pack', label: 'Pack into this order', action: pack }, { key: 'unpack', label: 'Take out of this order', action: unpack }]} />)
    const input = screen.getByLabelText('Kit code') as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.change(input, { target: { value: ' 272727000001 ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(pack).toHaveBeenCalledWith({ order: 'order-1', code: '272727000001' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('made-up answer'))
    expect(screen.getByRole('listitem').textContent).toMatch(/^Done: Kit 272727000001/)
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    // The mode is a labeled radio group, changed by keyboard or click.
    fireEvent.click(screen.getByLabelText('Take out of this order'))
    fireEvent.change(input, { target: { value: '272727000002' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(unpack).toHaveBeenCalledWith({ order: 'order-1', code: '272727000002' }))
  })

  it('announces a refusal in the alert region and logs it as "Not done", not by color', async () => {
    const receive = vi.fn(async () => ({ ok: false as const, error: { code: 'unknownLot', message: 'Add lot 272727 first, then scan again.' } }))
    render(<ScanStation modes={[{ key: 'receive', label: 'Receive', action: receive }]} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('')
    fireEvent.change(screen.getByLabelText('Kit code'), { target: { value: '272727000009' } })
    fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not done: Add lot 272727 first, then scan again.'))
    expect(screen.getByRole('listitem').textContent).toMatch(/^Not done:/)
  })

  it('shows "Already done" and "Warning" in words, and a thrown action plainly', async () => {
    const already = scanOk('already')
    const warn = scanOk('warning')
    const broken = vi.fn(async () => {
      throw new Error('made-up network failure at /internal/path')
    })
    render(<ScanStation modes={[{ key: 'a', label: 'A', action: already }, { key: 'w', label: 'W', action: warn }, { key: 'b', label: 'B', action: broken }]} />)
    const scan = async (mode: string, code: string) => {
      fireEvent.click(screen.getByLabelText(mode))
      fireEvent.change(screen.getByLabelText('Kit code'), { target: { value: code } })
      fireEvent.submit(screen.getByLabelText('Kit code').closest('form')!)
      await waitFor(() => expect(screen.getAllByRole('listitem')[0]!.textContent).toContain(code === 'x' ? 'Not done' : code))
    }
    await scan('A', '1')
    await scan('W', '2')
    await scan('B', 'x')
    const lines = screen.getAllByRole('listitem').map((l) => l.textContent)
    expect(lines[2]).toMatch(/^Already done:/)
    expect(lines[1]).toMatch(/^Warning:/)
    expect(lines[0]).toMatch(/^Not done:/)
    expect(document.body.textContent).not.toContain('/internal/path')
  })

  it('offers the hub for check-in, and passes the site’s camera its own callback', async () => {
    const checkIn = scanOk()
    const Camera = ({ onCode }: { onCode: (c: string) => void }) => (
      <button type="button" onClick={() => onCode('272727000003')}>
        Scan with camera
      </button>
    )
    render(<ScanStation hubs={[{ id: 'h1', name: 'Made-up Hub' }, { id: 'h2', name: 'Made-up Hub Two' }]} modes={[{ key: 'checkIn', label: 'Check in', action: checkIn }]} Camera={Camera} />)
    fireEvent.change(screen.getByLabelText('Hub'), { target: { value: 'h2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }))
    await waitFor(() => expect(checkIn).toHaveBeenCalledWith({ hub: 'h2', code: '272727000003' }))
  })
})

describe('<LabUploader>', () => {
  it('previews which kit each file is for, sends only those that can go, as base64, one at a time', async () => {
    const preview = vi.fn(async (input: { items: { name: string; header: string | null; size: number }[] }) => ({
      ok: true as const,
      data: {
        matches: input.items.map((i) =>
          i.name.startsWith('272727')
            ? { name: i.name, code: '272727000001', outcome: 'ready' as const, explanation: 'Ready to send.' }
            : { name: i.name, code: null, outcome: 'unmatched' as const, reason: 'noCode' as const, explanation: 'No kit code in the file name or the first line. Rename the file to start with the kit code.' },
        ),
      },
    }))
    const upload = vi.fn(async (input: { name: string } | { fileId: string }) => ({ ok: true as const, data: { result: 'received' as const, code: '272727000001', rerun: false, message: `Kit 272727000001: result received (${'name' in input ? input.name : input.fileId}).` } }))
    render(<LabUploader lab="lab-1" upload={{ extensions: ['.fasta', '.txt'], maxBytes: 900_000 }} actions={{ preview, upload }} />)
    const input = screen.getByLabelText('Choose result files') as HTMLInputElement
    expect(input.getAttribute('accept')).toBe('.fasta,.txt')
    expect(screen.getByText(/Largest file: 900 KB/)).toBeTruthy()
    const good = new File(['>272727000001 made-up\nACGT\n'], '272727000001.fasta', { type: 'text/plain' })
    const bad = new File(['ACGT'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [good, bad] } })
    await waitFor(() => expect(preview).toHaveBeenCalled())
    expect(preview.mock.calls[0]![0]).toMatchObject({ lab: 'lab-1', items: [{ name: '272727000001.fasta', header: '>272727000001 made-up', size: 27 }, { name: 'notes.txt', header: null, size: 4 }] })
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    expect(screen.getByText(/Rename the file/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send the files (1)' }))
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(upload).toHaveBeenCalledWith({ lab: 'lab-1', name: '272727000001.fasta', data: toBase64(new TextEncoder().encode('>272727000001 made-up\nACGT\n')) })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Sent: 1. Not taken: 0; see why below.'))
  })

  it('with uploads by file id, puts each file in the site’s storage first and sends only its id', async () => {
    const preview = vi.fn(async () => ({ ok: true as const, data: { matches: [{ name: '272727000001.fasta', code: '272727000001', outcome: 'ready' as const, explanation: 'Ready to send.' }, { name: '272727000002.fasta', code: '272727000002', outcome: 'ready' as const, explanation: 'Ready to send.' }] } }))
    const upload = vi.fn(async () => ({ ok: true as const, data: { result: 'received' as const, code: '272727000001', rerun: false, message: 'Kit 272727000001: result received.' } }))
    const uploader = vi.fn(async (f: { name: string }) => {
      if (f.name.includes('02')) throw new Error('made-up storage failure')
      return { fileId: 'made-up-file-1' }
    })
    render(<LabUploader lab="lab-1" upload={{ extensions: ['.fasta'], maxBytes: 900_000, by: 'fileId' }} actions={{ preview, upload }} uploader={uploader} />)
    const files = [new File(['>272727000001\nACGT\n'], '272727000001.fasta', { type: 'text/plain' }), new File(['>272727000002\nACGT\n'], '272727000002.fasta', { type: 'text/plain' })]
    fireEvent.change(screen.getByLabelText('Choose result files'), { target: { files } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send the files (2)' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Send the files (2)' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Sent: 1. Not taken: 1; see why below.'))
    expect(uploader.mock.calls[0]![0]).toMatchObject({ name: '272727000001.fasta', type: 'text/plain' })
    // Only the id goes through the action: never the bytes.
    expect(upload.mock.calls).toEqual([[{ lab: 'lab-1', fileId: 'made-up-file-1' }]])
    expect(screen.getByText(/The file couldn’t be uploaded/)).toBeTruthy()
  })

  it('says plainly when the preview is refused', async () => {
    const preview = vi.fn(async () => ({ ok: false as const, error: { code: 'notLab', message: 'This page is for the labs we work with.' } }))
    render(<LabUploader lab="lab-1" upload={{ extensions: ['.fasta'], maxBytes: 900_000 }} actions={{ preview, upload: vi.fn() }} />)
    fireEvent.change(screen.getByLabelText('Choose result files'), { target: { files: [new File(['x'], 'a.fasta')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('This page is for the labs we work with.'))
  })

  it('encodes large files without overflowing', () => {
    const big = new Uint8Array(200_000).fill(65)
    expect(atob(toBase64(big)).length).toBe(200_000)
  })
})

describe('forms', () => {
  it('ActionButton asks in the page first, moves focus to the question, and Cancel sends nothing', async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { message: 'Pre-orders moved to packing: 3.' } }))
    render(<ActionButton action={action} label="Release all pre-orders" confirm="This moves 3 pre-orders into packing." />)
    fireEvent.click(screen.getByRole('button', { name: 'Release all pre-orders' }))
    await waitFor(() => expect(document.activeElement?.textContent).toContain('This moves 3 pre-orders'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Release all pre-orders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, go ahead' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Pre-orders moved to packing: 3.'))
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('ActionForm labels every field, sends typed values, and refocuses the first field on a refusal', async () => {
    const action = vi.fn(async () => ({ ok: false as const, error: { code: 'lotNumber', message: 'A lot number is 3 to 12 digits.' } }))
    render(
      <ActionForm
        action={action}
        submit="Add lot"
        fields={[
          { name: 'lotNumber', label: 'Lot number', type: 'text', help: '3 to 12 digits.' },
          { name: 'firstSerial', label: 'First serial', type: 'number' },
          { name: 'confirm', label: 'I understand', type: 'checkbox' },
          { name: 'order', label: '', type: 'hidden', value: 'order-9' },
        ]}
      />,
    )
    const lot = screen.getByLabelText('Lot number')
    expect(lot.getAttribute('aria-describedby')).toBe(screen.getByText('3 to 12 digits.').id)
    fireEvent.change(lot, { target: { value: ' 12 ' } })
    fireEvent.change(screen.getByLabelText('First serial'), { target: { value: '7' } })
    fireEvent.click(screen.getByLabelText('I understand'))
    fireEvent.click(screen.getByRole('button', { name: 'Add lot' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith({ lotNumber: '12', firstSerial: 7, confirm: true, order: 'order-9' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('3 to 12 digits'))
    expect(document.activeElement).toBe(lot)
  })

  it('OrderHelpForm sends the chosen reasons and the kept-back amount shown, then locks', async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { outcome: 'review', message: 'Thanks. We’ve got your request.' } }))
    render(<OrderHelpForm order="order-1" reasons={['changed-mind', 'other']} keptBackCents={850} keptBackLine={<span>$8.50</span>} action={action} />)
    expect(screen.getByRole('group', { name: 'What’s wrong?' })).toBeTruthy()
    expect(screen.getByText(/Postage already spent/).textContent).toContain('$8.50')
    fireEvent.click(screen.getByLabelText('I changed my mind'))
    fireEvent.change(screen.getByLabelText(/Anything else/), { target: { value: 'Made-up detail.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith({ order: 'order-1', reasons: ['changed-mind'], details: 'Made-up detail.', confirmKeptBack: 850 }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('got your request'))
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('MissedChoiceForm asks where the vote goes only when moving it', async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { outcome: 'reallocated', message: 'Your vote has moved.' } }))
    render(<MissedChoiceForm order="order-1" choices={['wait', 'reallocate', 'refund']} action={action} />)
    expect(screen.queryByLabelText(/Where should the vote go/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Move my vote to something else'))
    fireEvent.change(screen.getByLabelText(/Where should the vote go/), { target: { value: 'item-7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm my choice' }))
    await waitFor(() => expect(action).toHaveBeenCalledWith({ order: 'order-1', choice: 'reallocate', item: 'item-7' }))
  })

  it('ReturnLabelButton gives a link that says it opens a new tab, and moves focus to it', async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { labelUrl: 'https://labels.example.test/made-up.pdf', message: 'Your return label is ready.' } }))
    render(<ReturnLabelButton code="272727000001" action={action} />)
    fireEvent.click(screen.getByRole('button', { name: 'Get my return label' }))
    const link = await screen.findByRole('link', { name: 'Open the label (opens in a new tab)' })
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    await waitFor(() => expect(document.activeElement).toBe(link))
  })

  it('SlipMaker asks first, then shows each kit’s barcode, secret and link, with focus on the slip', async () => {
    const action = vi.fn(async () => ({ ok: true as const, data: { kits: [{ code: '272727000001', secret: 'MADEUP12AB', link: 'https://kits.example.test/my-tests/activate?kit=272727000001#s=MADEUP12AB', label: null }] } }))
    render(<SlipMaker order="order-1" action={action} />)
    fireEvent.click(screen.getByRole('button', { name: 'Make the slip' }))
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, go ahead' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Slip: print it now' })).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Slip: print it now' }))
    expect(screen.getByRole('img', { name: 'Kit 272727000001' })).toBeTruthy()
    expect(screen.getByText('MADEUP12AB')).toBeTruthy()
  })
})
