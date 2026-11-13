/**
 * The pages, as server components (no hooks): each takes its server function's answer and the site's server actions,
 * and draws the page with the client components inside. Mount them from thin routes in your site.
 */
export { ActivatePage, KitProgress, MyKitPage, MyOrderPage, MyTestsPage } from './keeper.js'
export { BatchesPage, BatchPage, KitsHomePage, PackingPage, PackOrderPage, ReturnsPage, ScanPage } from './staff.js'
export { LabPage } from './lab.js'
export { Badge, Frame, type PageSlots } from './shared.js'
export { DefaultEmpty, DefaultPrice, DefaultResultCard, DefaultShell, DefaultSubjectPicker, PageProblem, TARGET } from '../ui/slots.js'
export type { EmptyProps, EmptySlot, NavItem, PriceProps, PriceSlot, ResultCardProps, ResultCardSlot, ShellProps, ShellSlot, SubjectPickerProps, SubjectPickerSlot } from '../ui/slots.js'
export { KEEPER_PATHS, STAFF_NAV, STAFF_PATHS, type KeeperPaths, type StaffPaths } from '../ui/nav.js'
export { UI_TEXT, uiText, type Translate, type UiKey, type UiText } from '../ui/text.js'
