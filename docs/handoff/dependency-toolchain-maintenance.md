# Dependency toolchain maintenance

The testing toolchain stays on Vitest 4 and the compatible Cloudflare pool
0.18 patch series. Wrangler stays on the matching 4.114 series instead of
introducing a new Miniflare major or prerelease runtime for an audit fix.

Miniflare still pins vulnerable transitive versions, so `package.json`
temporarily overrides only its Sharp and Undici dependencies. The security
floors are Sharp 0.35.5 and Undici 7.29.1. Remove these overrides once a
compatible upstream Cloudflare release includes patched versions natively,
then rerun the complete gates.

Primary advisories:

- [Vitest mocker path traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
- [Sharp's librsvg dependency](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)
- [Undici TLS option handling](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3)

The Sharp vendor advisory was newer than the finding returned by the npm
audit endpoint. An empty audit is a check, not a guarantee that every vendor
advisory has reached its database.

Verify with a clean `npm ci`, `npm ls`, the client and Worker suites,
production build/bundle check, full `npm audit`, and the Worker packaging
dry run. No database migration or production deployment is needed solely
for this development-dependency update.
