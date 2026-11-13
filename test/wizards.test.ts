import { answersFor, flowsOf, flowSteps, wizardsPlugin } from '@extantape/payload-plugin-wizards'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLot, findKit, KIT_ACTIVATION_FLOW, KitError, markSampled, recordKitEvent, type WizardsAdapter } from '../src/index.js'
import { reqAs } from '../src/testing.js'
import { person, startPayload, stopMongo, type Harness } from './harness.js'

// The guided activation through Wizards' own `answersFor` (a devDependency, used only here): `markSampled` checks the
// answers on the server. Made-up people, steps and kits.
type Person = Awaited<ReturnType<typeof person>>
let h: Harness
let payload: Payload
let staffA: Person, keeper: Person
const LOT = '565656'
let serial = 0
const as = (u: Person | null) => reqAs(payload, u as never)
async function kitErr(p: Promise<unknown>, code: string): Promise<KitError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, `expected KitError ${code}`).toBeInstanceOf(KitError)
  expect((error as KitError).code).toBe(code)
  return error as KitError
}

// Wizards' own function fits the adapter's type.
const wizards: WizardsAdapter = { answersFor }

/** A kit the keeper activated for their own subject. */
async function activated() {
  const code = `${LOT}${String(++serial).padStart(6, '0')}`
  const k = (await findKit(await as(staffA), code, 'A'))!
  await recordKitEvent(await as(staffA), k, { type: 'activated', set: { activatedBy: keeper.id, activatedAt: new Date().toISOString(), subjectKind: 'animal', subjectId: 'w1' } })
  return code
}
/** The answers a person who read every step and said yes would send. */
async function goodAnswers() {
  const { slots } = await flowSteps(payload, { flow: KIT_ACTIVATION_FLOW })
  return slots.flatMap((s) => ('step' in s ? [{ key: s.step.key, hash: s.step.hash, value: s.step.kind === 'info' ? 'seen' : 'yes' }] : []))
}
const status = async (code: string) => (await findKit(await as(staffA), code, 'A'))!.status
const step = (key: string, kind: 'gate' | 'info', question: string, order: number) =>
  payload.create({ collection: 'guided-steps' as never, data: { flow: KIT_ACTIVATION_FLOW, key, group: 'safety', kind, question, body: `Made-up text for ${key}.`, stopMessage: 'Made-up: stop and ask us.', order, active: true } as never, overrideAccess: true })

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, adapters: { wizards } }), { plugins: [wizardsPlugin({ access: { edit: () => false }, media: false })] })
  payload = h.payload
  staffA = await person(payload, 'A', 'staff')
  keeper = await person(payload, 'A')
  h.subjects.add({ kind: 'animal', id: 'w1', owner: String(keeper.id), name: 'Made-up gecko' })
  await createLot(await as(staffA), { lotNumber: LOT, expiresOn: '2099-01-01', firstSerial: 1, lastSerial: 20 })
  await step('gloves', 'gate', 'Are you wearing gloves?', 1)
  await step('calm', 'gate', 'Is the animal calm?', 2)
  await step('video', 'info', 'Watch how to swab.', 3)
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await stopMongo()
})

