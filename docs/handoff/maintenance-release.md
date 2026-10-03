# Maintenance release

This receipt supersedes the release status and credential assumptions in older
handoffs. Historical product decisions and rollback receipts remain useful.

## Shipped cleanup

- Removed tracked `.env.production`; production builds use same-origin APIs
  unless an operator explicitly sets the documented rollback override.
- Corrected explicit Pages deployment instructions and engine-neutral ownership.
- Replaced machine-specific paths and removed named account-operation records
  from public maintenance documentation.
- No rules, identity contract, daily selection behavior, or database schema changed.
- Git history was not rewritten for this repository.

The initial maintenance commit is `bbcfef8`. Its Pages deployment is `f6fb41e6`
and live entry bundle is `index-Br8jXPmX.js`. The API Worker was unchanged.
Browser smoke on the production site confirmed the bundle, challenge navigation,
no uncaught page errors, and no horizontal overflow at a mobile viewport.

## Focused dependency follow-through

A separate lockfile update patches the production-audit findings in Nano ID,
PostCSS, Browserslist, and baseline-browser-mapping, with only the latter's
browser-data dependencies moving alongside them. Manifest ranges, application
source, Cloudflare tooling, and Vitest versions are unchanged.

Advisory evidence:

- https://github.com/advisories/GHSA-2v37-7h3g-55p8
- https://github.com/advisories/GHSA-fxqj-rqcc-2cmp
- https://github.com/advisories/GHSA-c83g-rgw3-j3cx
- https://github.com/advisories/GHSA-w5vr-8v7q-w6rv

Verification: clean install, production-only audit, client tests, Worker tests,
production build, and bundle verification pass. The broader development-only
Cloudflare/Vitest audit findings remain separate dependency work; do not run
an unreviewed forced downgrade to clear them.

## Investigation results and next work

The read-only health comparison ran against the existing private baseline.
Raw records and account identifiers remain in ignored private artifacts.
Duplicate-account candidates are signals for investigation, not authorization
to merge accounts or a finding that prior consolidation failed.

Daily path generation is best effort: a missing reference path is allowed,
and later hops use Wikipedia link APIs rather than proving each rendered,
sanitized navigation step. Existing difficulty floors are not a solvability
proof. Sanitizer-verified path gating remains a product follow-up. Automatic
hot swaps and scheduled reporting remain disabled unless requested.
