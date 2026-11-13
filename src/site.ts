import type { PayloadRequest } from 'payload'

import { KitError } from './internal.js'
import type { ResolvedOptions, SiteInfo } from './types.js'

/**
 * The site's name and address for slips and lab notices, from the plugin's options, never from a page's input (security
 * read of fee0a58, 2026-11-10). A function form answers per site, given the site `scope.of(req)` found.
 */

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/
const PATH = /^\/[A-Za-z0-9._~\-/]*$/

/** Why a site's details can't be used, through `fail`; nothing when they're fine. */
export function checkSiteInfo(info: unknown, fail: (message: string) => never): void {
  const s = info as Partial<SiteInfo> | null
  if (!s || typeof s !== 'object') fail('`site` must be { name, origin, labPortalPath? }, a function (args) => that, or left out.')
  if (s!.name !== undefined && (typeof s!.name !== 'string' || !s!.name.trim() || s!.name.length > 100)) fail('`site.name` must be the site’s name, up to 100 characters.')
  if (s!.origin !== undefined && (typeof s!.origin !== 'string' || !ORIGIN.test(s!.origin))) fail('`site.origin` must be the site’s address with no path, e.g. "https://kits.example.com".')
  if (s!.labPortalPath !== undefined && (typeof s!.labPortalPath !== 'string' || !PATH.test(s!.labPortalPath))) fail('`site.labPortalPath` must be a path on the site, e.g. "/lab".')
}

/** The site's details for this request: checked again when they come from a function, and empty when not given. */
export async function siteInfoFor(o: ResolvedOptions, req: PayloadRequest, site: string | undefined): Promise<SiteInfo> {
  const given = o.site
  if (!given) return {}
  const info = typeof given === 'function' ? await given({ site: site ?? null, req }) : given
  if (!info) return {}
  checkSiteInfo(info, (message) => {
    throw new KitError('siteSettings', `The site’s settings are incomplete: ${message}`)
  })
  return info
}

/** The lab portal's full address, or null without an origin. */
export const labPortalOf = (info: SiteInfo): string | null => (info.origin ? `${info.origin}${info.labPortalPath ?? '/lab'}` : null)