describe('guided activation (Wizards)', () => {
  it('registers the kit-activation flow with its four slots', () => {
    expect(flowsOf(payload)[KIT_ACTIVATION_FLOW]).toEqual({ slots: [{ code: 'find-kit' }, { code: 'choose-subject' }, { steps: 'safety' }, { code: 'sampled' }] })
  })

  it('stores Wizards’ record on the kit’s event when every step was answered yes', async () => {
    const code = await activated()
    await markSampled(await as(keeper), { code, answers: await goodAnswers() })
    expect(await status(code)).toBe('sampled')
    const ev = (await payload.find({ collection: 'kit-events', where: { type: { equals: 'sampled' } }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true })).docs[0]!
    const confirmed = (ev.details as { confirmed: { flow: string; answers: { key: string; value: string; question: string; hash: string }[] } }).confirmed
    expect(confirmed.flow).toBe(KIT_ACTIVATION_FLOW)
    expect(confirmed.answers.map((a) => [a.key, a.value])).toEqual([['gloves', 'yes'], ['calm', 'yes'], ['video', 'seen']])
    expect(confirmed.answers[0]!.question).toBe('Are you wearing gloves?')
  })

  it('refuses a skipped gate, a No, a missing answer list and a record the client made up', async () => {
    const code = await activated()
    const good = await goodAnswers()
    const skipped = await kitErr(markSampled(await as(keeper), { code, answers: good.filter((a) => a.key !== 'calm') }), 'stepsIncomplete')
    expect(skipped.vars).toMatchObject({ problem: 'missing', step: 'calm' })
    await kitErr(markSampled(await as(keeper), { code, answers: good.map((a) => (a.key === 'gloves' ? { ...a, value: 'no' } : a)) }), 'stepsIncomplete')
    await kitErr(markSampled(await as(keeper), { code }), 'stepsIncomplete')
    await kitErr(markSampled(await as(keeper), { code, confirmed: { flow: KIT_ACTIVATION_FLOW, answers: [] } }), 'badConfirmed')
    expect(await status(code)).toBe('activated')
  })

  it('refuses answers to wording that has changed since the screen loaded', async () => {
    const code = await activated()
    const stale = await goodAnswers()
    const gloves = (await payload.find({ collection: 'guided-steps' as never, where: { key: { equals: 'gloves' } } as never, overrideAccess: true })).docs[0] as { id: string }
    await payload.update({ collection: 'guided-steps' as never, id: gloves.id, data: { question: 'Are you wearing clean gloves?' } as never, overrideAccess: true })
    const e = await kitErr(markSampled(await as(keeper), { code, answers: stale }), 'stepsChanged')
    expect(e.vars).toMatchObject({ problem: 'changed', step: 'gloves' })
    expect(await status(code)).toBe('activated')
    await markSampled(await as(keeper), { code, answers: await goodAnswers() })
    expect(await status(code)).toBe('sampled')
  })

  it('refuses every answer while the safety group is empty, so an emptied group never waves a sample through', async () => {
    const code = await activated()
    const answers = await goodAnswers()
    await payload.update({ collection: 'guided-steps' as never, where: { group: { equals: 'safety' } } as never, data: { active: false } as never, overrideAccess: true })
    try {
      const e = await kitErr(markSampled(await as(keeper), { code, answers }), 'stepsUnavailable')
      expect(e.vars).toMatchObject({ problem: 'noSteps' })
      await kitErr(markSampled(await as(keeper), { code, answers: [] }), 'stepsUnavailable')
      expect(await status(code)).toBe('activated')
    } finally {
      await payload.update({ collection: 'guided-steps' as never, where: { group: { equals: 'safety' } } as never, data: { active: true } as never, overrideAccess: true })
    }
  })

  it('refuses when Wizards fails or answers anything but ok', async () => {
    const code = await activated()
    const o = (payload.config.custom as { sampleKits: { adapters: { wizards: WizardsAdapter } } }).sampleKits
    const real = o.adapters.wizards
    try {
      o.adapters.wizards = { answersFor: async () => { throw new Error('made-up Wizards failure') } }
      await kitErr(markSampled(await as(keeper), { code, answers: await goodAnswers() }), 'stepsUnavailable')
      // Anything but exactly ok, even with a record, refuses.
      for (const ok of ['yes', 1, undefined]) {
        o.adapters.wizards = { answersFor: async () => ({ ok, record: { flow: KIT_ACTIVATION_FLOW, at: new Date().toISOString(), locale: null, answers: [] } }) as never }
        await kitErr(markSampled(await as(keeper), { code, answers: await goodAnswers() }), 'stepsIncomplete')
      }
      o.adapters.wizards = { answersFor: async () => ({ ok: true }) as never }
      await kitErr(markSampled(await as(keeper), { code, answers: await goodAnswers() }), 'stepsIncomplete')
      expect(await status(code)).toBe('activated')
    } finally {
      o.adapters.wizards = real
    }
  })
})
