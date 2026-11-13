import type { Payload, PayloadRequest } from 'payload'

import { normalizeKitCode } from './codes.js'
import { idOf, isStaff, optionsOf, personOf, READ, scoped } from './internal.js'
import { findKit } from './kits.js'
import { buyerOf } from './packing.js'
import type { KitOrder, ResolvedOptions, ScanPaths } from './types.js'

/**
 * The scan kinds for Scan (`payload-plugin-scan`), registered at `config.custom.scanKinds` when the site turns them
 * on (`adapters.scan`). Scan is never imported: these match its `ScanKind` shape, and Scan's `resolveScan` decides
 * the answer from who is signed in.
 * - `k`: a kit code. Kit staff of the kit's site go to its record; the buyer goes to activation (the code only, never
 *   the secret: that travels in the link's fragment, which no server sees); anyone else gets nothing.
 * - `b`: a shipping box, `<order>-<box>`. Kit staff of the order's site go to its packing page; the buyer to their
 *   order; anyone else gets nothing.
 * Codes are looked up only on the request's site, so a code from another site is "not there". For staff, a code that
 * doesn't exist is "Not found"; for everyone else Scan gives one quiet answer whatever the reason.
 */

type Req = Partial<PayloadRequest>
type ID = string | number

/** The box code printed on a shipping box's label: the order and the box's number in its plan. */
export const boxCode = (orderId: string, box: number) => `${orderId}-${box}`
/** The scope Scan sees on a single-site install. */
const SINGLE = 'site'
const BOX = /^([A-Za-z0-9_]{1,64})-(\d{1,3})$/
/** Kit codes, as `normalizeKitCode` takes them once spaces are gone. */
const KIT = /^\d{8,20}$/

const DEFAULT_PATHS: Required<ScanPaths> = {
  kit: (code) => `/kits/scan?mode=lookup&code=${encodeURIComponent(code)}`,
  activate: (code) => `/my-tests/activate?kit=${encodeURIComponent(code)}`,
  order: (orderId) => `/kits/packing/${encodeURIComponent(orderId)}`,
  myOrder: (orderId) => `/my-tests/orders/${encodeURIComponent(orderId)}`,
}

const pathsOf = (o: ResolvedOptions): Required<ScanPaths> => {
  const given = typeof o.adapters?.scan === 'object' ? (o.adapters.scan.paths ?? {}) : {}
  return { ...DEFAULT_PATHS, ...Object.fromEntries(Object.entries(given).filter(([, v]) => typeof v === 'function')) }
}

/** The site this scan is on, or undefined on a single-site install. Null when it can't be told (then nothing is found). */
async function siteFor(o: ResolvedOptions, req: PayloadRequest): Promise<string | undefined | null> {
  if (!o.scope) return undefined
  const site = await o.scope.of(req)
  return site === null || site === undefined || site === '' ? null : String(site)
}

/** Scan hands kinds a partial request; the plugin's checks read `payload` and `user` from it. */
const asReq = (payload: Payload, req: Req) => {
  const r = req as PayloadRequest
  r.payload ??= payload
  return r
}

/** Kit staff of this site. With a scope given, only when it's the request's own site. Never throws (Scan counts a throw as no). */
async function staffIn(o: ResolvedOptions, req: PayloadRequest, scope: ID | null): Promise<boolean> {
  if (!(await isStaff(o, req))) return false
  if (scope === null || !o.scope) return true
  const site = await siteFor(o, req)
  return site !== null && site !== undefined && site === String(scope)
}

async function kitOnSite(o: ResolvedOptions, req: PayloadRequest, raw: string) {
  const site = await siteFor(o, req)
  if (site === null) return null
  const code = normalizeKitCode(raw)
  if (!code) return null
  const kit = await findKit(req, code, site)
  return kit ? { kit, site } : null
}

async function orderOnSite(o: ResolvedOptions, req: PayloadRequest, raw: string) {
  const m = BOX.exec(raw)
  if (!m) return null
  const site = await siteFor(o, req)
  if (site === null) return null
  const [, orderId, n] = m
  const order = (await req.payload.find({ collection: o.collections.orders, where: scoped(o, site, { id: { equals: orderId } }), limit: 1, ...READ, req }).catch(() => ({ docs: [] }))).docs[0] as unknown as KitOrder | undefined
  if (!order?.kitLines?.length) return null
  const box = Number(n)
  if (!(order.kitFulfillment?.plan?.boxes ?? []).some((b) => b.box === box)) return null
  return { order, box, site }
}

/** The two kinds, in Scan's `ScanKind` shape. */
export function scanKinds() {
  return {
    k: {
      pattern: KIT,
      scopeOf: async ({ code, req, payload }: { code: string; req: Req; payload: Payload }): Promise<ID | null> => {
        const o = optionsOf(payload)
        const found = await kitOnSite(o, asReq(payload, req), code)
        // On a single-site install there's one scope; Scan only needs to know the code is here.
        return found ? (found.site ?? SINGLE) : null
      },
      isStaff: async ({ scope, req, payload }: { user: Record<string, unknown>; scope: ID | null; req: Req; payload: Payload }) => {
        const o = optionsOf(payload)
        return staffIn(o, asReq(payload, req), o.scope ? scope : null)
      },
      resolve: async ({ code, staff, req, payload }: { code: string; user: Record<string, unknown>; staff: boolean; req: Req; payload: Payload }): Promise<{ to: string } | null> => {
        const o = optionsOf(payload)
        const r = asReq(payload, req)
        const found = await kitOnSite(o, r, code)
        if (!found) return null
        if (staff) return { to: pathsOf(o).kit(found.kit.code) }
        const me = personOf(o, r)
        if (me && idOf(found.kit.buyer) === String(me.id)) return { to: pathsOf(o).activate(found.kit.code) }
        return null
      },
    },
    b: {
      pattern: BOX,
      scopeOf: async ({ code, req, payload }: { code: string; req: Req; payload: Payload }): Promise<ID | null> => {
        const o = optionsOf(payload)
        const found = await orderOnSite(o, asReq(payload, req), code)
        // On a single-site install there's one scope; Scan only needs to know the code is here.
        return found ? (found.site ?? SINGLE) : null
      },
      isStaff: async ({ scope, req, payload }: { user: Record<string, unknown>; scope: ID | null; req: Req; payload: Payload }) => {
        const o = optionsOf(payload)
        return staffIn(o, asReq(payload, req), o.scope ? scope : null)
      },
      resolve: async ({ code, staff, req, payload }: { code: string; user: Record<string, unknown>; staff: boolean; req: Req; payload: Payload }): Promise<{ to: string } | null> => {
        const o = optionsOf(payload)
        const r = asReq(payload, req)
        const found = await orderOnSite(o, r, code)
        if (!found) return null
        const id = String(found.order.id)
        if (staff) return { to: pathsOf(o).order(id, found.box) }
        const me = personOf(o, r)
        if (me && buyerOf(o, found.order) === String(me.id)) return { to: pathsOf(o).myOrder(id) }
        return null
      },
    },
  }
}

/** Scan's registry entry. */
export const scanRegistration = () => ({ owner: 'sample-kits', kinds: scanKinds() })
