# Promo-code redemption service

## Integration plan

The main Canary Yellow Applications website remains a static GitHub Pages site. The promo service
adds only two unlinked site routes:

- `/redeem/` — public claim-token validation and one-time redemption
- `/admin/promos/` — Google sign-in and server-authorized administration

The existing home page, navigation, footer, legal pages, assets, CNAME, and GitHub Pages deployment
remain unchanged. The browser pages call one Firebase HTTPS Function. Cloud Firestore is never read
or written directly by a browser.

```text
GitHub Pages
  /redeem/ -----------------------> Firebase HTTPS Function
  /admin/promos/ -- Google ID ----> Firebase HTTPS Function
                                         |
                                         v
                              Cloud Firestore transaction
                           claim + store code + redemption
```

## Security boundaries

- Firestore rules deny every client read and write, including authenticated clients.
- The public client can call only tightly controlled validation and redemption endpoints.
- The full claim-token record, not its parsed prefixes, authorizes redemption.
- Product, promotion, claim-token, inventory, and redemption mutations run only in the Function.
- The final assignment uses a Firestore transaction. A store code and claim token are changed in the
  same commit, so concurrent requests cannot produce duplicate assignments.
- Store-code values never appear in inventory-list responses, logs, URLs, local storage, session
  storage, analytics, or error messages.
- Admin requests require a verified Firebase Authentication ID token plus either a server-side email
  allowlist match or the `promoAdmin: true` custom claim.
- Validation, redemption, and import operations are rate limited in Firestore. Production requests
  use a secret pepper so client identifiers are not stored directly.
- Redemption responses use no-store cache headers. The page keeps the revealed code only in memory
  and in the current DOM until the page is dismissed or refreshed.
- App Check support is built in but should be enforced only after the web app and reCAPTCHA
  Enterprise key are configured and valid traffic has been observed.

## Firestore collections

### `products/{PREFIX}`

`prefix`, `name`, `supportedPlatforms`, `isActive`, `createdAt`, `updatedAt`

Product prefixes are document IDs and cannot be changed through the ordinary admin UI.

### `promotions/{PREFIX}`

`prefix`, `name`, `isActive`, `createdAt`, `updatedAt`

Promotion prefixes are document IDs and cannot be changed through the ordinary admin UI.

### `claimTokens/{CANONICAL_TOKEN}`

`token`, `productPrefix`, `promotionPrefix`, `status`, `redeemedAt`, `selectedPlatform`,
`assignedStoreCodeId`, `disabledReason`, `importedAt`, `updatedAt`

Statuses: `available`, `redeemed`, `disabled`.

### `storeCodes/{SHA256_FINGERPRINT}`

`code`, `codeFingerprint`, `productPrefix`, `platform`, `expirationDate`, `expirationDateSort`,
`status`, `assignedClaimToken`, `assignedAt`, `importedAt`, `updatedAt`

Statuses: `available`, `assigned`, `disabled`, `expired`. A missing expiration date is represented by
a far-future sort timestamp so the transaction can select the earliest eligible expiration safely.

### `redemptions/{CANONICAL_TOKEN}`

`claimToken`, product and promotion names/prefixes, `platform`, `redeemedAt`,
`assignedStoreCodeId`, and a masked display value. The complete code is not duplicated here.

### `auditEvents/{AUTO_ID}`

Administrative imports, disables, re-enables, authorization-safe assignment metadata, and successful
redemptions. Complete store-code values and request bodies are never logged.

### `rateLimits/{HASH}`

Hashed rate-limit subject, window end, and request count. These documents can be retained or cleaned
up periodically; automatic Firestore TTL deletion is billable and is not enabled by default.

## Firebase project setup

Use a dedicated Firebase project for this service. A separate project keeps its data, billing,
Authentication users, and operational permissions isolated from the app fleet.

1. Create the Firebase project and link a billing account so Cloud Functions can deploy. Select a
   Firestore location close to the Function region (`us-west1`) and create a Native-mode database.
2. In Firebase Authentication, enable the Google provider. Add
   `canaryyellowapplications.com` and `www.canaryyellowapplications.com` as authorized domains.
3. Register a Firebase Web app for `canaryyellowapplications.com`.
4. Add the project to the local CLI configuration with `firebase use --add`.
5. Copy `functions/.env.example` to `functions/.env.<project-id>` and replace the authorized admin
   email. Multiple email addresses are comma-separated.
6. Create the rate-limit pepper secret:

   ```sh
   openssl rand -hex 32 | firebase functions:secrets:set PROMO_RATE_LIMIT_PEPPER --data-file=-
   ```

