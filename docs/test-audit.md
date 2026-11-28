# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-27: who sets the kit fields on the site's orders

257 tests. `test/orderFields.test.ts` (13 new) puts a value in every field under `kitFulfillment`, and checks that its two lists (set by staff, set by server code only) name all of them:
- **Not kit staff:** create and duplicate, with and without values of their own, through the Local API and REST. No kit lines are stored, and `kitFulfillment` holds only the default status. The site's own fields still save and copy.
- **Kit staff and admins:** create and duplicate keep the lines and the staff fields, and none of the server-only ones. An update can't add the agreed words.
- **Server code:** create records every field, and duplicate copies the agreed words.

Mutation check: with the new tests run against the old field rules, 10 of 13 failed. With only the group-level rules and no rule on the fields inside, the 5 duplicate tests failed.

Gaps skipped: GraphQL (same field rules, not run here) and the admin panel in a browser.

## 2026-11-13: who a notice names, and what notify answered

244 tests. From the security read before the first public push:
- **A keeper's notice never carries the buyer's order.** `noticeTo` sends `order: null` whenever the audience is a keeper (a return parcel's problem, and `kit-arrived`); the row keeps the order for the seed and for retries. shipping: "tells the keeper of a gift, not its buyer…" now checks the order is in neither `to` nor `data`, and that the row still has it; "names the order's site on a staff notice, and never the order on a keeper's" covers `noticeTo` directly.
- **A staff notice names the order's site** (`to.site`, null without `scope`), so a site with many tenants tells only that site's kit staff. Same two tests.
- **Fail closed on a staff notice with no site.** With `scope`, it's recorded as `gave-up` with delivery `noSite` and never sent, since a site might read no site as every site. Without `scope`, unchanged. shipping: "never sends a staff notice that names no site when the plugin is scoped…" (the scoped send for real; without scope, the check alone, since the harness is always scoped).
- **A keeper's notice keeps the order only for the order's own buyer**, recorded as `toBuyer` when planned. A return parcel nobody activated goes to the buyer with the order; a gift keeper still gets null. shipping: the return-leg test, and the `noticeTo` test (anything but exactly true is no).
- **Only known delivery answers are stored**; anything else is `unknown`, and no answer (undefined or null) is `sent`. shipping: "stores only the delivery answers it knows, and anything else as unknown".
- **The claim's checks are layered.** Claiming a row matches both its status and its attempt count, each a second line for the other, so a mutant that drops only one may survive. Both stay.

Mutation check, in a throwaway copy: 10 mutants of the new code, 9 caught at first; the survivor (a null answer counted as unknown) is caught after the null case was added to the delivery test. A second check, for the no-site and own-buyer rules: 9 mutants, 8 caught. The survivor drops the audience test from the no-site check, and is equivalent: only a staff notice's `to` has a `site` key at all, so no other audience can read as missing one.

Not tested: `kit-arrived` for a kit that came from an order (the labs fixtures make kits without one), beyond `noticeTo`'s own test.

## 2026-11-11: the flaky orders privacy test

`test/privacy.test.ts`, "on the site's orders: a buyer can't change kit lines or fulfillment…", failed in 1 of 30 runs of that file alone (and once in a full run, noted below as "timing under load"). It was the test, not the code, and not timing.

- **Why it flaked:** the check that a buyer never sees the label's cost was `not.toMatch(/…|512/)` on the whole JSON of the order. The buyer's view carries random values (the populated customer's session UUID, ObjectIds, timestamp milliseconds), and "512" turns up inside them by chance. The failing run matched it inside the session id `…e51224c4…`; the output held no label, cost, reference or run, and `outboundLabels` was empty.
- **Fix:** match the cost only as a JSON number (`[:,[]512[,\]}]`) or the `"costCents"` key. Random strings and timestamps can't produce either.
- **Still a real guard:** with `outboundLabels`'s staff-only read removed from `src/orderFields.ts` and the separate empty-list assertion removed, the new pattern fails the test. Both files were restored from backups and checksums matched.
- **Stable:** the whole suite then passed 10 runs in a row, 241 of 241 each time.
- **Gaps:** none added. Other negative-substring checks in the suite were read for the same risk; they look for emails, made-up names, or short ids in output that holds no random hex (for example `'b1'` in `server.test.ts` is checked against an answer of choices, a digit-only code and a stage).

## 2026-11-11: seed stamps and context

241 tests (5 new, in `test/seed.test.ts`, "seed stamp and context"). A made-up site hook on every collection the seed writes records each write's and delete's context.

### Promises and the tests that prove them

| Promise | Test |
| --- | --- |
| Every record a story makes carries the stamp, notices included; none of the plugin's records from the story is unstamped | "stamps every record a story makes…" |
| A stamp naming any plugin field (every top-level field of every kit collection, the order fields, the scope field), the marker, `id`, `_id`, `createdAt`, `updatedAt`, a field some collection lacks, or a non-plain value is refused with nothing written, for both functions | "refuses a stamp naming any of the plugin's own fields…" |
| The context reaches every write (plugin actions' included) and every delete | "stamps every record…" (every spied write and delete has `disableRevalidate`) |
| The plugin's context keys win; a context can't set a guard key (the real `EVENT_WRITE` symbol included) or replace the after-commit list; a kit's status still can't be written past its events from a carried request | "lays the plugin's own context keys over the caller's…" |
| Two batches with one marker each remove only their own; the other batch's stamp removes nothing; no stamp behaves as before | "removes only one batch's records…" |
| `allow()` and the marker still required with stamp and context | "still needs allow() and the marker…" |
| Every seed write and delete carries the caller's `origin: 'script'` and `system: 'seed-world'` with the plugin's own reason; the caller's `reason` loses, its other audit keys stay | "stamps every record…" (every spied write and delete), "lays the plugin's own context keys…" (hostile audit, and `sysReq` field by field) |

### Mutation check

18 guards, each removed in turn (Python string replace on a backup, restored exactly, checksums of the two source files compared after): the own-field, id/date, marker, missing-field, plain-object and plain-value refusals; the plain-context refusal; the stamp in the removal's query, on the direct creates and on the adapter-level writes; the notices being stamped; the guard keys dropped; the plugin's keys winning, in the carried requests and in the story's own; carrying through `sysReq`; the context on the people's requests and on deletes; and `allow()`. All caught; the two "plugin's keys win" mutations survived at first, so the test now checks the story's hub keeps the plugin's audit and that `sysReq` keeps the plugin's own `audit` over a carried one.

After the audit correction, 10 more mutations, all caught: the caller's origin and system winning, the plugin's audit keys winning over the caller's, the caller's other audit keys kept, the audit merge itself, the plugin's keys winning, the guard keys dropped, the merge in the story's writes, its deletes and the recall's write, and the notice's reason. One full-suite run had a failure in `test/privacy.test.ts` (orders' buyer test) that passed alone three times and on the next full run; it doesn't touch the seed, and looks like timing under load.

### Gaps

- Skipped: `skipLabelCancel`'s effect through a real return-label cancel. It's dropped before carrying (tested directly), so the hook never sees the caller's value.
- Not tested: the seed plugin's real calls and a site's real revalidation hook.

## 2026-11-11: shipment notices

236 tests in seventeen files (10 new: 8 in `test/shipping.test.ts` "shipment notices, each once", 2 in `test/labs.test.ts` "the keeper's 'your sample arrived'"; plus `kit-notices` in the index, options and lab-user refusal checks). Tracker updates are shaped as Shipping's webhook hands them over (its `TrackerEvent`) and go through `shippingHandler.onTracker`; Shipping's own endpoint isn't run here (not a dependency).

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| Outbound out for delivery, delivered and a problem each tell the buyer once; a problem tells staff once; repeats, other statuses meaning the same notice, and the same event id twice send nothing new | shipping: "tells the buyer each outbound status once…" |
| Never an address in a notice; staff get codes, tracking, order and the carrier's status | same test |
| Three copies of one update at once send one notice and leave one row | shipping: "sends one notice when the carrier sends the same update twice at once" |
| Several senders at once (runs and an update) send a notice owed once | shipping: "sends a notice owed once when several senders run at the same moment" |
| A failed send is sent on the next update (a repeat included) or the daily run; five failures give `gave-up`, never a sixth try | shipping: "sends a notice that failed on the parcel's next update…" |
| A notice left `pending` is sent by the run; one left `sending` only after ten minutes | shipping: "sends a notice left pending by a crash…" |
| Return leg: a problem tells the gift's keeper (their kit codes, no order) and staff, never the buyer; in transit, out for delivery and delivered tell nobody; with no kit activated, the buyer | shipping: "tells the keeper of a gift, not its buyer…" |
| An unknown tracking number writes and sends nothing | shipping: "does nothing for a tracking number that isn't ours" |
| The record reads for kit staff of the site only; lab users are refused | shipping: "keeps the notice record to kit staff"; labs: the lab-user refusal list |
| The check-in tells the keeper, not the buyer, once per kit, with the code only; a failed one goes on the next scan or the run | labs: the two "your sample arrived" tests |
| The unique index exists with its partial filter | indexes: "starts in manual mode once ensureSampleKitsIndexes has run…" |

### Mutation check

22 guards, each changed by a Python string replace, the covering test files run, and the file restored exactly (SHA-256 checked equal after each run). 19 caught on the first pass. Three survived and got tests: ignoring the send claim's answer and a claim that doesn't check status and attempts (now caught by "several senders at once"), and dropping the five-try cap in the send loop (now caught by a row set back to `failed` after giving up). All 22 caught.

### Gaps skipped

- Shipping's real webhook endpoint with a signed body: Shipping isn't a dependency here, and its own tests cover signing, age and the 500-on-throw retry. The handler is called with Shipping's event shape.
- `recordNotices` without `notify` (it writes nothing): a one-line early return, not tested.
- The losing transaction of a real race answering 500 to the carrier isn't asserted: which copy loses varies; the test asserts one notice and one row whatever happens.

## 2026-11-10: the security read of fee0a58, and uploads by file id

226 tests in seventeen files. New: `test/privacy.test.ts` (17: who reads which kit and order fields, through the Local API with `overrideAccess: false` and through REST with `handleEndpoints`, with an override that tries to open every field) and `test/uploads.test.ts` (6: uploads by file id and the base64 cap, on two Payload instances). Added to existing files: activation races (kits, 2), unknown refunds (help, 2), start-up checks (options, 11 cases), lost races answering `busy` (server, 1), an in-flight label purchase (shipping), the uploader by file id (client, 1), and the slip's and lab notice's address from options (server, labs).

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| A gift's buyer reads the buyer side (buyer, order, line, label, secret date, what it was bought for), never the keeper's side, at depth 0 and 1, never the keeper's user record | privacy: "the buyer sees…" (Local API), "keeps the buyer and the keeper apart…" (REST) |
| The keeper reads their activation and sample, never the buyer, the order or what it was bought for, at depth 0 and 1 | privacy: "the keeper sees…", REST |
| Someone who both bought and activated sees both; nobody but staff sees `notes`; staff see all | privacy: "whoever both bought…", "kit staff see everything…" |
| A stranger and the signed-out get nothing | privacy: "a stranger gets nothing", REST |
| A field someone can't read can't be queried or filtered on | privacy: "refuses a query on a field…", REST "refuses a probing query" |
| The rules survive an override that opens every field | privacy: the whole file runs with that override |
| The custody trail join gives non-staff nothing; the other eight collections give non-staff nothing | privacy: the `events` checks, "give people who aren't kit staff nothing…" |
| On orders, a buyer can't change kit lines or fulfillment, and never reads label purchases, the labels run, notice bookkeeping or who decided | privacy: "on the site's orders…" |
| Of several activations at once, exactly one keeper, transactions off or on; the losers get `busy` | kits: "gives exactly one keeper…", "gives the losers busy…" |
| A refund whose answer never came is `unknown` and counts as paid back; another kind can't pass what was paid; a clear refusal stays `failed`; only site admins settle, and settling as not refunded frees the amount | help: "counts a refund whose answer never came…", "frees the amount of an unknown refund…"; shipping: the answer without an id |
| Uploads by file id: accept gets the id, never bytes; bytes refused; a `verifyUpload` that throws, or answers for another id, refuses; a type that isn't a result refuses; the plugin's name check still runs; an id is used once, also when sent twice at once; the unique index exists | uploads: the five file-id tests |
| Without `verifyUpload`: base64 up to `maxBase64Bytes`, `uploadTooBig` in plain words past it, a file id refused | uploads: "takes bytes up to…" |
| The client sends only the id when uploads go by file id, and says plainly when storage fails | client: "with uploads by file id…" |
| The slip's links and the lab notice use the `site` option, never page input | server: "receive, pack, slip and ship…" (an origin from the page is ignored); labs: the notice names the site and portal from the function form |
| A label purchase another request started moments ago is `busy`; an old `buying` row is still `labelUnknown`; racing purchases' losers are `busy` | shipping: "refuses another purchase…", "lets only one of three…" |
| A write conflict reaching a page is `busy`, anything else the general message | server: "answer busy in plain words…" |
| Start-up refuses a short Payload secret, a bad `site`, `buyerFields` not in `subjects.fields`, a non-function `verifyUpload`, a bad `maxBase64Bytes`, and a `scope` without `access.staff` | options: "refuses bad options…" |

### Gaps skipped

- GraphQL isn't run: `@payloadcms/graphql` isn't a dependency here. GraphQL reads go through the same field `afterRead` access as REST and the Local API, which are tested.
- An order-label run losing to another at the claim with a real write conflict isn't forced in a test (it needs two transactions to collide at one moment); `serve`'s mapping of write conflicts to `busy` is tested, and so is the label slot's.
- `select` that leaves out `buyer` or `activatedBy` hides that side even from its owner (fails closed); not tested beyond the README's note.
- The admin panel's own field permissions (it calls the same field access) aren't run.

### Mutation check

28 guards, each changed by a Python string replace, the covering test files run, and the file restored exactly (SHA-256 checked equal after each run). 26 caught on the first pass; two survived and got tests:
- the base64 length check before decoding in `submitResultFile` (the decoded-size check behind it caught the same files): a test now sends a body that's too long but decodes small, and the mutant is caught;
- `issueSecret` taking an origin from its caller: the server function no longer passes one, so only a direct call reaches it; a test now calls `issueSecret` with an origin, and the mutant is caught.
All 28 caught in the end. Checked: field read on the buyer's and keeper's sides, subject fields, `notes`, overrides narrowing, order write and read access (three), the activation claim, unknown refunds (four), uploads by file id (seven, including single use with the read check alone off, and with the index off too), both base64 caps, the 16-character secret, the slip's and notice's address, `busy` for an in-flight label and in `serve`, and the start-up checks for `site.origin` and `buyerFields`.

## 2026-11-10: phase 4b, the pages

197 tests in fifteen files. Phase 4b adds `test/server.test.ts` (19: the server functions on Payload with in-memory MongoDB, through the harness and a seed story, with shipping and results fakes) and three jsdom files with Testing Library, as Wizards does: `test/client/ActivationWizard.test.tsx` (13), `test/client/stations.test.tsx` (13: the scan station, the lab uploader, the forms) and `test/client/pages.test.tsx` (13). `test/client/storage.ts` fails any component test that writes to web storage or a cookie.

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| Staff pages refuse anyone who isn't kit staff (keeper, stranger, lab person, signed out) with a plain answer, never a throw | server: "refuse anyone who isn't kit staff…" |
| Staff see only their own site; another site's kit, order and batch get the same "not found" as a missing one | server: "show staff only their own site", "receive, pack, slip and ship…", "make, fill and list batches…" |
| A lookup never says who has a kit | server: "look a kit up without saying who has it" |
| The slip's secret travels in the link's fragment, never a query; shipping needs the slip | server: "receive, pack, slip and ship…" |
| A recall needs exactly `confirm: true` | server: "recall only with the box ticked" |
| A lab page shows codes, statuses and tests only: no buyer, keeper, email, address, subject or result | server: "shows a lab its batches…" |
| Only a lab's people use the portal; a preview writes nothing | server: "previews files without writing…" |
| A keeper's page lists only their own orders and kits, even with a too-loose order query | server: "list only the person's own orders and kits" |
| A gift's keeper never sees the buyer, the order's dates or what it was bought for (even with no sampled subject); the buyer never sees the keeper, their animal or their dates | server: "show a gift's keeper the kit without its buyer…" |
| A stranger gets exactly the answer for a missing kit, on the kit page and the return label; the same for orders | server: "give a stranger exactly the same answer…", "show an order's help only to its buyer…" |
| A result shows only to its keeper; for the buyer the provider isn't asked | server: "show a result only to its keeper" |
| Unexpected failures: the general message, and only the error's name logged | server: "answer an unexpected failure…" |
| Activation: no suggestion from a code the person didn't buy, even from a provider that marks one itself; "sample next" only for the kit's own keeper; a wrong secret answers like a missing kit; the code alone never activates | server: the three activation tests |
| `i18n.t` translates refusals; English when missing | server: "translate refusals…"; pages: "uiText keeps English…" |
| The secret is read from the fragment, removed from the address bar, never in a query, sent once in the body | client: "takes the secret from the link's fragment…", the guided test |
| Keyboard path, focus to each new heading (not on first load), "Step N of M" tied to the heading | client: "walks the steps by keyboard…" |
| Live regions on the page from the start; errors start with "Not done" in words | client: "says what's missing…", scan station tests |
| Refusals in plain words, with a way back; the site's picker and translations | client: activation tests |
| With Wizards: the guided steps run, answers and language sent (never a client `confirmed`), a refusal lets the person try again, an activated kit skips find and choose | client: the three Wizards tests |
| Scan station: Enter submits, the field clears and refocuses, each line says what happened in words, a thrown action is plain | client: the four scan station tests |
| Upload: preview first, only files that can go are sent, as base64, the summary focused | client: the uploader tests |
| Forms: confirm in the page with focus on the question; labeled fields with help tied; refocus on refusal; new-tab links say so | client: the forms tests |
| Status never by color alone (kit progress, lot badges, batch statuses); 44-pixel targets | pages: KitsHomePage, LabPage, MyKitPage and MyTestsPage tests; client: "keeps every button at least 44 pixels high" |
| Nothing in web storage or cookies | every component test, through `watchStorage` |

### Gaps skipped

- Phone-width layout is plain flowing HTML with no fixed widths (tables scroll inside their own box); jsdom can't measure layout, so it isn't tested. A real-browser check is for the owner's test list.
- Screen-reader output itself isn't tested, only the roles, labels and live regions it reads.
- Next.js itself (server actions, RSC serialization) isn't run; `data` is checked to survive JSON, which is stricter.

### Mutation check

55 guards, each changed by a Python string replace, the covering test file run, and the source restored, with the SHA-256 of every file in `src/` checked equal after the run. 51 caught on the first pass. Four survived:
- a provider marking `suggested` itself for a stranger: a test was added ("…even from a provider that marks one itself"), and the mutant is now caught;
- tracking numbers shown to a keeper who isn't the buyer: the order isn't read for them at all, so there's nothing to show (a second layer);
- `resultView` asked for a buyer: `resultView` itself answers null to anyone but the keeper and staff, tested in phase 3 (a second layer);
- "Activate" offered to a keeper who isn't the buyer: a kit with a keeper is never activatable again, so the case can't arise (kept as a guard).

## 2026-11-10: the seed gate

139 tests. `test/seed.test.ts` gains "needs the seed plugin's allow() to answer exactly true, and a marker": no `adapters.seed`, and `allow` answering `false`, `'yes'`, `1`, a promise of `'true'`, nothing, or throwing, each refuse both `seedKitStory` and `removeKitRecords` with `seedNotAllowed`; `allow` is asked with the caller's request before the staff check; a missing or empty mark gives `badMark`; no kit is written by any refusal; a non-function `allow` stops start-up. The existing seed tests cover allow `true` with a valid mark.

Mutation check: 10 mutants (the gate off, a truthy answer passing, the gate missing from seed and from removal, the gate moved after the staff check, the mark optional again, the option check off), each by Python string replace with the source restored and its SHA-256 checked. All caught.

## 2026-11-10: phase 4a

138 tests in eleven files. Phase 4a adds `test/kitting.test.ts` (Kitting's units through `fakeKitting`), `test/scan.test.ts` (through Scan's own `resolveScan`), `test/wizards.test.ts` (through Wizards' own `answersFor` and `flowSteps`) and `test/seed.test.ts` (the seed story, its removal, the rate study), and a `damaged` case in `test/help.test.ts`. `test/harness.ts` takes extra collections and plugins.

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| A built kit is an in-stock kit in the build's transaction; a code in stock, an unknown lot, no staff or another site's unit refuses the build; other recipes ignored | kitting: "makes each built kit an in-stock kit…" |
| Packing takes the scanned kit's unit, joining the transaction; old stock packs with a note; an order with nothing reserved gets its units at packing | kitting: "swaps the scanned kit's unit…", "packs a kit received before Kitting…" |
| A Kitting refusal or crash never leaves a kit and its unit out of step: packing, unpacking, shipping, recall and cancel each roll back whole | kitting: "refuses packing in Kitting's words…", "gives a unit back on unpacking…", "ships the units…", "voids a recalled lot's units…", "gives back everything a canceled order holds…" |
| Money: a canceled order's units go back before any refund; a Kitting refusal asks for no refund | kitting: "gives back everything a canceled order holds…" |
| Without a transaction to share, nothing is written and Kitting isn't called | kitting: "refuses before writing anything…" |
| Released pre-orders get units after the commit, never failing the release | kitting: "gives released pre-orders their units…" |
| Scan `k`: staff of the kit's site to the record, the buyer to activation without the secret, staff "Not found" for unknown codes and other sites' kits, one quiet answer for everyone else, the keeper of a gift included; signed out "Sign in" | scan: the three `k` tests |
| Scan `b`: staff to packing, the buyer to their order, a box not in the plan or another site's order "Not found" for staff, quiet for others | scan: "sends staff to the order's packing page…" |
| Scan kinds registered only when on; paths checked | scan: "registers the kinds only when…", "takes the site's own paths…" |
| Wizards: a skipped gate, a No, no answers, stale wording, an empty safety group, a failure and anything but exactly ok are refused; a client-made record refused; a good record stored on the event | wizards: all six |
| Seed and removal: kit staff or an admin of the site only; the story's staff must be staff; records marked and reported; stand-in payment ids only; removal touches only marked records of the site in the plugin's collections and orders; an unmarked kit survives | seed: the three seed tests |
| Rate study: test mode only (outbound or return quote), kit staff only, nothing bought, report names no address | seed: the two rate study tests |
| `damaged`: off by default (not offered, refused, staff can't replace for it), old requests still read; on: only once shipped, to staff, replaced like a lost kit, never refunded, the request answered `replaced`, one free replacement shared with lost and expired | help: "keeps "damaged" off until…" |
| Start-up checks for `adapters.kitting`, `adapters.wizards`, `adapters.scan` and `orderHelp` | kitting: "refuses an incomplete Kitting adapter…"; scan: "takes the site's own paths…" |

### Mutation check

36 guards, each changed in turn by a Python string replace, the covering test file run, and the source restored exactly, with the SHA-256 of every file in `src/` checked equal after the run. First pass: 29 of 31 caught. Two survived and got tests: staff of another site passing `isStaff` when asked directly with that site's scope (Scan never asks so, since codes are looked up on the request's site; now tested directly), and `answersFor` answering a truthy `ok` that isn't `true` with a record. Second pass: those two and five `damaged` guards, all caught.

Caught: the no-transaction refusal (in the helper, in packing and in cancel); Kitting refusals passed on at packing; only `unitNotFound` swallowed on release; the build's recipe key, site and "already in stock"; units released on cancel, shipped on shipping, voided on recall; Scan's site check, buyer-only for `k` and `b`, the box in the plan, registration only when on; Wizards' exact ok, refusing a client record, registration only when on; `damaged` refused when off, off by default, staff can't replace for it while off, only once shipped, one free replacement shared, the request closed; seed staff, own site, story staff, removal staff, marked only, own site only, own collections only, marker required; the rate study's test mode and staff checks.

### Gaps skipped

- Kitting itself: its peers (`@payloadcms/next`, React) would come with it, so its exports were type-checked against the adapter instead, and the stand-in copies its codes. A site run with Kitting is the switch PR's job.
- A real database without transactions: simulated by making `beginTransaction` answer nothing.
- `kitOnSite` with no site on the request: Scan already answers quietly when anything can't be decided.

## 2026-11-10: phase 3

108 tests in seven files. Phase 3 adds `test/labs.test.ts` (hubs, batches, the lab portal, results), `test/help.test.ts` (order help, refunds, pre-orders, event drop-off) and `test/indexes.test.ts` (`ensureIndexes: 'manual'`), on Payload 3.92 with in-memory MongoDB, the new `fakeResults` and `fakeEvents` from `./testing`, and made-up people, labs, orders and event dates on two made-up sites. `test/harness.ts` takes an optional database name, so two Payloads can share one database.

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| Hub check-in: kit staff of the site only; activated kits only; warnings for not sampled and another hub; a kit already at the lab refused | "checks in activated kits only, scanned or typed…" (keeper, buyer, stranger, lab user, signed out, other site's staff) |
| Batches: kit staff only, checked-in kits only, one batch per kit, full and closed batches refused, odd sizes need a tick | "fills a batch by scan, ships it…" |
| The lab's notice: kept on the batch, sent after the commit (the notifier reads the batch as already shipped), its outcome recorded; no contacts and a failed notice still ship | "fills a batch…", "records a failed notice or a lab with no contacts…" |
| Lab access: listed portal users with `scope.isLabUser`, and kit staff; another lab's user, another site's people, keepers and strangers refused alike; nonexistent batch answers like a forbidden one | "lets only the lab's own portal users and kit staff act for it…" |
| Kids and privacy: a lab never sees a buyer, keeper, address, subject or result, in the notice, the portal, matching, upload or result view; the API refuses lab users every kit record | "fills a batch…", "lets only the lab's own…", "refuses a lab user every kit record through the API…", "never hands a lab user a keeper's name or a result…" |
| Results: name, type and size checks, header or name matching, conflicts, kits not sent or not ready; preview writes nothing | "matches files by name or header…" |
| Results: checksum, repeats taken once, re-runs, refusals recorded and never reaching `accept`, `accept`'s `failed` is a refusal, the batch completes | "takes a result through results.accept…" |
| Rollback when `results.accept` throws | "writes nothing when results.accept throws" |
| A result for the keeper and kit staff only: not a stranger, another keeper, the gift's buyer, a lab or another site's staff; the provider isn't asked for them and never gets the secret hash | "shows a result to the keeper and kit staff only…" |
| Order help: buyer only (others answer "not found"), reasons checked, refund at once in the window, kits back to stock | "refunds an unshipped order at once…" |
| Shipped orders go to staff; only the site's admins decide; never more than what's left, the shipping refund counted; a failed payment changes nothing | "sends a shipped order to staff…" |
| After the window: fixed cases keep back only lost postage, never more than shown | "after the window, cancels the fixed cases…" |
| Missed date: wait, move the vote (a site refusal records nothing), credit (keeps the vote, no money), refund (withdraws the vote after the commit); no credit offered without `creditOrder`; no vote to move refused | "past a missed promised date…", "refuses credit where the site gives none…", "counts refunds the site made before the move…" |
| Money: rollback when a provider throws after the refund, the refund's record kept, the retry refunds nothing more | "rolls the cancellation back when a provider throws…" |
| Money: racing refunds on one order never pass what was paid; three at once at the record keeper, one asked | "never refunds more than was paid when refunds on one order race" |
| Money: a refund left unanswered holds the order and counts as gone, until a site admin of that site settles it | "holds an order's refunds while one is unsettled…" |
| Money: the site's earlier refunds (without rows) count | "counts refunds the site made before the move…" |
| Pre-orders: `canSell` exactly true (a throw or `'yes'` refuses), not-a-kit refused; the site's terms rebuilt exactly; six-month cap | "sells kits only through subjects.canSell…" |
| Pre-orders: agreed words must match; vote placed after the commit and never failing the order; packing refuses; staff of the site release | "keeps the agreed words and promised date…" |
| Pre-order notices: three days before, a new date, the day after a missed date, each once | "tells the buyer three days before…" |
| Events: only what the events side offers, never throwing; the choice checked again; buyer only; refused after shipping | "offers only what the events side offers…", "refuses a drop-off on an order that has shipped" |
| Events: packing marks kits; reminder, moved, missed, each once; `noticeDateChanged`; staff list; mail release only after the date | "saves the choice, marks every kit…", "tells buyers at once when a booked date is canceled" |
| Indexes: manual mode refuses when missing or wrong (key, unique, partial filter), starts after `ensureSampleKitsIndexes`, which is safe twice; start-up mode makes them | the four tests in `indexes.test.ts` |
| Start-up checks for the new options | `options`: "refuses bad options with a plain message" |

### Mutation check

Each guard added in phase 3 (and the index existence check asked for by the site's team) was changed in turn by a Python string replace on the source, the test files that cover that area run (`labs`, `help`, `indexes`, and `shipping` for the refund changes), and the source restored exactly, with the SHA-256 of `src/` checked equal after every mutation.

- First run: 98 mutations, 91 caught. Survivors: `scope.isLabUser` (the test's rule only repeated what the scope already refused), shipping a batch twice, the secret hash kept from `results.view` (the test kit had none), a batch completing when only some kits had results, and three two-layer guards below. Tests added for the first four (a site person listed on the lab whom `isLabUser` refuses, a second `shipBatch`, a kit carrying a hash, the batch still `shipped` after one of two results); all four caught on the rerun.
- **Not caught alone, by design:** `batchKit`'s check that a kit isn't in another batch, and its conditional claim (`labBatch` empty): each alone survives because the other gives the same answer; both removed together is caught. The conditional claim is the layer only two requests at once reach. Likewise the cancellation's conditional claim on the order (`orderRefund.status` absent, status not shipped or canceled): the phase check refuses first; both removed together is caught. On MongoDB the transaction's write conflict also stops the second request.
- Final: 98 mutations, 95 caught, 3 concurrency-only layers explained above. The index existence check (missing, wrong key, not unique, wrong partial filter, the refusal itself, start-up making them, and making them unique) is caught in every form.

### Gaps

- Added in this pass: the tests above, and after the first mutation run four tests from the mutation check (see above).
- Skipped, and why:
  - A real payment service's idempotency: the fake answers a repeated key with the first record, as Stripe does; the plugin's own claim is tested directly.
  - Concurrency beyond one in-memory replica set.
  - `labsFor` for kit staff (they see every lab): it only lists names, behind the staff check the other tests cover.
  - Notices that fail for pre-orders and drop-off aren't retried by design; not tested beyond the notifier being called once.
  - The pages and their server functions: phase 4.

## 2026-11-10: phase 2

73 tests in four files. Phase 2 adds `test/shipping.test.ts` (37 tests): Payload 3.92 on in-memory MongoDB, with `fakeShipping` and `fakePayments` from `./testing`, and made-up people, hubs, addresses and orders on two made-up sites. `test/harness.ts` gained order fields a site would have (`customer`, `shipTo`, `amount`, `totals.shipping`) and a `products` collection.

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| The plugin adds `kitLines`, `kitFulfillment` and `kit` with the site's shapes; skips products when absent; refuses a clash; Shipping's handler registered only with Shipping | "adds the kit lines and fulfillment…", "skips products when there are none…" |
| The ShippingAdapter takes Shipping's own functions | Checked by compiling Shipping's exports (69f98d9) against `ShippingAdapter` and `LabelShipping`; not a test file, since Shipping isn't a dependency |
| Access: kit staff for packing, shipping and labels; admins for refund shipping; the buyer or keeper for their return label; other sites see nothing | "lets only kit staff of the order's site…", "refunds once, never more than paid, for the site's admins only", "gives the keeper the current label…" (stranger, other site, signed out) |
| Packing refuses recalled, expired, used and surplus kits, closed orders and non-kit orders; `packFor` writes only subject fields | "packs line by line…", "refuses kits from recalled or expired lots", access test, "rolls back a pack…" |
| The slip goes through `issueSecret`; secrets work; a slip can't be remade after activation | "makes the slip through issueSecret…" |
| Shipping needs every kit packed, a usable lot and the slip; the notice goes after the commit; its outcome is recorded; a caller's transaction waits for `runAfterCommit` | "needs the slip, ships…", "keeps the shipping when the notice fails…", "refuses to ship a kit whose lot was recalled behind its back", "drops work waiting for a commit…" |
| Order-time labels: box plan by cost, one outbound and one return label per box, once; two runs at once buy once | "plans boxes by cost…", "buys once when two runs start together" |
| Money: `MAYBE_BOUGHT` never bought twice, recorded, settled by staff | "never buys twice after an unclear answer…", "records an unclear return label as unknown…", "gives the keeper…" (extra label) |
| Money: `REFUSED` buys and records nothing; a half-way refusal keeps what was bought and retries only what's missing | "refuses when real postage is off…", "keeps what it bought when the carrier refuses half way…" |
| Money: unused labels refunded within 30 days, "too-old" after without asking; a carrier refusal keeps the label and isn't asked again | "asks for unshipped outbound labels' refunds…", "makes one per outbound box… reprints with a refund", "refunds labels freed by kits coming back in person…", "cancels unneeded labels when a kit is marked in person in the admin…" |
| Money: refund shipping once, never above paid, with a reason, fixed key; a failed or unconfirmed payment records nothing | "refunds once, never more than paid…" |
| Money: replacements, one free per subject for lost or expired, retests then one credit-back per kit; `afterLastRetest: 'none'` | "replaces a recalled kit…", "gives one free replacement…", "sends a retest after a failed sample…", "skips order labels in the background…" (second instance) |
| Recall puts unshipped orders back in the packing queue | "takes packed kits out and puts the order back…" |
| Tracking: delivered once, return leg doesn't move kits, notices after the commit, unknown parcels left to other handlers | the two "carrier tracking" tests |
| No leak of return labels, their trail, or kits to strangers | "keeps return labels, their trail and the order's buyer…", plus refusals that answer alike for unknown and others' records |
| Rollback when a provider or the adapter throws | "rolls back when the site's onShipped throws…", "rolls back a pack…", "sends a retest…" (credit-back throws), "makes one per outbound box…" (a failed reprint purchase leaves the old label) |
| Prices, shipping tiers, box plans; hub addresses checked through Shipping's `addressProblems` (a phase 1 gap) | "prices, shipping tiers and box plans" (four tests) |

### Mutation check

Each guard added in phase 2 was removed in turn (a Python string replace on a backup, restored exactly, SHA-256 of `src/` confirmed equal before and after), and the full suite run.

- First run: 69 guards, 61 caught. Survivors: an order with no kit lines, packing into a closed order, the reprint's staff check, settling a label that isn't unknown, a refund answer for a refund nobody asked for, and dropping after-commit work on rollback. Tests added for each; all caught on the rerun.
- Two guards have two layers (a check, then a conditional write): packing a kit that isn't free, and refunding shipping twice. The checks alone survived at first, because the second layer gave the same answer; the tests now also check the message or the order of refusals, and both are caught. Both layers removed together are caught.
- **Not caught, by design of the test bed:** the conditional write alone, in `packKit` (`status in PACKABLE`) and `refundShipping` (`shippingRefund.status not_in`). Only two requests at once can reach them, and on MongoDB the transaction's write conflict stops the second request anyway. They stay for databases without that conflict. Not mutated: the order-labels claim's refresh before each purchase (`stillMine`), for the same reason.
- Final: 73 mutations, 71 caught, 2 concurrency-only layers explained above.

### After the maintainers' review (2026-11-10)

76 tests. Added:
- "keeps a paid label's record when the caller's transaction rolls back, and links it again instead of buying": order-time labels and packing's return labels bought inside a caller's transaction that is then rolled back; the `return-labels` rows stay `active` with their tracking, and the next run buys nothing.
- "refuses another purchase for an order and box while one is buying or unknown, until settled": a `buying` row left as by a crash blocks packing's return label for that box, order-time labels, and the record keeper itself (which never asks the carrier); the record says `buying` while the carrier is being asked; settling it as not bought frees the box.
- "lets staff on site A read none of site B's return labels, kits or lots through the API": every plugin collection read through the API by staff and an admin of each site, a lot by id, and an update across sites.

Mutation check, rerun in full on the changed code: 81 guards, 79 caught. New guards, all caught: the record keeper's refusal while `buying` or `unknown`; the intent written as `buying`; only a clear refusal counting as `not-bought`; a kept purchase linked instead of bought; a pending row stopping order labels; `buying` counting as present at packing; settling only `buying` or `unknown` rows; the scope filter, and kits', return labels' and lots' access through it.

The keeper's own check for a `buying` label survived (the record keeper refuses the same way first), so it was removed: one guard, tested, instead of two.

**Known survivors, accepted by the maintainers:** the conditional write alone in `packKit` (`status in PACKABLE`) and in `refundShipping` (`shippingRefund.status not_in`). Only concurrent requests can reach them, and on MongoDB the transaction's write conflict stops the second request anyway. Removing the earlier check too is caught.

Atomic slot claim (maintainers, last money point), 78 tests: "lets only one of three simultaneous purchases for a slot reach the carrier" (one carrier call, one active row, the others refused with `labelUnknown`, and the slot free again after it settles, as for a reprint) and "backs the claim with a unique index that ignores settled rows" (the index's shape; an `unknown` purchase keeps its claim until settled as not bought). Five more mutations, all caught: the index made, the index unique, a duplicate claim refused as `labelUnknown`, the claim carrying its key, and settled rows freeing it. Totals: 86 guards, 84 caught, the same two known survivors.

Not mutated: the record being written outside the transaction (moving it inside isn't a string replace); the rollback test proves it directly.

### Gaps

- Added in this pass: the tests above.
- Skipped, and why:
  - Shipping itself and a real carrier: Shipping tests its own functions; here, a type check proves the shapes match.
  - Concurrency beyond one in-memory replica set (see the mutation check).
  - `boxUsage`, `ordersWithLabelProblems`, `returnLabelSpend`, `recalledAwaitingReplacement`: staff reports that only read, behind the same staff check the tests cover. Worth a test when the pages (phase 4) use them.
  - A caller's transaction rolled back after a label purchase: documented as a limit in the README rather than tested.
  - MongoDB's 60-second transaction limit with a slow carrier: not reproducible with the fake.

## 2026-11-10: phase 1

36 tests in three files: `test/codes.test.ts` (pure), `test/kits.test.ts` and `test/options.test.ts` (Payload 3.92 on in-memory MongoDB, fake providers from `./testing`, made-up people on two made-up sites).

### Promises and the tests that prove them

| Promise | Tests |
| --- | --- |
| Activation always needs the kit's own secret; every failure gets the same answer | `kits`: "activates only with the kit's own secret…" (wrong, none, missing, the code, the code cut to length, another kit's, too long, no such kit, not a code), "never activates with a code given as its secret, even if a hash for it were stored", "says nothing about…" (a used secret answers like a wrong one) |
| The secret is stored only as a hash, never readable, never in the trail; a new one cancels the old | `kits`: "stores only a hash…"; `options`: the override test reads with access overridden |
| The hash format matches the site's, so stored hashes survive the switch | `codes`: "matches hashes the site made before the move" |
| Status only through events | `kits`: "ignores a status sent through the API…", "moves the status with each event…"; `options`: an override's hook that sets the status is refused |
| Codes and lot numbers can't change | `kits`: "keeps a kit's code and a lot's number once set"; `options`: the same after an override |
| Recall sets kits aside in the same transaction; packed kits leave their order with their secret | `kits`: "sets stock aside…", "applies a recall ticked in the admin in the same save" |
| Only a maintainer lifts a recall; kits stay recalled | `kits`: "can't be lifted by staff or admins, or by a script…"; `options`: the same after an override |
| Activation refuses recalled and expired lots, even if the recall's processing never ran | `kits`: "refuses activation when the lot was recalled behind the kit's back", "refuses an expired lot" |
| Access by role, with refusals for buyer, stranger and the signed-out | `kits`: "lets only kit staff receive…", "gives each role its collections…", "shows a buyer their own kits only…" |
| Only exactly `true` passes; a buyer rule must be a query | `options`: "refuses truthy answers that aren't true, thrown errors, and a buyer rule that answers true" |
| Tenancy through `scope` | `kits`: "keeps each site's kits to that site", and stamping in "gives each role its collections" |
| A provider that throws rolls the whole action back; actions join the caller's transaction | `kits`: the four "a provider that throws…" tests, and "adds a built kit inside the caller's transaction" |
| No leak of the buyer, the secret or a subject to a stranger, or to a gift's keeper | `kits`: "says nothing about a kit's buyer, secret or subject…" |
| Overrides can't remove the plugin's rules, and can only narrow access | `options`: "keeps status, code, secret, recall, the trail and kit access…", "refuses an override that removes a field…" |
| Start-up checks with plain messages | `options`: "refuses bad options with a plain message" |
| Receiving, lots, codes, barcodes, statuses | `kits`: "adds a lot with a serial range…"; `codes`: all |
| `markSampled`: keeper only, subject re-checked, confirmed record kept as plain JSON | `kits`: "lets only the keeper mark an activated kit sampled…", "moves the status with each event…" |

### Mutation check

Each safety guard was removed in turn (a Python string replace on a backup, restored exactly and confirmed by SHA-256 checksums of `src/`), and the full suite run. 35 guards; all 35 caught.

- Secret: the constant-time compare, the all-digit refusal (code as secret), activation's secret check, the secret cleared on activation, the hash's `hidden` flag and read access, `issueSecret`'s lot check.
- Status: the field rule, `recordKitEvent` refusing `set.status`.
- Immutability: kit code, lot number, the never-edited trail.
- Recall: applied on save, packed kits cleared, lift only by a maintainer, activation refusing recalled and expired lots.
- Access: exactly `true`, buyer rule must be a query, strangers read no kits, buyer and order hidden from others, staff-only actions, site people only, scope on lookups, no site no action.
- Keeper: only the keeper marks sampled, `canSample` exactly true, `assign` writes only subject fields, the confirmed record checked.
- Transactions: rollback on failure. **Missed on the first run**: Payload aborts the shared transaction itself when one of its own operations throws, so no test reached the plugin's rollback. Added "takes back a provider's own writes when it throws after making them" (a provider writes, then throws outside Payload); rerun, caught.
- Overrides: field hooks, collection hooks, field access and `hidden` put back, access only narrowed, a removed field refused.

### Gaps

- Added in this pass: none outstanding; the tests above were written with the code.
- Skipped, and why:
  - The hub address check through `adapters.shipping.addressProblems`: a few lines moved as they were, and Shipping tests its own function. Worth a test when phase 2 wires Shipping.
  - `fakeSubjects().choices` and `subjects.choices` in general: not called until the pages (phase 4).
  - Payload's own field validation (min, max, required), and the admin panel's conditions and descriptions: framework behavior.
  - Concurrent activations of one kit: two at once rely on MongoDB's write conflict inside the transaction. Not tested here; the site didn't test it either.
  - Postgres: the plugin is tested on MongoDB only.

## 2026-11-10: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.

The maintainers' review of phase 3 (2026-11-10): a delay notice that fails to send is retried on the next run (`pre-order notices that fail to send`); removing the undo fails it. 109 tests.
