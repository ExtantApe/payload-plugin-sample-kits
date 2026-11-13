# 0001: Sample Kits design record

Status: **accepted direction, details open** (2026-11-10). Nothing is built.

## Context

The first site sells genetic sample kits for reptiles. Its kit code (about 13,000 lines in the site, 8 collections,
11 integration test files) runs the whole life of a kit:
- an order is placed;
- the kits are packed and shipped;
- the keeper activates a kit with a secret, takes a sample and returns it;
- the hub checks it in, and the lab batches it and uploads the result;
- the keeper sees the result.

The owner decided on 2026-11-10 to make that a plugin, named Sample Kits, and to order the work by need, not by a
launch date. The standing rule behind it (owner, 2026-11-10): plugins stand alone and don't depend on each other, they
work together through optional adapters, and each is built with the best architecture first.

The assessment that led here is in the site's own repo.

## Decision

`@extantape/payload-plugin-sample-kits` owns the general life of a sample kit. A site plugs in what's specific to
it through **providers**: what is sampled, what a result is, how kits are paid for, its policies, its tenancy, its
messages. The plugin never imports Stripe, a results engine, the site's animals, or any other plugin of ours. Its
links to Kitting, Labels, Scan, Wizards, Shipping, Notifications, Events and Seed are optional adapters.

MIT, as a general Payload plugin. Public from its first push, after the first-public-push audit. The owner
approves making the repo public. 0.x until it
has seen real use.

**Out of scope: human medical or diagnostic testing** (HIPAA, CLIA, clinical consent). The README says so, and nothing
is shaped for patients.

## What the plugin owns

**Collections.** Same slugs and field names as the site today, so switching the site needs no database migration:

