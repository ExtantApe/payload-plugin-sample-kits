import type { Access, CollectionConfig, Config, Field, Plugin } from 'payload'

import { hasShipping } from './carrier.js'
import { kitCollections } from './collections.js'
import { indexesAtStartup } from './indexes.js'
import { ORDER_FIELD_NAMES, orderFields, PRODUCT_FIELD_NAMES, productFields } from './orderFields.js'
import { KIT_ACTIVATION_FLOW } from './kits.js'
import { scanRegistration } from './scan.js'
import { checkSiteInfo } from './site.js'
import { shippingHandler } from './tracking.js'
import { isWhere, topLevelFields } from './internal.js'
import { KIT_COLLECTION_SLUGS, type KitCollectionSlug, LABEL_MEMBERS, type ResolvedOptions, type SampleKitsOptions } from './types.js'

/**
 * Sample Kits for Payload. Adds the ten kit collections, with the site's own fields and changes
 * brought in by option, and keeps the options at `config.custom.sampleKits` for the actions.
 */
export const sampleKits =
  (options: SampleKitsOptions): Plugin =>
  (config: Config): Config => {
    const o = checkOptions(options, config)
    // Two builds: the site's override gets one to change as it likes; the other stays untouched, so
    // the plugin's rules can be put back from it whatever the override did.
    const given = kitCollections(o)
    const pristine = kitCollections(o)
    const collections = pristine.map((base, i) => {
      const override = o.overrides?.[base.slug as KitCollectionSlug]
      if (!override) return base
      const copy = given[i]!
      const seen = functionsOf(copy)
      return protect(base, override(copy), seen)
    })
    // The kit fields on the site's orders and products. Products are skipped when there's no such collection.
    const site = (config.collections ?? []).map((c) => {
      if (c.slug === o.collections.orders) return { ...c, fields: [...c.fields, ...orderFields(o)] }
      if (c.slug === o.collections.products) return { ...c, fields: [...c.fields, ...productFields()] }
      return c
    })
    // Tracking and refund answers from Shipping's webhook, through Shipping's own registry, only when Shipping is wired.
    const handlers = (config.custom?.shippingHandlers as unknown[] | undefined) ?? []
    const custom: Record<string, unknown> = { ...config.custom, sampleKits: o, ...(hasShipping(o) ? { shippingHandlers: [...handlers, shippingHandler] } : {}) }
    // Scan's and Wizards' registries, read by them at call time; only when the site turns each on.
    if (o.adapters?.scan) custom.scanKinds = [...((config.custom?.scanKinds as unknown[] | undefined) ?? []), scanRegistration()]
    if (o.adapters?.wizards) custom.wizardFlows = [...((config.custom?.wizardFlows as unknown[] | undefined) ?? []), { owner: 'sample-kits', flows: { [KIT_ACTIVATION_FLOW]: KIT_ACTIVATION_SLOTS } }]
    // The unique claims behind label purchases and refunds: made at start-up, or (manual) checked; start-up fails without them.
    const onInit = async (payload: Parameters<NonNullable<Config['onInit']>>[0]) => {
      await config.onInit?.(payload)
      await indexesAtStartup(payload, o)
    }
    return { ...config, collections: [...site, ...collections], custom, onInit }
  }

/** The guided activation: the site's find-kit and choose-subject screens, every active safety step, then sampled. */
export const KIT_ACTIVATION_SLOTS = { slots: [{ code: 'find-kit' }, { code: 'choose-subject' }, { steps: 'safety' }, { code: 'sampled' }] }

// ---------------------------------------------------------------- start-up checks

export const fail = (message: string): never => {
  throw new Error(`Sample Kits: ${message}`)
}
const isFn = (v: unknown) => typeof v === 'function'

