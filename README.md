# payload-plugin-sample-kits

Sample Kits for Payload: track sample kits from stock to the keeper and back, with a custody trail for every status change, lot recalls that fail closed, a one-time secret to activate each kit, and prepaid shipping labels that are never bought twice.

**Status:** all four build phases: the collections and actions (phases 1 to 3), the links to Kitting, Scan, Wizards and Seed (4a), and the pages' server functions and components (4b). Tested with 244 tests: the actions and server functions on Payload 3.92 with an in-memory MongoDB and fake providers (subjects, shipping, payments, results, events, Kitting's units), and the components in jsdom with Testing Library; plus a mutation check of every safety guard (a few layers that only two requests at once can reach aren't caught; see `docs/test-audit.md`). Scan and Wizards are tested through their own `resolveScan` and `answersFor`; the activation wizard is tested with a stand-in shaped like Wizards' `<Wizard>`. Kitting is tested through a stand-in with Kitting's shapes and refusal codes. Who reads which kit and order fields is tested through the Local API and REST; GraphQL uses the same field rules but isn't run here. It isn't on npm, and no site runs it yet. The pages haven't been seen in a real browser, a phone or a screen reader, and it hasn't been tried with Kitting, Shipping, a real carrier, a payment service, a real lab, an events plugin, a real admin panel or a site's own providers. Kitting's packing station and the Labels provider aren't here.

Not for human medical or diagnostic testing.

## What it does

- Adds ten collections: `kit-lots`, `kits`, `kit-events`, `box-types`, `hubs`, `labs`, `lab-batches`, `return-labels`, `kit-refunds` and `kit-notices`. The first eight use the same slugs and field names as the first site that used it, so a site moving to the plugin needs no data migration. `kit-refunds` and `kit-notices` are new: the record of every refund, and of every shipment notice owed.
- A kit's status changes only through its events (`recordKitEvent`). An API write of a status is dropped, and a direct write is refused.
- A kit's code and a lot's number can't change once set.
- Recalling a lot sets its kits aside in the same transaction. Kits in stock are recalled, packed kits are taken out of their order with their secret canceled, kits sold but not used are recalled, and kits already sampled get a note for staff. Only a maintainer can lift a recall, and the kits stay recalled.
- Activation always needs the kit's secret. A code alone, or a code given as its secret, never activates. Secrets are stored as a SHA-256 hash bound to the kit's code and the site's Payload secret, compared in constant time, and never readable. A missing kit, a wrong secret, a used one and a malformed one all get the same answer.
- Whoever holds the slip can activate the kit for a subject they're allowed to sample, and becomes its keeper. Of two activations at once, exactly one wins, with or without transactions; the other is told `busy`.
- A gift's buyer and its keeper never see each other, in the pages or through Payload's REST, GraphQL or Local API. On a kit, the buyer and kit staff read `buyer`, `order`, `orderLine`, `identifierLabel`, `secretIssuedAt` and the subject fields named in `subjects.buyerFields` (what it was bought for). The keeper and kit staff read `activatedBy`, `activatedAt`, `sampledAt` and every other subject field (what was sampled). `notes` is for kit staff only. A field someone can't read is also one they can't query or filter on, and `activatedBy` is never filled in as the keeper's user record for anyone else. These rules survive `overrides`: an override's own field access can narrow them, never widen them.
- On your orders, `kitLines` and `kitFulfillment` change only through kit staff (the plugin's own writes), and the label purchases, the labels run, the notice bookkeeping and who on staff decided or refunded read for kit staff only. The rest of the order's access is yours.
- `markSampled` keeps the guided steps' record (`confirmed`) on the event.
- Adds `kitLines` and `kitFulfillment` to your orders and a `kit` group to your products, with the site's names and shapes.
- Packing: kits fill an order's lines in turn, and your subject provider says what each kit is for. Packing refuses a recalled, expired or used kit. The slip gives every kit a new secret through `issueSecret`, so an older printout stops working.
- Shipping: an order ships only when every kit is packed, its lot is still usable and the slip is made. The buyer is told through `notify` after the commit, and the order records whether that went.
- Labels at order time, through Shipping: the box plan is chosen by what the labels cost (each box needs an outbound and a return label), then each box's labels are bought once. A claim on the order stops two runs buying twice.
- Return labels: one per outbound box, plus one extra per kit if a keeper asks. Reprints when a hub's address changes, refunds of labels freed by kits handed in person, and nothing asked once USPS's 30 days have passed.
- Every label purchase is recorded before the carrier is asked: a `return-labels` row with status `buying`, written straight to the database outside any transaction, then updated the same way to `active`, `unknown` or `not-bought`. So a paid label's record survives any rollback, yours included, and a later run links it instead of buying again. Outbound purchases get a row too, with kind `outbound`. Only one purchase can claim an order's box (or a kit's extra label) at a time, enforced by a unique index, so a double-click or a retry can't buy twice.
- A purchase whose outcome is unclear (Shipping's `MAYBE_BOUGHT`, or a `buying` row left by a crash) stops every automatic purchase for that order and box or kit until staff settle it with `settleUnknownLabel`. `REFUSED` (real postage off) buys nothing.
- Tracking from Shipping's webhook: "delivered" moves shipped kits to Delivered, and return parcels are noted without moving kits. Through `notify`, after the commit: the buyer hears when an outbound parcel is out for delivery, delivered, or has a problem (failure, error, returned to sender), and kit staff hear about the problem too. On the return leg, each keeper hears about a problem with the parcel carrying their kits (the buyer, if nobody activated them), and so do kit staff; a gift's buyer isn't told. A return parcel in transit or delivered tells nobody: when the hub checks a kit in, its keeper is told the sample arrived.
- Each of those notices goes once per parcel, notice and person, however often the carrier repeats an update or sends it twice at once. Every one is recorded in `kit-notices` in the same transaction as the update (a unique index lets each exist once), then sent after the commit. One that fails to send is tried again on the parcel's next update, the kit's next check-in scan, or `retryKitNotices` (run it daily), up to five tries; then it says `gave-up` for staff. Notices carry kit codes, tracking numbers and the order (never to a keeper); never an address or a result.
- Refund shipping as goodwill (site admins): once per order, never more than paid, with a reason, through your payments provider with a fixed key.
- Replacements: a free order for lost, expired, recalled or failed kits. After the last free retest fails, a test goes back through `payments.creditBack`, once per kit.
- A recall also puts orders whose packed kits it took back into the packing queue.
- Price tiers and flat shipping tiers, as plain functions over the product's tiers.
- With `scope`, the plugin's own access keeps each site to its rows: staff, admins and buyers read (and staff and admins change) only rows of the request's site, even without a multi-tenant plugin.
- Hub check-in (kit staff), scanned or typed: only kits a keeper activated, with a warning for one not marked sampled or meant for another hub.
- Lab batches: made, filled by scan and shipped with tracking numbers. The lab's notice (tracking and a kit list as text and CSV) is kept on the batch and sent through `notify` after the commit; how that went is recorded on the batch.
- The lab portal, for people listed on a lab's `portalUsers` (and passing `scope.isLabUser` when you give it): confirm a batch arrived, preview which kit each result file is for, and upload results. A lab sees kit codes, statuses and markers. It never sees a buyer, a keeper, an address, a subject or a result.
- Result files: checked for name, type and size, hashed (SHA-256), and matched to a kit sent to that lab by the code in the file name or FASTA header. The same file twice is taken once; a second file is a re-run. What a file means is yours (`results.accept`). A refusal is recorded on the kit for staff and returned to the lab in plain words.
- Results are shown through `resultView` to the kit's keeper and kit staff only. Anyone else gets nothing, and your `results.view` isn't asked.
- Event drop-off through your events side: `dropOffOffer` asks `adapters.events.dropOffChoices`, `chooseDropOff` checks the choice again and saves it on the order, packing marks each kit with where it's handed in, and a kit marked after its labels were bought gets them refunded. Buyers are reminded a week before, told at once when a date moves or is canceled (`noticeDateChanged`), and told the day after a missed date, each once. After a missed or canceled date, `releaseForMail` lets them mail the kits back.
- Order help: a refund at once within the refund window if the order hasn't shipped; after it, a few fixed cases cancel at once keeping back only postage that can't be recovered, never more than the buyer was shown; shipped orders and anything else go to staff, and site admins decide. After a missed pre-order date the buyer chooses to wait, move the vote, take credit or get a full refund.
- Every refund (order, staff decision or shipping goodwill) goes through `payments.refund` with a fixed key, and is recorded in `kit-refunds` before it's asked, outside any transaction. Only one refund per order can be asked at a time, enforced by a unique index, and the limit is checked after that claim against every committed refund: never more than was paid, the site's own earlier refunds included.
- Pre-orders: `checkKitSale` asks `subjects.canSell`, `startPreorder` keeps the promised date and the words the buyer ticked, kit staff release them all at once, and buyers hear three days before the promised date, when a new date is set, and the day after a missed one. Votes stay yours, through `onPreorderVote`.
- Kitting's units, when `adapters.kitting` is wired: each kit Kitting builds becomes an in-stock kit in the build's transaction (`kittingOnBuild`); packing takes the scanned kit's unit for the order; unpacking and canceling give units back; shipping marks the units shipped; a recall voids the lot's units. Every call joins the action's transaction, so if Kitting refuses or fails, the kit's change is rolled back too. With Kitting wired, a database without transactions is refused before anything is written.
- Scan links, when `adapters.scan` is on: `k` (a kit code) and `b` (a shipping box, `boxCode(order, box)`), registered with Scan. Kit staff of the site go to the record; the buyer goes to activation (the code only, never the secret) or their order; staff get "Not found" for a code that doesn't exist; everyone else gets Scan's one quiet answer.
- The guided activation, when `adapters.wizards` is wired: the `kit-activation` flow is registered with Wizards (find the kit, choose the subject, every active `safety` step, sampled), and `markSampled` checks the answers itself with Wizards' `answersFor`, so a client can't skip a step. A changed wording or an empty safety group is refused.
- Made-up kit data for demos: `seedKitStory` tells one keeper's story through the plugin's own actions, marks every record and reports it; `removeKitRecords` removes only marked records of the caller's site. Both need the seed plugin's own `allow()` to say yes (`adapters.seed`), a marker, and kit staff or an admin. An optional `stamp` keeps sandbox batches apart, and an optional `context` rides on every write and delete.
- The rate study: `rateStudy` prices order sizes by region from Shipping's test-mode quotes, and refuses production mode. Nothing is bought.
- Every action runs in the caller's transaction, or its own when there isn't one. If anything throws, a provider included, nothing is written. The one exception is the record of label purchases, which is written outside any transaction so it can't be lost; nothing is thrown after money has moved.

## On its own, and with others

**On its own:** Sample Kits doesn't need any other plugin. It adds its own collections and some fields on your orders and products, and asks your site for access checks, a subjects provider, and, if you want them, `notify` and a payments provider. Without Shipping no labels are bought, and without Wizards `markSampled` takes your own `confirmed` record.

**Works with** (each is an option in [Options](#options); none is imported):
- **Kitting:** `adapters.kitting`, Kitting's own functions, so built units become kits and packing, shipping and recalls move Kitting's units in the same transaction.
- **Shipping:** `adapters.shipping`, Shipping's functions, for outbound and return labels, refunds and tracking. It registers its tracking and refund handler at `config.custom.shippingHandlers`.
- **Scan:** `adapters.scan` registers the `k` and `b` link kinds at `config.custom.scanKinds`.
- **Wizards:** `adapters.wizards` registers the `kit-activation` flow at `config.custom.wizardFlows`, and checks the answers with Wizards' `answersFor`.
- **Events:** `adapters.events.dropOffChoices` is yours to map onto event dates, for example from Events' `dropOffDates`. Events knows nothing about kits.
- **Notifications:** your site can point `notify` at Notifications' `notify`.
- **Seed:** `adapters.seed` takes the seed plugin's `allow`, for made-up kit stories.
- **Labels** (not built): `adapters.labels` is typed but not called yet. Kitting's packing station isn't built either.

**Family:** Sample Kits sits in the Fulfillment family, with Kitting, Restock, Shipping, Scan, Labels, Wizards, Custody and Sequences, though the families are a working draft and Fulfillment is due to be split into different groups.

## Install

Not published yet. Once it is:

```sh
npm install @extantape/payload-plugin-sample-kits
```

```ts
import { buyerOrKeeper, sampleKits } from '@extantape/payload-plugin-sample-kits'

export default buildConfig({
  collections: [Users, Orders, Files /* … */],
  plugins: [
    sampleKits({
      // Each check answers for the site scope.of(req) gives, never for "any site".
      access: {
        staff: async (req) => isKitStaffOn(req.user, await tenantOf(req)),
        admin: async (req) => isSiteAdminOn(req.user, await tenantOf(req)),
        maintainer: (req) => isMaintainer(req.user),
        buyerOf: buyerOrKeeper,
      },
      subjects: mySubjects, // what a kit is for: your fields and rules
      tests: [
        { label: 'Cytochrome b (cyt-b)', value: 'cyt-b' },
        { label: 'Autosomal (coming later)', value: 'autosomal' },
      ],
      // From trusted server data (the domain the server answered on, or the signed-in person's tenant), never a
      // cookie or header the browser chose.
      scope: { field: 'tenant', of: (req) => tenantOf(req) },
      site: async ({ site }) => siteDetailsOf(site), // { name, origin, labPortalPath? }, for slips and lab notices
    }),
    // A multi-tenant plugin that adds the `tenant` field goes after this one.
  ],
})
```

The `tests` list above is one real site's, as an example. There's no default.

### Scope: the contract

With `scope`, every check rests on two promises from your site. The plugin can't check either for you:

- **`access.*` answers for the site `scope.of(req)` returns.** `staff(req)` means "kit staff of this request's site", not "kit staff somewhere". A person who is staff on site B must get `false` on a request for site A. The plugin only ever asks with the request it has, and keeps each site to its own rows, but a check that ignores the site lets B's staff act on A.
- **`scope.of(req)` comes from trusted server data:** the host the request came in on, or the signed-in person's own tenant, as your server decided it. Never a cookie, header or query parameter the browser chose, or anyone could pick another site.

Start-up refuses a `scope` without `access.staff` (it's required anyway), and `Payload`'s `secret` shorter than 16 characters, since it's the pepper for every kit secret.

## Options

| Option | What it is |
| --- | --- |
| `access` | `staff`, `admin` and `maintainer`, each `(req) => boolean`. Only an answer of exactly `true` counts; anything else, a thrown error included, is no. A maintainer passes as admin and staff, and an admin as staff. `buyerOf` (optional) returns the Payload query for the kits a signed-in person may read; `buyerOrKeeper` is the usual rule. |
| `subjects` | What a kit is for. `fields` are added to `kits`. `buyerFields` names which of them say what the kit was bought for: those read for the buyer and kit staff, the rest for the keeper and kit staff (any read access you put on a field must pass too). `suggestedOf(kit)` and `sampledOf(kit)` map them to a `{ kind, id }` reference. `assign({ kit, ref, req })` returns the data to write at activation, using only those fields. `canSample({ user, ref, kit, req })` answers `true` or a refusal `{ code, message }`. `kinds`, `choices`, `label` and `canSell` are optional. |
| `tests` | The tests a kit can carry, `{ label, value }`. The first is the default. Required. |
| `collections` | Slugs of your `users`, `orders`, `products` and `files` collections. Defaults to those names. `users`, `orders` and `files` must exist when the plugin runs. |
| `scope` | Tenancy: `field` names the field that holds a record's site, and `of(req)` gives the site for the request. New records are stamped with it, and the actions only find records on that site. Leave it out on a single-site install. |
| `overrides` | `{ [slug]: (collection) => collection }` for your own fields, admin components and hooks. The plugin puts its rules back afterwards. Your access can narrow the plugin's, never widen it. |
| `adapters.shipping` | Shipping's functions, passed unchanged (see below). `addressProblems` alone checks hub addresses. Labels need all of `quote`, `buy`, `buyReturn`, `quoteReturn`, `refund`, `labelAddress`, `addressKey` and `parcelFor`; give all or none. `mailability` (optional) leaves out boxes too big or heavy to mail. With them, the plugin registers its tracking and refund handler at `config.custom.shippingHandlers`. |
| `orders` | What the plugin reads from your orders, all optional: `buyerOf(order)` (default `customer`), `shipTo({ order, req })` (the ship-to address; without it, labels are refused), `shippingPaidCents({ order, req })` (default `totals.shipping`, never above `amount`), `replacement({ order, kit, req })` (your fields for a free replacement order; default `{ customer }`), and `onShipped({ order, req })` for your own fields when an order ships. |
| `payments` | `refund({ order, amountCents, reason, key, req })` and `creditBack({ kit, reason, key, req })`. Pass `key` on as the payment service's idempotency key. When the service clearly refuses (nothing was refunded), throw an error with `refused: true` (`refundRefusal()` makes one) or a `KitError`. Any other throw, and an answer without an id, is recorded `unknown` and counted as paid back until a site admin settles it. |
| `site` | `{ name, origin, labPortalPath? }`, or `({ site, req }) => …` for many sites: the site's name and address for the slip's activation links and the lab's batch notice (portal at `origin` + `labPortalPath`, default `/lab`). From your own trusted data, never from a page. `origin` is checked at start-up: `https://host[:port]`, no path. Without it, slips have no links and the notice names no address. |
| `subjects.lineFields`, `lineKinds`, `packFor`, `lineFor` | Your fields on each order line, the line kinds offered, what each packed kit is for (`{ set, label }`, only your subject fields), and the line for a replacement. |
| `notify` | `({ kind, to, data, req })`, called after the commit: `kits-shipped`, `kit-shipment` (`data.event`: `out-for-delivery`, `delivered` or `exception`; `data.leg`: `outbound` or `return`), `kit-shipment-staff` and `kit-arrived` (to the keeper). What `to` holds depends on who it's for. **Buyer:** `{ user, order }`. **Keeper** (`kit-arrived`, and a return parcel's problem): `{ user, order: null }`, never the buyer's order, since a keeper may be a minor who got the kit as a gift; send to whichever account your site keeps for that user. A keeper who is the order's own buyer (checked when the notice is planned, and for a return parcel nobody activated) gets `{ user, order }`. **Kit staff** (`kit-shipment-staff`): `{ user: null, order, staff: true, site }`, where `site` is the order's site (null without `scope`), so tell only that site's kit staff. With `scope`, a staff notice that has no site is never sent: it's recorded as `gave-up` with delivery `noSite`. Answer `'sent'`, `'not-sent-side-effects-off'`, `'not-sent-test-addresses'` or `'no-address'`; nothing means sent, a throw is recorded as failed, and any other answer is recorded as `unknown`. |
| `policy` | `freeRetests` (default 1), `afterLastRetest` (`'credit'`, the default, or `'none'`), `kitWeightOz` (default 4.2) and `returnWeightOz` (default 8). Both weights are placeholders until you set them. |
| `results` | `accept({ kit, file, lab, rerun, req })` stores and reads one result file and answers `{ status: 'ready' \| 'review' \| 'failed', summary?, file? }`; `failed` is a refusal, with `summary` as the reason the lab sees. `view({ kit, user, req })` gives the keeper their result. Optional: `extensions` (default FASTA and `.txt`), `maxBytes` (default 900,000) and `check(text)` (a plain-words problem or null, e.g. the exported `fastaProblem`). `verifyUpload({ fileId, req })` turns on uploads by file id (below). `maxBase64Bytes` (default 3,000,000) caps a file sent as base64 when `verifyUpload` isn't set. `types` lists the content types taken by file id (default `RESULT_TYPES`). |
| `scope.isLabUser` | `(req, lab) => boolean`: whether this person may use the portal for this lab on this site. Only exactly `true` passes, and the person must also be on the lab's `portalUsers`. Leave it out and being listed is enough. |
| `adapters.events` | `dropOffChoices({ tenant, country, postalCode, now, req })` returns `DropOffChoice[]` (`{ dateId, eventName, eventSlug, starts, timezone, place, miles? }`). Optional `dateOf({ dateId, req })` gives a booked date as it is now (`{ starts, timezone?, canceled? }` or null); without it, moved and canceled dates can't be told. Call the exported `noticeDateChanged({ dateId, req })` when a booked date changes. |
| `payments.creditOrder` | `({ order, mode, reason, key, req })`, optional: credits back when an order is canceled; answer `{ credits }`. Without it, "take credit" isn't offered and no credits come back. |
| `orders.paidCents`, `orders.onCanceled` | What the order paid (default `amount`), the most all its refunds give back; and your own fields when an order is canceled. |
| `onPreorderVote` | `({ action: 'place' \| 'move' \| 'withdraw', order, item, req })`, optional. `place` and `withdraw` run after the commit and never fail the order; `move` runs in the transaction and a throw refuses it. Answer the vote to keep on the order (`{ item, vote, contribution }`) or null. |
| `preorders.voteItems` | The collection a vote's `item` points to; without it, `item` is text. |
| `policy` (phase 3) | `refundWithinDays` (default 30), `preorderMaxMonths` (default 6), `storeTimeZone` (default `'UTC'`) for refund windows and promised dates. |
| `ensureIndexes` | `'startup'` (default) makes the unique indexes money depends on when Payload starts. `'manual'` only checks they're there, read-only, and refuses to start if one is missing or wrong: run `ensureSampleKitsIndexes(payload)` from your own index script first. |
| `tests[].marker` | What the lab calls the test on the batch's kit list. Default: its `value`. |
| `adapters.kitting` | Kitting's own exports, passed unchanged: `assignUnits`, `swapUnit`, `release`, `shipUnits`, `voidUnit`, and optionally `sendPendingAlerts`. `recipe` names the sample kit's recipe (`{ key: 'sample-kit' }`). Optional: `units` (Kitting's units collection, default `assembled-units`), `scopeField` (default `scope.field`) and `reference(orderId)` (default `Order <id>`). |
| `adapters.scan` | `true`, or `{ paths }` with your own `kit`, `activate`, `order` and `myOrder` paths. Registers the `k` and `b` kinds at `config.custom.scanKinds`. |
| `adapters.wizards` | `{ answersFor }`, Wizards' own function. Registers `kit-activation` at `config.custom.wizardFlows`, and `markSampled` then takes `answers` and `locale` instead of `confirmed`. |
| `orderHelp.reasons.damaged` | Default `false`. When on, "damaged" is offered and accepted on a shipped order, goes to staff, and is answered with a replacement (`replaceKit(…, 'damaged')`), never a refund. |
| `adapters.seed` | `{ allow }`, the seed plugin's own `allow(req)`. `seedKitStory` and `removeKitRecords` ask it first, and only exactly `true` lets them run; without it they're refused (`seedNotAllowed`), so production can't be seeded from either side. |
| `orders.seeded` | `({ buyer, kits, paymentId, req })`, for `seedKitStory`: your fields for a made-up paid order. `paymentId` is a stand-in, `seed_pi_<16 digits>`. Default `{ customer: buyer }`. |
| `i18n` | `{ t(key, vars) }`, the site's translator. The server functions' messages ask it for `sampleKits.<key>` (refusals: `sampleKits.errors.<code>`), and the pages for `sampleKits.ui.<key>`. A missing key (empty, or the key itself) stays English. |
| `orders.buyerWhere` | `(buyer) => Where`, the query for a buyer's orders on `/my-tests`. Default `{ customer: { equals: buyer } }`. Each order found is checked again with `buyerOf`. |
| `adapters.labels` | Typed for the Labels provider. Not called yet. |

With Shipping installed, pass its functions:

```ts
import * as shipping from '@extantape/payload-plugin-shipping'

sampleKits({
  // …
  adapters: {
    shipping: {
      quote: shipping.quote, buy: shipping.buy, buyReturn: shipping.buyReturn, quoteReturn: shipping.quoteReturn,
      refund: shipping.refund, labelAddress: shipping.labelAddress, addressKey: shipping.addressKey,
      addressProblems: shipping.addressProblems, parcelFor: shipping.parcelFor, mailability: shipping.mailability,
    },
  },
})
```

Sample Kits never imports Shipping. It reads Shipping's errors by their `code`.

With Kitting, Scan and Wizards installed, pass Kitting's and Wizards' functions and turn Scan on. Sample Kits imports none of them:

```ts
import * as kitting from '@extantape/payload-plugin-kitting'
import { answersFor } from '@extantape/payload-plugin-wizards'
import { kittingOnBuild, sampleKits } from '@extantape/payload-plugin-sample-kits'

plugins: [
  sampleKits({
    // …
    adapters: {
      kitting: {
        recipe: { key: 'sample-kit' },
        assignUnits: kitting.assignUnits, swapUnit: kitting.swapUnit, release: kitting.release,
        shipUnits: kitting.shipUnits, voidUnit: kitting.voidUnit, sendPendingAlerts: kitting.sendPendingAlerts,
      },
      scan: true,
      wizards: { answersFor },
    },
    orderHelp: { reasons: { damaged: true } },
  }),
  kitting.kittingPlugin({ scopeField: 'tenant', units: { onBuild: kittingOnBuild({ recipeKey: 'sample-kit' }) } /* … */ }),
  scanPlugin(),
  wizardsPlugin({ /* … */ }),
]
```

Kitting builds need kit staff on their `req` (`buildUnits(payload, recipe, ids, { req })`), since each built unit becomes a kit through `addBuiltKit`. Call `assignKitUnits(payload, orderId)` when an order becomes packable (paid, or all-credit); it never throws. Your scan routes call Scan's `resolveScan`, and print `boxCode(order, box)` on shipping box labels.

The seed plugin wires its own gate and calls:

```ts
sampleKits({ /* … */ adapters: { seed: { allow: seedPlugin.allow } } })


const context = { audit: { origin: 'script', system: 'seed-world' }, disableRevalidate: true }
const summary = await seedKitStory(payload, { scope: tenant, people: { keeper, staff, lab }, mark: MARKER, stamp: { sandboxBatch: batchId }, context, track, req })
await removeKitRecords(payload, { ids: tracked, mark: MARKER, stamp: { sandboxBatch: batchId }, context, req })
```

Both need `adapters.seed.allow(req)` to answer exactly `true`, a `mark` (a field name), and `req` to be kit staff or an admin of `scope`'s site. `track(collection, id)` hears of each record made, oldest first; `ids` are those pairs.

`stamp` (optional) is extra fields set, with the marker, on every record the story makes, shipment notices included. Each key must be a field on every collection the seed writes (the ten kit collections and your orders), and can't be one of the plugin's own fields, the marker, `id`, `createdAt` or `updatedAt`. Each value is a non-empty string, a finite number or true/false. Anything else is refused with `badStamp` before anything is written. Given the same stamp, `removeKitRecords` removes only records carrying the marker and every stamp field, so one batch's removal never takes another batch's kits; without one it removes any marked record, as before. Each stamped story makes its own hub and lab.

`context` (optional, a plain object, else `badContext`) is passed on every write the story makes, the plugin's own actions included, and every delete the removal makes. It goes under the plugin's own context keys, which win, except `audit`, merged field by field: your `origin` and `system` win (a seed run is a script), the plugin's `reason` and any other key it sets win over yours, and your other audit keys stay. So every seed write and delete is labeled with your origin and system and the plugin's reason. The keys the plugin's guards read (`sampleKitsEventWrite`, `skipLabelCancel`, `sampleKitsAfterCommit`) are dropped from yours, so a context can't switch a guard off.

Every provider call gets `{ req }` and runs inside the caller's transaction. Pass `req` on to Payload in your provider so its reads and writes join it.

## Actions

Each takes the request first, checks who may do it, and returns plain results or throws a `KitError` with a `code`.

- Kit staff: `checkInKit`, `createBatch`, `batchKit`, `unbatchKit`, `shipBatch`, `releasePreorders`, `requestsToReview`, `expectedAtEvents`, `createLot`, `receiveKit`, `addBuiltKit` (the seam for Kitting), `issueSecret`, `recallLot`, `packKit`, `unpackKit`, `makeSlip`, `markShipped`, `makeOrderLabels`, `makeOrderReturnLabels`, `staleReturnLabels`, `reprintReturnLabel`, `cancelReturnLabels`, `refundOutboundLabels`, `settleUnknownLabel`, `replaceKit`, `recalledAwaitingReplacement`, `ordersWithLabelProblems`, `boxUsage`, `returnLabelSpend`.
- Site admins: `refundShipping`, `decideRequest`, `settleRefund` (a refund left unanswered).
- The lab's portal users (and kit staff): `labsFor`, `labPortal`, `confirmBatchReceived`, `matchResults`, `receiveResult`.
- The person activating: `activateKit({ code, secret, subject })`, `markSampled({ code, confirmed? })`, or with Wizards `markSampled({ code, answers, locale? })`.
- The buyer or keeper: `customerReturnLabel({ code, extra? })`, `releaseForMail({ code })`, `resultView({ code })` (the keeper and staff only).
- The buyer: `helpOptions`, `requestHelp`, `chooseAfterMissed`, `chooseDropOff` (staff too).
- Kit staff, phase 4a: `seedKitStory`, `removeKitRecords`, `rateStudy`. `replaceKit` takes `damaged` when it's on.
- Server code only, with no access check: `assignKitUnits`, `kittingOnBuild` (Kitting's hook; `addBuiltKit` checks staff), `scanKinds`, `dropOffOffer`, `checkDropOff`, `noticeEventReturns`, `noticeDateChanged`, `noticePreorders`, `checkKitSale`, `startPreorder`, `refundOutboundFor`, `ensureSampleKitsIndexes`, `recordKitEvent`, `findKit`, `applyRecall`, `labelOrderInBackground(payload, orderId)` (call it when an order becomes packable; it never throws), `applyTrackerEvent`, `applyRefundEvent`, `cancelUnneededReturnLabels`, `retryKitNotices` (daily: sends shipment notices still owed).

If you run an action inside your own transaction, call `runAfterCommit(req)` after you commit, so its notices go out.

`@extantape/payload-plugin-sample-kits/testing` has `fakeAccess`, `fakeSubjects`, `fakeShipping`, `fakePayments`, `fakeResults`, `fakeEvents`, `fakeKitting` and `reqAs` for tests and dry runs. Don't use them in production.

## Pages

A Payload plugin can't add routes to a Next.js site, so the plugin gives you three things, and your site keeps thin routes that mount them with its own rules (sign-in, masquerade, CSRF and origin checks) in front:

- `@extantape/payload-plugin-sample-kits/server`: a server function for every page and form. Each is `(req, input)`, checks who's asking itself, and answers `{ ok: true, data }` with plain JSON, or `{ ok: false, error: { code, message } }` with the message in plain words and what to do next. It never throws to the page: anything unexpected is logged by the error's name only and answered with a general message.
- `@extantape/payload-plugin-sample-kits/pages`: the pages, as server components with no hooks. Each takes its server function's `result`, your server `actions`, and your slots.
- `@extantape/payload-plugin-sample-kits/client`: the interactive parts (`'use client'`): the scan station, the activation wizard, the lab's uploader, and the forms.

| Page | Path | Server functions | Page component |
| --- | --- | --- | --- |
| Kits home: stock, lots, pre-orders, kits due at events | `/kits` | `kitsHomePage`, `submitLot`, `submitReleasePreorders` | `KitsHomePage` |
| Scan: look up, receive, check in | `/kits/scan` | `scanLookup`, `scanReceive`, `scanCheckIn` | `ScanPage` |
| Orders to pack | `/kits/packing` | `packingPage` | `PackingPage` |
| Packing one order: scan kits in and out, the slip, labels, ship | `/kits/packing/[id]` | `packOrderPage`, `scanPack`, `scanUnpack`, `submitSlip`, `submitShip`, `submitOrderLabels`, `submitReturnLabels` | `PackOrderPage` |
| Returns and check-in: check-in, labels to reprint, problems, recall, replace | `/kits/returns` | `returnsPage`, `scanCheckIn`, `submitReprint`, `submitRecall`, `submitReplace` | `ReturnsPage` |
| Lab batches | `/kits/batches`, `/kits/batches/[id]` | `batchesPage`, `batchPage`, `submitNewBatch`, `scanBatch`, `scanUnbatch`, `submitShipBatch` | `BatchesPage`, `BatchPage` |
| The lab portal: batches, "arrived", result upload | `/lab` | `labPage`, `submitBatchReceived`, `previewResultFiles`, `submitResultFile` | `LabPage` |
| My tests: the person's orders and kits | `/my-tests` | `myTestsPage` | `MyTestsPage` |
| One kit: progress, dates, return label, result | `/my-tests/kits/[code]` | `myKitPage`, `getReturnLabel`, `submitReleaseForMail` | `MyKitPage` |
| One order: help, refunds, the missed pre-order date's choices | `/my-tests/orders/[id]` | `myOrderPage`, `submitHelp`, `submitMissedChoice` | `MyOrderPage` |
| Activation (menu route id `kit-activate`) | `/my-tests/activate` | `activatePage`, `submitActivation`, `submitSampled` | `ActivatePage`, `ActivationWizard` |

Who sees what:

- Staff pages need kit staff of the request's site; a record of another site gets the same "not found" as one that doesn't exist.
- A keeper's pages show only kits they bought or activated, and only their own orders. The buyer of a kit someone else activated sees its status, never the keeper or what they sampled; a keeper who got a kit as a gift never sees who bought it, the order, or what it was bought for.
- Someone else's kit gets exactly the same answer as a kit that doesn't exist, and someone else's order the same as a missing order.
- A result shows only to its keeper (and kit staff through `resultView`). The results provider isn't even asked for anyone else.
- The lab page shows kit codes, statuses and tests. Never a buyer, a keeper, an address, a subject or a result.
- Activation looks at a code before its secret is checked only to mark what the person themselves bought it for; any other code gets the plain list.

### Slots

Every slot has a plain default, so each page works on its own.

| Slot | Prop | Used by |
| --- | --- | --- |
| The page shell and menu | `Shell({ title, intro, nav, current, children })`; staff pages pass `STAFF_NAV` as `nav` | every page |
| The empty state | `Empty({ title, body, action })` | lists with nothing in them |
| The result card | `ResultCard({ code, result })`, with your `results.view` answer | `MyKitPage` |
| The subject picker (animal and group) | `SubjectPicker({ name, choices, legend, help, suggestedText, emptyText })`: a form control that submits `<kind>:<id>` under `name` | `ActivatePage` |
| The price, currency and tax line | `Price({ cents, kind, currency, locale })` | `MyOrderPage` (refund and kept-back amounts) |
| The ship-to address form | `orderSection`: your own "order kits" section, with your checkout, address form and price line | `MyTestsPage` |
| Wizards' `<Wizard>` | `Wizard` and `wizardSlots` on `ActivationWizard`, through your own client wrapper | activation |
| Scan's camera button | `Camera({ onCode })` on `ScanStation`, through your own client wrapper | scan stations |

A component can't be sent from the server to the browser, so the slots the browser needs (`Wizard`, `Camera`) go through a small `'use client'` file of yours. Elements can: the subject picker is rendered on the server with the page's choices.

Plugin text is English. Pass `t` (the same `i18n.t`) to a page to translate its words (`sampleKits.ui.<key>`; the keys are `UI_TEXT`). Dates are shown in UTC, in `locale` (default `en-US`).

### Result uploads by file id

Hosts cap a request body (Vercel at 4.5 MB) and base64 adds a third, so larger result files go straight to your private storage first. Give `results.verifyUpload({ fileId, req })`: it answers `{ fileId, name, size, type, sha256 }` for a file this request's person uploaded, or throws to refuse. Check there that the uploader is this person, the file is on this site and in private storage, it's recent and not used before, and its stored size, type and SHA-256. On top, the plugin checks the name, type and size again, matches the kit by the code in the file's name (it never sees the contents, so not by the FASTA header), refuses an id any kit's result already used (a unique index, made with the others), and gives `results.accept` the `fileId` with `data` and `text` null: your provider reads the stored file. With it, `submitResultFile` takes `{ lab, fileId }` and refuses bytes (`uploadById`); `labPage` says `upload.by: 'fileId'`. Without it, bytes go as base64 up to `results.maxBase64Bytes` (`uploadTooBig` past it, in plain words), and a file id is refused (`noUploadById`).

The browser side is yours too: pass `LabPage` an `Uploader` from a `'use client'` file that gives `LabUploader` your uploader, which stores one file and answers `{ fileId }`:

```tsx
'use client'
import { LabUploader, type LabUploaderProps } from '@extantape/payload-plugin-sample-kits/client'
import { uploadResultFile } from '@/lib/storage/client'

export const SiteLabUploader = (props: LabUploaderProps) => <LabUploader {...props} uploader={uploadResultFile} />
```

### A thin route on Next.js

```ts
// src/lib/kits/req.ts: a Payload request as the signed-in person, so scope.of(req) can tell the site.
import config from '@payload-config'
import { headers } from 'next/headers'
import { createLocalReq, getPayload } from 'payload'

export async function kitReq() {
  const payload = await getPayload({ config })
  const h = await headers()
  const { user } = await payload.auth({ headers: h })
  return createLocalReq({ user: user ?? undefined, req: { headers: h } as never }, payload)
}
```

```ts
// src/app/(frontend)/my-tests/actions.ts
'use server'
import { getReturnLabel } from '@extantape/payload-plugin-sample-kits/server'
import { kitReq } from '@/lib/kits/req'
import { checkOrigin, masqueradeBlock } from '@/lib/security'

export async function returnLabel(input: { code: string; extra?: boolean }) {
  const blocked = (await checkOrigin()) ?? (await masqueradeBlock())
  if (blocked) return { ok: false as const, error: { code: 'blocked', message: blocked } }
  return getReturnLabel(await kitReq(), input)
}
```

```tsx
// src/app/(frontend)/my-tests/kits/[code]/page.tsx
import { myKitPage } from '@extantape/payload-plugin-sample-kits/server'
import { MyKitPage } from '@extantape/payload-plugin-sample-kits/pages'
import { KitResultCard, SiteShell } from '@/components/kits'
import { kitReq } from '@/lib/kits/req'
import { returnLabel } from '../../actions'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const result = await myKitPage(await kitReq(), { code: decodeURIComponent(code) })
  return <MyKitPage result={result} actions={{ returnLabel }} Shell={SiteShell} ResultCard={KitResultCard} />
}
```

With Wizards, wrap the wizard once in a client file, and pass it to the page:

```tsx
// src/components/kits/GuidedActivation.tsx
'use client'
import { Wizard } from '@extantape/payload-plugin-wizards/client'
import { ActivationWizard, type ActivationWizardProps } from '@extantape/payload-plugin-sample-kits/client'

export const GuidedActivation = (props: ActivationWizardProps) => <ActivationWizard {...props} Wizard={Wizard} />
```

```tsx
// in /my-tests/activate/page.tsx, after activatePage(): const { slots } = await flowSteps(payload, { flow: 'kit-activation', locale })
<ActivatePage result={result} actions={{ activate, sampled }} wizard={result.ok ? <GuidedActivation data={result.data} actions={{ activate, sampled }} wizardSlots={slots} locale={locale} /> : undefined} />
```

The activation link carries the secret in its fragment (`#s=…`), which browsers never send to a server. The wizard reads it once, takes it off the address bar, keeps it in memory, and sends it once in the activation request's body. Nothing the components do writes to web storage or cookies.

## Limits

- Kitting's packing station and the Labels provider aren't here. The slip shows each kit's barcode, secret and link, but no QR code.
- The pages have only been rendered in jsdom. They haven't been seen in a real browser, on a phone, or with a screen reader.
- Without `results.verifyUpload`, result files go up one per request as base64, about a third larger than the file, and are refused past `results.maxBase64Bytes` (3 MB). Next.js limits a server action's body to 1 MB by default, so with the default 900 KB `results.maxBytes`, raise `serverActions.bodySizeLimit` to 2 MB or lower `maxBytes`. The uploader doesn't open zip files.
- With `results.verifyUpload`, the plugin never sees a file's contents: `results.check` isn't run, and files are matched by the code in their name only. Reading and checking the stored file is your `results.accept`'s job.
- A loser of a race (two activations, two label runs, two extra-label requests at once) is told `busy`: "Someone else just did this; refresh and check." A label purchase still `buying` after two minutes is treated as unknown, for staff to settle.
- Limiting how often someone can try a secret is your route's job (the site did it per address and per account); the server functions don't count attempts.
- The ship-to address form is yours: checkout stays in your site, so the plugin has no page with an address form. Pass your order section as `orderSection`.
- Staff pages show order ids, not buyer names: the plugin doesn't know your users' name fields.
- With Kitting wired, the database must have transactions (a MongoDB replica set). Without them, packing, unpacking, shipping, recalls and cancellations are refused.
- Kitting is tested through a stand-in with its shapes and codes; its own functions were only type-checked against the adapter.
- `seedKitStory` doesn't backdate records, upload results or buy labels. With Wizards wired, its samples are recorded as seeded, since the guided answers can't be made up. Your marker field must exist on the plugin's collections and your orders.
- The rate study's tier starts (`STUDY_TIER_STARTS`) are a starting point; pass your own.
- Sent as base64, result files are read whole, so that way suits small files like a FASTA (900 KB by default). Larger files need uploads by file id (`results.verifyUpload`) and your own storage.
- The plugin doesn't store result files: your `results.accept` does, inside the plugin's transaction.
- A refund the payment service never answers (the server stopped mid-way) holds that order's refunds until a site admin checks the service and settles it with `settleRefund`. A refund that throws anything but a clear refusal, or answers without an id, is recorded `unknown`: it frees the order but counts as paid back, so no other refund can pass what was paid, until a site admin settles it with `settleRefund` (with the refund's id, or null if it didn't go through). The fixed key keeps a retry of the same refund from refunding twice.
- Without `adapters.events.dateOf`, moved and canceled event dates aren't noticed; reminders and missed-date notices work from the date the buyer chose.
- Notices for event drop-off are marked as sent before `notify` is called, so a failed one isn't retried. A failed pre-order delay notice is tried again on the next daily run.
- A shipment notice that throws after it actually went out is sent again on the next try: a rare second copy, rather than a notice never sent. One left `sending` by a crash is tried again after ten minutes. Two problem statuses for one parcel (a failure, then returned to sender) give one problem notice.
- The keeper's "your sample arrived" goes once per kit, so a parcel of three kits gives three notices.
- With `ensureIndexes: 'manual'` the indexes must exist before Payload starts, and start-up refuses without them. Only MongoDB, for now.
- If you roll back your own transaction after a label purchase, the purchase record stays but the kits' trail and the order's link go; the next run links the label again. MongoDB ends a transaction after 60 seconds by default, so leave label runs to their own transactions where you can.
- The purchase record is written through Payload's database adapter directly, so collection hooks don't run for it.
- With Shipping, payments or `notify` wired, start-up makes unique partial indexes on `return-labels.slotKey`, `kit-refunds.claimKey` and `kit-notices.noticeKey` (or checks them, with `ensureIndexes: 'manual'`), and fails if it can't. Only MongoDB can, for now.
- There are no default prices: without valid tiers, `unitPrice` returns null and shipping falls back to what you pass (0 by default).
- `kitWeightOz` and `returnWeightOz` default to placeholders.
- Two order-label runs at once are kept apart by MongoDB's write conflicts inside the claim; tested on one in-memory replica set only.
- Which subject fields are the buyer's is yours to say (`subjects.buyerFields`). Leave it out and every subject field is the keeper's: a buyer then doesn't see through the API what they bought a kit for.
- With `select`, a reader who leaves out `buyer` or `activatedBy` gets none of that side's fields: the rule needs them to tell who's asking.
- `addBuiltKit` needs kit staff, so Kitting must call it with a staff request.
- The kit lists' tenant filtering in the admin is left to your multi-tenant plugin. The plugin scopes its own actions.
- Tested only on MongoDB.

## Commands

```sh
npm test           # Vitest on in-memory MongoDB
npm run typecheck
npm run build
npm run leak-check
```

## License

MIT. See `LICENSE`.