| Slug | What |
|---|---|
| `kit-lots` | a manufacturer's lot: number, use-by date, recall (sets kits aside, takes packed kits out of unshipped orders) |
| `kits` | one kit: code, status (only through events), order, box, hub, lab batch, secret hash, subject (opaque reference), suggested subject, result summary |
| `kit-events` | the custody trail: every status change, who, when, and what was confirmed (the guided steps' answers) |
| `box-types` | shipping boxes: size, weight, carrier rules, `packagingRecipeKey` for Kitting |
| `hubs` | where returns go: an address (database only), staff, and for events, drop-off |
| `labs` | the labs and who may use their portal |
| `lab-batches` | kits sent together to a lab, received, results uploaded |
| `return-labels` | prepaid return labels: bought, used, stale, canceled, refunded |

**Fields on the site's collections**, by slug option, with the same names as today:
- On orders (`orders`): the kit lines and `kitFulfillment` (labels, box plan, returns, drop-off).
- On products (`products`): `kit` (kit type, price tiers, shipping tiers, pre-order).

**The life of a kit** (today's `src/lib/kits`, moved behind providers):

| Area | Today's site module(s) |
|---|---|
| Codes, secrets, activation links | `codes`, `barcode` |
| Statuses and the custody trail | `status`, `kits` (`recordKitEvent`) |
| Lots, recall, replacement | `kits`, `problems` |
| Receiving built kits | `kits` (`addBuiltKit`, `receiveKit`) |
| Packing and slips (until the station) | `kits` (`packKit`, `unpackKit`, `makeSlip`), `packing` |
| Shipping, then the shipped email via notify | `kits` (`markShipped`) |
| Activation (always with the secret) and sampling | `kits` (`activateKit`, `markSampled`) |
| Returns: prepaid labels, refunds on unused ones, stale labels, reprint | `returns`, `refundShipping`, `canRefundShipping` |
| Drop-off at events, via the events adapter | `eventReturns` |
| Hub check-in, labs, batches | `lab` |
| Result upload: file checks, checksum, matching to kits | `results` (the meaning goes to the results provider) |
| Order help: missed, damaged, refund requests | `orderHelp`, `helpWords` |
| Shipping labels at order time, box plan, carrier rules, tracking | `orderLabels`, `shipmentPlan`, `boxLadder`, `tracking` |
| Price tiers and shipping tiers | `pricing` |
| Pre-orders: release, delay notices | `kits` (`releasePreorders`), `preorderNotices`, `terms` |
| Rate study (a script, through the shipping adapter) | `rateStudy` |
| Kitting link and Kitting's rates | `kittingLink`, `shippingProvider` |
| Demo data, bulk removal, via the seed adapter | `seed`, `seedLight`, `seedSandbox` |

**What stays in the site** (the first site's implementation):
- the subject provider: animals and groups, which species are open for kits (`availability`), the group's name on
  labels (`format`);
- the results provider: OnePhylogeny's `registerSequence`, the genealogist's review, the lineage card (the site's half of
  `results`, `demoSequence`);
- the payments provider: checkout and Stripe (`checkout`, `kitOrderExtras`), test credits and contributions toward
  them (`agency`, `toward`), Stripe refunds;
- pre-order votes on the Roadmap;
- the policies and wording: `sellable`, the support address, the store's time zone, the safety steps' text and video.

## Providers

The shapes below are sketches, made exact when the code is written. Every call gets `{ req }` and runs inside the
caller's transaction.

```ts
sampleKits({
  collections: { orders: 'orders', products: 'products' },        // slugs of the site's collections to add fields to
  scope: {                                                         // tenancy, or omit on a single-site install
    field: 'tenant',
    of: (req) => TenantId | null,
    isKitStaff: (req) => Promise<boolean>,                         // packing, hubs, recall
    isLabUser: (req, lab) => Promise<boolean>,
  },
  subjects: {
    kinds: ['animal', 'group'],                                    // what a kit can be for
    choices: ({ user, kit, req }) => Promise<Subject[]>,           // what activation offers, the suggestion first
    label: ({ ref, req }) => Promise<string>,                      // "Kinixys | Group #1" on labels; never a person
    canSample: ({ user, ref, kit, req }) => Promise<true | Refusal>,
    canSell: ({ product, ref, req }) => Promise<true | Refusal>,   // species open for kits
  },
  results: {
    accept: ({ kit, file, req }) => Promise<{ status: 'ready' | 'review' | 'failed'; summary?: string }>,
    view: ({ kit, user, req }) => Promise<ResultView | null>,     // null for anyone but the keeper and staff
  },
  payments: {
    refund: ({ order, amountCents, reason, req }) => Promise<RefundRecord>,
    creditBack: ({ kit, reason, req }) => Promise<void>,           // after the last free retest fails
    orderKits: ({ order, req }) => KitLine[],                      // what the order paid for
  },
  shipping: ShippingAdapter,                                       // from Shipping (payload-plugin-shipping, EasyPost first), or a fake in tests
  policy: {
    freeRetests: 1,
    afterLastRetest: 'credit' | 'none',
    returnWithinDays: 30,
    storeTimeZone: 'America/Phoenix',
    supportEmail: string,
  },
  notify: ({ kind, to, data, req }) => Promise<void>,              // the site's notifications and email, after commit
  i18n: { t: (key, vars) => string },                              // the plugin ships English; the site translates
  adapters: { kitting?, labels?, scan?, guidedSteps?, events?, seed? },
})
```

**Fixed, not configurable:** activation needs the kit's secret. A code alone, or a code given as its own secret, never
activates a kit (owner, 2026-11-10). It's enforced in `activateKit` and tested.

## Pages and server actions

A Payload plugin can add admin views and endpoints, but it can't add Next.js routes to a site's app. So the plugin
exports:
- **server functions:** the actions, each checking access and returning plain results;
- **React components:** server and client, for every page.

The site keeps thin route files that mount them and wrap each action with its own rules (on the first site,
`masqueradeBlock()` and the CSRF and origin checks). The paths stay where they are:
- `/kits/*` for staff, `/lab` for the lab portal, `/my-tests/*` for keepers;
- the activation wizard at `/my-tests/activate`, under the menu route id `kit-activate`, as agreed with Platform.

The scan links (`…/k/<code>`, `…/b/<box>`) are registered with the Scan plugin when it's present. What a scan opens is
decided on the server from who's signed in:
- kit staff see the record;
- the buyer lands in activation;
- signed-in staff see "Not found" for a code that doesn't exist;
- anyone else sees "Sign in", whether the code is unknown or forbidden.

## Agreed with other plugins

Names approved by the owner on 2026-11-10: Scan, Wizards (the gated guided steps),
Shipping (carriers and labels, EasyPost first), Notifications, Labels.

- **Shipping** (`payload-plugin-shipping`): quotes, label buying, refunds of unused labels, tracking webhooks and
  address checks move there from today's `easypost`, `fakeEasyPost`, `address`, `trackerWebhook` and the parcel rules in
  `boxLadder`. Sample Kits keeps what's about kits: the kit boxes, the box plan by label cost, labels at order time,
  return labels and their records, and its tracker and refund handlers. Shape: `payload-plugin-shipping`
  `docs/architecture/0001-design.md`.
- **Notifications** (`payload-plugin-notifications`): `notify` can be wired to it by the site; Sample Kits doesn't
  import it.

- **Kitting's packing station** (`payload-plugin-kitting` `docs/station-design.md`, e0875b0). Sample Kits provides
  `canOpen`, `boxPlan`, `addItem`, `removeItem`, an idempotent `afterAllScanned`, `printSets` and `onShipped`. It
  registers at `config.custom.kitting.station`.
- **Kitting's units:** `onBuild` → `addBuiltKit`, `assignTo`, `swapUnit`, `release`, `shipUnits`, and `voidRecalled` on
  recall. These are today's `kittingLink`, moved to the adapter.
- **Labels:** `config.custom.labels.providers.kits` provides templates (kit bag 4 × 6, kit box, shipping box, lab
  batch), sets, and `{{kits.*}}` tokens read as the person printing.
- **Scan** (`payload-plugin-scan`) and **Wizards** (`payload-plugin-wizards`, collection `guided-steps`):
  names agreed with Platform. Activation is a guided flow whose steps call `activateKit` and `markSampled`, and the
  answers are recorded on the kit's event.

## Switching the site (one PR, when the kits work comes up)

1. The plugin is released at 0.x and installed at an exact version (the site installs its plugins from npm like anyone
   else).
2. One PR, in this order:
   - the site's providers are added;
   - `src/lib/kits` is reduced to the site's own half;
   - the collections are removed from the site and come from the plugin with the same slugs and fields;
   - the routes mount the plugin's components.
3. Checks before merge:
   - a schema and index comparison before and after, on a throwaway copy of test's data;
   - every existing kit integration test, unchanged;
   - the full regression;
   - Stage 8 run again on test (order to lineage card, with made-up people);
   - A security review of the plugin.
4. Kits goes on prod with kit sales, at the site's planned freeze point for kit sales.

## Tests in this repo

The same harness as Kitting: Vitest, Payload 3 on `mongodb-memory-server`, one file at a time. They run with fake
providers (subject, results, payments, shipping) so nothing needs the site. Always covered:
- access: who sees and changes what, with refusals, including tenancy;
- the secret rule;
- money: refunds, unused labels, credit-back;
- no leaks of a person, address or result to strangers;
- recall;
- transactions rolling back when a provider throws.

## Agreed with Platform (2026-11-10)

- **Events drop-off:**
  - The plugin takes `adapters.events.dropOffChoices({ tenant, country, postalCode, now, req })`, which returns
    `DropOffChoice[]` (`{ dateId, eventName, eventSlug, starts, timezone, place, miles? }`).
  - The plugin exports `noticeDateChanged({ dateId, req })` for the events side to call.
  - The type lives here, since this plugin is the consumer. Events knows nothing of it: the site's adapter maps event
    dates onto it and wires both.
  - `miles` is optional, so a site without geocoding still works.
- **Pages:**
  - The plugin owns the server functions and components. The site keeps thin routes, `masqueradeBlock()` and the origin
    checks.
  - **Site slots:** the result card, the subject picker (animal and group), the page shell and menu, the empty state,
    the ship-to address form (its country rules), and the price, currency and tax line.
  - **Plugin UI:** the scan flows, the lab queue, and the rest of the staff and keeper pages. The packing station
    itself is Kitting's.
- **Pre-orders:**
  - In this plugin: release, delay notices, and the promised-by and terms dates.
  - Votes stay in the site, through `onPreorderVote({ order, item, req })`.
  - `subjects.canSell` replaces the site's species check.
  - Pre-orders aren't part of the payments provider, which only takes money.

## Open

- **Seed:** the seed adapter's shape, proposed to the seed plugin's maintainers on 2026-11-10:
  - `seedKitStory(payload, { scope, people, track?, mark?, req })` and `removeKitRecords(payload, { ids, req })`;
  - the marker and the track callback passed in as plain arguments;
  - stand-in ids `seed_pi_<16 digits>`.