7. Replace the placeholders in `scripts/promo-config.js` with the public Web app configuration and
   the deployed Function project ID. Firebase Web configuration values are identifiers, not secrets.
8. Deploy the backend only:

   ```sh
   firebase deploy --only firestore:rules,firestore:indexes,functions:promoApi
   ```

9. Test admin sign-in, create products and promotions, preview small imports, and complete a test
   redemption before importing production inventory.
10. Commit and push the static route and configuration changes to GitHub so GitHub Pages publishes
    them through the existing workflow.

The Function is intentionally limited to ten instances, has application-level rate limits, and does
not set a minimum warm-instance count. Configure Cloud Billing budget alerts as an additional
operational safeguard; alerts notify but do not impose a hard spending cap.

## App Check rollout

The public and admin clients support Firebase App Check with reCAPTCHA Enterprise.

1. Register the Web app in Firebase App Check and create a reCAPTCHA Enterprise site key for the
   production domains.
   Grant the deployed Function service account the Firebase App Check Token Verifier role when
   enabling limited-use token consumption.
2. Set `appCheckSiteKey` in `scripts/promo-config.js`.
3. Deploy with `PROMO_REQUIRE_APP_CHECK=false` first and confirm legitimate requests receive tokens.
4. Change the project environment value to `true` and redeploy the Function.

Redemption requests use limited-use tokens and the backend consumes them to add replay protection.

## Claim-token imports

Plain text accepts one token per line:

```text
CYA-SSM-FREE-7X4M9Q2K
CYA-SSM-FREE-P8K3W7RQ
```

CSV requires a `token` column:

```csv
token
CYA-SSM-FREE-7X4M9Q2K
CYA-SSM-FREE-P8K3W7RQ
```

Imports normalize capitalization and spaces, validate the `CYA` issuer and canonical structure,
confirm product/promotion prefixes, and reject duplicates before an explicit confirmation.

## Store-code imports

Plain text accepts one code per line. CSV requires a `code` column and may supply an
`expirationDate` column:

```csv
code,expirationDate
APPLECODE123,2026-09-30
APPLECODE456,2026-09-30
```

The selected product, platform, and expiration date are defaults. Valid CSV row values can override
those defaults. Date-only expirations are treated as 23:59:59.999 UTC on the selected date.

## Local development and tests

Install backend dependencies from `functions/`, then run:

```sh
npm test
npm run check
npm run test:emulator
```

The emulator suite requires Java 21 or newer. It tests Firestore client denial, simultaneous claims
against one code, simultaneous requests for one claim, and transactional rollback. On a Homebrew
installation where Java 21 is not the default, run the emulator command with
`JAVA_HOME=/opt/homebrew/opt/openjdk@21`.

For full local UI testing, start the Firebase emulators and serve the repository root from a local
static web server whose origin is included in `PROMO_ALLOWED_ORIGINS`. Use only test codes and test
claim tokens in an emulator database.

## Deployment and operations

- GitHub Pages continues to deploy the static site. Firebase deploys only Functions, Firestore rules,
  and Firestore indexes; `firebase.json` deliberately contains no Firebase Hosting configuration.
- Do not add `/redeem/` or `/admin/promos/` to navigation, the footer, the home page, or a sitemap.
- Monitor Function error categories and Firestore usage without logging request bodies or codes.
- Export Firestore to a restricted Cloud Storage bucket before large imports and on a regular
  operational schedule. Firestore exports, scheduled backups, point-in-time recovery, and backup
  storage can incur charges; configure retention deliberately and test restoration separately.
- Retain redeemed claims, assigned codes, redemptions, and audit events. Do not reset or delete them
  through ordinary operations.

## Strict one-time display

The final `/redeem` request is the only response that contains the assigned store-code string. The
claim is marked redeemed and the code assigned atomically before that response is returned. Every
later request sees only the redeemed state and cannot retrieve or replace the code.

> Under strict one-time display, an assigned store promo code cannot be recovered through the public
> redemption flow after the successful response is dismissed or refreshed.

The admin interface also shows only masked code inventory. Exceptional recovery is intentionally not
implemented in this version.

## Known operational limitations

- The public flow has no recovery mechanism by design.
- Inventory imports are capped at 400 rows per operation to remain within Firestore transaction
  limits. Larger files must be divided and previewed separately.
- Admin list views return the most recent 200 records unless an exact token or exact store code is
  searched.
- App Check enforcement is opt-in during rollout so an incorrect site-key configuration does not
  lock out legitimate users.
- The backend dependency tree currently reports transitive npm advisories in Google-maintained
  packages even at the latest available Firebase Admin versions. The affected buffer/glob APIs are
  not called with user-controlled values by this service; re-run `npm audit` during routine updates
  and adopt upstream fixes when released.