export function checkOptions(options: SampleKitsOptions, config: Config): ResolvedOptions {
  if (!options || typeof options !== 'object') fail('sampleKits() needs its options: access, subjects and tests.')
  const { access, subjects, tests, scope, overrides } = options
  if (!access || typeof access !== 'object') fail('`access` is required: { staff, admin, maintainer }, each (req) => boolean.')
  for (const k of ['staff', 'admin', 'maintainer'] as const) if (!isFn(access[k])) fail(`\`access.${k}\` must be a function (req) => boolean.`)
  if (access.buyerOf !== undefined && !isFn(access.buyerOf)) fail('`access.buyerOf` must be a function that returns a query, or left out.')

  if (!subjects || typeof subjects !== 'object') fail('`subjects` is required: the subject provider (fields, suggestedOf, sampledOf, assign, canSample).')
  if (!Array.isArray(subjects.fields)) fail('`subjects.fields` must be a list of fields (it may be empty).')
  for (const k of ['suggestedOf', 'sampledOf', 'assign', 'canSample'] as const) if (!isFn(subjects[k])) fail(`\`subjects.${k}\` must be a function.`)
  for (const k of ['choices', 'label', 'canSell'] as const) if (subjects[k] !== undefined && !isFn(subjects[k])) fail(`\`subjects.${k}\` must be a function, or left out.`)
  if (subjects.kinds !== undefined && (!Array.isArray(subjects.kinds) || !subjects.kinds.length || subjects.kinds.some((k) => typeof k !== 'string' || !k))) fail('`subjects.kinds` must be a list of names, or left out.')

  if (!Array.isArray(tests) || !tests.length) fail('`tests` is required: the tests a kit can carry, e.g. [{ label: \'Cytochrome b\', value: \'cyt-b\' }].')
  if (tests.some((t) => !t || typeof t.label !== 'string' || !t.label || typeof t.value !== 'string' || !t.value)) fail('each test needs a `label` and a `value`.')
  if (new Set(tests.map((t) => t.value)).size !== tests.length) fail('two tests have the same `value`.')

  if (scope !== undefined) {
    if (!scope || typeof scope.field !== 'string' || !scope.field) fail('`scope.field` must name the field that holds a record’s site, e.g. "tenant".')
    if (!isFn(scope.of)) fail('`scope.of` must be a function (req) => the site’s id, or null.')
  }

  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== 'object') fail('`overrides` must be an object of slug → (collection) => collection.')
    for (const [slug, fn] of Object.entries(overrides)) {
      if (!(KIT_COLLECTION_SLUGS as readonly string[]).includes(slug)) fail(`\`overrides\` names "${slug}", which isn’t one of the plugin’s collections (${KIT_COLLECTION_SLUGS.join(', ')}).`)
      if (!isFn(fn)) fail(`\`overrides["${slug}"]\` must be a function (collection) => collection.`)
    }
  }
  for (const k of ['results', 'payments', 'policy', 'adapters', 'i18n'] as const) if (options[k] !== undefined && (options[k] === null || typeof options[k] !== 'object')) fail(`\`${k}\` must be an object, or left out.`)
  if (options.ensureIndexes !== undefined && !['startup', 'manual'].includes(options.ensureIndexes)) fail('`ensureIndexes` must be "startup" or "manual".')
  if (options.preorders !== undefined && (!options.preorders || typeof options.preorders !== 'object' || (options.preorders.voteItems !== undefined && (typeof options.preorders.voteItems !== 'string' || !options.preorders.voteItems))))
    fail('`preorders` must be an object, with `voteItems` a collection slug or left out.')
  if (scope?.isLabUser !== undefined && !isFn(scope.isLabUser)) fail('`scope.isLabUser` must be a function (req, lab) => boolean, or left out.')
  if (options.results !== undefined) for (const k of ['accept', 'view'] as const) if (!isFn(options.results[k])) fail(`\`results.${k}\` must be a function.`)
  if (options.results?.verifyUpload !== undefined && !isFn(options.results.verifyUpload)) fail('`results.verifyUpload` must be a function ({ fileId, req }) => { fileId, name, size, type, sha256 }, or left out.')
  const cap = options.results?.maxBase64Bytes
  if (cap !== undefined && !(Number.isInteger(cap) && cap > 0)) fail('`results.maxBase64Bytes` must be a whole number of bytes above 0, or left out.')
  if (options.adapters?.events !== undefined) {
    const ev = options.adapters.events
    if (!ev || !isFn(ev.dropOffChoices)) fail('`adapters.events.dropOffChoices` must be a function.')
    if (ev.dateOf !== undefined && !isFn(ev.dateOf)) fail('`adapters.events.dateOf` must be a function, or left out.')
  }
  for (const k of ['notify', 'onPreorderVote'] as const) if (options[k] !== undefined && !isFn(options[k])) fail(`\`${k}\` must be a function, or left out.`)
  const shipping = options.adapters?.shipping
  if (shipping !== undefined) {
    if (!shipping || typeof shipping !== 'object') fail('`adapters.shipping` must be an object of Shipping’s functions, or left out.')
    for (const [k, v] of Object.entries(shipping)) if (v !== undefined && !isFn(v)) fail(`\`adapters.shipping.${k}\` must be a function, or left out.`)
    const given = LABEL_MEMBERS.filter((k) => isFn(shipping[k]))
    if (given.length && given.length !== LABEL_MEMBERS.length) fail(`\`adapters.shipping\` needs all of ${LABEL_MEMBERS.join(', ')} for labels, or none of them. Missing: ${LABEL_MEMBERS.filter((k) => !given.includes(k)).join(', ')}.`)
  }
  const kitting = options.adapters?.kitting
  if (kitting !== undefined) {
    if (!kitting || typeof kitting !== 'object') fail('`adapters.kitting` must be an object of Kitting’s functions, or left out.')
    for (const k of ['assignUnits', 'swapUnit', 'release', 'shipUnits', 'voidUnit'] as const) if (!isFn(kitting[k])) fail(`\`adapters.kitting.${k}\` must be Kitting’s \`${k}\`.`)
    for (const k of ['sendPendingAlerts', 'reference'] as const) if (kitting[k] !== undefined && !isFn(kitting[k])) fail(`\`adapters.kitting.${k}\` must be a function, or left out.`)
    const r = kitting.recipe as Record<string, unknown> | undefined
    if (!r || typeof r !== 'object' || !((typeof r.key === 'string' && r.key) || typeof r.id === 'string' || typeof r.id === 'number')) fail('`adapters.kitting.recipe` must name the sample kit’s recipe: { key } or { id }.')
    for (const k of ['units', 'scopeField'] as const) if (kitting[k] !== undefined && (typeof kitting[k] !== 'string' || !kitting[k])) fail(`\`adapters.kitting.${k}\` must be a name, or left out.`)
  }
  const scan = options.adapters?.scan
  if (scan !== undefined && scan !== true) {
    if (!scan || typeof scan !== 'object') fail('`adapters.scan` must be true, { paths }, or left out.')
    const paths = (scan as { paths?: unknown }).paths
    if (paths !== undefined && (!paths || typeof paths !== 'object' || Object.entries(paths).some(([k, v]) => !['kit', 'activate', 'order', 'myOrder'].includes(k) || !isFn(v))))
      fail('`adapters.scan.paths` takes kit, activate, order and myOrder, each a function that gives a path on this site.')
  }
  if (options.adapters?.seed !== undefined && (!options.adapters.seed || !isFn(options.adapters.seed.allow))) fail('`adapters.seed.allow` must be the seed plugin’s own `allow(req)`.')
  if (options.adapters?.wizards !== undefined && (!options.adapters.wizards || !isFn(options.adapters.wizards.answersFor))) fail('`adapters.wizards.answersFor` must be Wizards’ `answersFor`.')
  const help = options.orderHelp
  if (help !== undefined && (!help || typeof help !== 'object' || (help.reasons !== undefined && (!help.reasons || typeof help.reasons !== 'object' || (help.reasons.damaged !== undefined && typeof help.reasons.damaged !== 'boolean')))))
    fail('`orderHelp` must be { reasons: { damaged: boolean } }, or left out.')
  for (const k of ['orders'] as const) if (options[k] !== undefined && (options[k] === null || typeof options[k] !== 'object')) fail(`\`${k}\` must be an object, or left out.`)
  for (const [k, v] of Object.entries(options.orders ?? {})) if (v !== undefined && !isFn(v)) fail(`\`orders.${k}\` must be a function, or left out.`)
  if (options.payments !== undefined) for (const k of ['refund', 'creditBack'] as const) if (!isFn(options.payments[k])) fail(`\`payments.${k}\` must be a function.`)
  for (const k of ['lineFields'] as const) if (subjects[k] !== undefined && !Array.isArray(subjects[k])) fail(`\`subjects.${k}\` must be a list of fields, or left out.`)
  for (const k of ['packFor', 'lineFor'] as const) if (subjects[k] !== undefined && !isFn(subjects[k])) fail(`\`subjects.${k}\` must be a function, or left out.`)
  for (const f of topLevelFields(subjects.lineFields ?? [])) if (['kind', 'quantity', 'test', 'id'].includes(f.name)) fail(`\`subjects.lineFields\` has a field "${f.name}", which order lines already have.`)
  const retests = options.policy?.freeRetests
  if (retests !== undefined && !(Number.isInteger(retests) && retests >= 0)) fail('`policy.freeRetests` must be a whole number, 0 or more.')
  if (options.policy?.afterLastRetest !== undefined && !['credit', 'none'].includes(options.policy.afterLastRetest)) fail('`policy.afterLastRetest` must be "credit" or "none".')

  const collections = { users: 'users', orders: 'orders', products: 'products', files: 'files', ...(options.collections ?? {}) }
  const existing = new Map((config.collections ?? []).map((c) => [c.slug, c]))
  for (const slug of KIT_COLLECTION_SLUGS) if (existing.has(slug)) fail(`the config already has a "${slug}" collection. Remove it: the plugin adds it, with the same fields.`)
  const users = existing.get(collections.users)
  if (!users) fail(`there’s no "${collections.users}" collection for people. Name it with \`collections.users\`.`)
  if (!users!.auth) fail(`"${collections.users}" isn’t a collection people sign in with.`)
  for (const k of ['orders', 'files'] as const)
    if (!existing.has(collections[k])) fail(`there’s no "${collections[k]}" collection for ${k}. Name it with \`collections.${k}\`, and list sampleKits() after any plugin that adds it.`)

  const clash = (slug: string, names: readonly string[]) => {
    const c = existing.get(slug)
    for (const name of names) if (c && topLevelFields(c.fields).some((f) => f.name === name)) fail(`"${slug}" already has a field "${name}". Remove it: the plugin adds it, with the same shape.`)
  }
  clash(collections.orders, ORDER_FIELD_NAMES)
  clash(collections.products, PRODUCT_FIELD_NAMES)

  const ours = new Set(['code', 'lot', 'status', 'test', 'buyer', 'order', 'orderLine', 'identifierLabel', 'activatedBy', 'activatedAt', 'sampledAt', 'secretHash', 'secretIssuedAt', 'hub', 'labBatch', 'attempt', 'replacementOf', 'returnInPerson', 'notes', 'events', 'id', 'createdAt', 'updatedAt'])
  if (scope) ours.add(scope.field)
  const names = topLevelFields(subjects.fields).map((f) => f.name)
  for (const name of names) if (ours.has(name)) fail(`\`subjects.fields\` has a field "${name}", which kits already have.`)
  if (new Set(names).size !== names.length) fail('`subjects.fields` names a field twice.')
  if (subjects.buyerFields !== undefined) {
    if (!Array.isArray(subjects.buyerFields) || subjects.buyerFields.some((n) => typeof n !== 'string' || !names.includes(n)))
      fail('`subjects.buyerFields` must name fields from `subjects.fields` (what a kit was bought for), or be left out.')
  }

  // The pepper for every kit secret: a short one makes stolen hashes easy to guess.
  const secret = (config as { secret?: unknown }).secret
  if (typeof secret !== 'string' || secret.length < 16) fail('Payload’s `secret` (PAYLOAD_SECRET) must be at least 16 characters: it’s the pepper for kit secrets. Use a long random value.')

  const siteInfo = options.site
  if (siteInfo !== undefined && !isFn(siteInfo)) checkSiteInfo(siteInfo, fail)

  return { ...options, collections }
}

