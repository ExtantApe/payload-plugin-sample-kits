/**
 * Server functions for the Sample Kits pages. Each is a plain async function `(req, input)` that checks access itself
 * and answers a `ServerResult`: `{ ok: true, data }` with plain JSON, or `{ ok: false, error: { code, message } }`.
 * Mount them in your own thin routes or server actions, after your own checks (sign-in, masquerade, CSRF, origin).
 */
export { fill, GENERIC_MESSAGE, PLAIN_ERRORS, plain, say, serve, type ServerError, type ServerResult } from './result.js'
export {
  batchesPage,
  batchPage,
  kitsHomePage,
  packingPage,
  packOrderPage,
  returnsPage,
  scanBatch,
  scanCheckIn,
  scanLookup,
  scanPack,
  scanReceive,
  scanUnbatch,
  scanUnpack,
  STAFF_NAV,
  submitLot,
  submitNewBatch,
  submitOrderLabels,
  submitRecall,
  submitReleasePreorders,
  submitReplace,
  submitReprint,
  submitReturnLabels,
  submitShip,
  submitShipBatch,
  submitSlip,
  type BatchRow,
  type KitsHomeData,
  type PackingQueueRow,
  type PackOrderData,
  type ReturnsData,
  type ScanAnswer,
} from './staff.js'
export { labPage, previewResultFiles, submitBatchReceived, submitResultFile, type LabPageData, type PreviewRow, type UploadAnswer } from './lab.js'
export {
  activatePage,
  getReturnLabel,
  KIT_ACTIVATE_ROUTE,
  myKitPage,
  myOrderPage,
  myTestsPage,
  submitActivation,
  submitHelp,
  submitMissedChoice,
  submitReleaseForMail,
  submitSampled,
  type ActivateData,
  type KeeperKit,
  type MyKitData,
  type MyOrder,
  type MyOrderData,
  type MyTestsData,
} from './keeper.js'
