import type { NavItem } from './slots.js'

/** The staff pages' menu, for the site's shell. Paths are the site's today; pass your own `nav` to change them. */
export const STAFF_NAV: readonly NavItem[] = [
  { key: 'home', label: 'Kits', href: '/kits' },
  { key: 'scan', label: 'Scan', href: '/kits/scan' },
  { key: 'packing', label: 'Packing', href: '/kits/packing' },
  { key: 'returns', label: 'Returns and check-in', href: '/kits/returns' },
  { key: 'batches', label: 'Lab batches', href: '/kits/batches' },
  { key: 'lab', label: 'Lab portal', href: '/lab' },
]

/** The keeper pages' paths, the site's today. */
export const KEEPER_PATHS = { myTests: '/my-tests', kit: '/my-tests/kits/', order: '/my-tests/orders/', activate: '/my-tests/activate', signIn: '/login' }
export type KeeperPaths = typeof KEEPER_PATHS

/** The staff pages' paths, the site's today. */
export const STAFF_PATHS = { packOrder: '/kits/packing/', batch: '/kits/batches/', signIn: '/login' }
export type StaffPaths = typeof STAFF_PATHS