// ---------------------------------------------------------------- overrides can't remove the plugin's rules

type AnyFn = (...args: never[]) => unknown
type HookMap = Record<string, AnyFn[] | undefined>
type FieldLike = Field & { name: string; type: string; access?: Record<string, AnyFn>; hooks?: HookMap; hidden?: boolean; relationTo?: unknown }

/** Every hook and access function in a collection, so the copies the override saw can be told apart. */
function functionsOf(c: CollectionConfig): Set<unknown> {
  const out = new Set<unknown>()
  for (const list of Object.values((c.hooks ?? {}) as HookMap)) for (const h of list ?? []) out.add(h)
  for (const fn of Object.values(c.access ?? {})) out.add(fn)
  for (const f of topLevelFields<FieldLike>(c.fields)) {
    for (const fn of Object.values(f.access ?? {})) out.add(fn)
    for (const list of Object.values(f.hooks ?? {})) for (const h of list ?? []) out.add(h)
  }
  return out
}

type FieldCheck = (args: never) => unknown
/** Both must answer exactly `true`, for a field: the override can narrow the plugin's field access, never widen it. */
function narrowField(base: FieldCheck, extra: FieldCheck): AnyFn {
  return async (args: never) => {
    if ((await base(args)) !== true) return false
    try {
      return (await extra(args)) === true
    } catch {
      return false
    }
  }
}

/** Both must allow: the override can narrow the plugin's access, never widen it. */
function narrow(base: Access, extra: Access): Access {
  return async (args) => {
    const a = await base(args)
    if (a !== true && !isWhere(a)) return false
    const b = await extra(args)
    if (b !== true && !isWhere(b)) return false
    if (a === true) return b
    if (b === true) return a
    return { and: [a, b] }
  }
}

/**
 * The override's collection, with the plugin's rules put back from the untouched build: its fields
 * (present, same type and target), their access and hooks, the collection's hooks (the plugin's run
 * first), its access (only narrowed) and its indexes.
 */
export function protect(base: CollectionConfig, out: CollectionConfig, seen: Set<unknown>): CollectionConfig {
  const slug = base.slug
  if (!out || typeof out !== 'object' || !Array.isArray(out.fields)) fail(`overrides["${slug}"] must return the collection.`)
  if (out.slug !== slug) fail(`overrides["${slug}"] changed the slug to "${out.slug}". The slug can’t change.`)
  const theirs = new Map(topLevelFields<FieldLike>(out.fields).map((f) => [f.name, f]))
  for (const field of topLevelFields<FieldLike>(base.fields)) {
    const now = theirs.get(field.name)
    if (!now) fail(`overrides["${slug}"] removed the field "${field.name}", which Sample Kits needs.`)
    if (now!.type !== field.type || JSON.stringify(now!.relationTo) !== JSON.stringify(field.relationTo)) fail(`overrides["${slug}"] changed the field "${field.name}". Its type and target can’t change.`)
    if (field.access) {
      // The plugin's field access, only narrowed: an override's own rule must pass too, never instead.
      const access: Record<string, AnyFn> = { ...(now!.access ?? {}) }
      for (const [op, fn] of Object.entries(field.access)) {
        const given = access[op]
        access[op] = !given || given === fn || seen.has(given) ? fn : narrowField(fn as FieldCheck, given as FieldCheck)
      }
      now!.access = access
    }
    if (field.hidden) now!.hidden = true
    if (field.hooks) {
      const hooks: HookMap = { ...(now!.hooks ?? {}) }
      for (const [kind, list] of Object.entries(field.hooks)) hooks[kind] = [...(hooks[kind] ?? []).filter((h) => !seen.has(h)), ...(list ?? [])]
      now!.hooks = hooks as never
    }
  }
  const hooks: HookMap = { ...((out.hooks ?? {}) as HookMap) }
  for (const [kind, list] of Object.entries((base.hooks ?? {}) as HookMap)) hooks[kind] = [...(list ?? []), ...(hooks[kind] ?? []).filter((h) => !seen.has(h))]
  const access: Record<string, Access> = { ...((out.access ?? {}) as Record<string, Access>) }
  for (const [op, fn] of Object.entries((base.access ?? {}) as Record<string, Access>)) {
    const given = access[op]
    access[op] = !given || seen.has(given) ? fn : narrow(fn, given)
  }
  const keys = new Set((base.indexes ?? []).map((i) => JSON.stringify(i)))
  const indexes = [...(base.indexes ?? []), ...(out.indexes ?? []).filter((i) => !keys.has(JSON.stringify(i)))]
  return { ...out, hooks: hooks as CollectionConfig['hooks'], access: access as CollectionConfig['access'], indexes }
}
