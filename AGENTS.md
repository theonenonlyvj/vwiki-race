# AGENTS.md - VWiki Race

This project is intended to become a public GitHub repository. Treat it as
public unless Vijay explicitly says otherwise.

## Local Rules

- Do not copy private material from other projects into
  this repo.
- Do not add a remote, push, publish, deploy, or upload anything unless Vijay
  explicitly asks.
- In this repo, `ship it` means verify, review, commit, and release the change.
  Check the production D1 migration ledger without replaying applied migrations.
  If Worker code changes, deploy and smoke-test the Worker before its client.
  Push `main`, then explicitly deploy the built Pages frontend with
  `npx wrangler pages deploy dist --project-name vwikirace --branch main`.
  Git push alone does not deploy Pages. Verify the live bundle afterward.
- Keep early product thinking in `docs/` until an implementation direction is
  approved.
- If using Wikipedia or Wikimedia APIs, preserve attribution, follow Wikimedia
  API usage rules, and avoid high-volume scraping.
- Before implementation work, use the workspace Superpowers workflow for
  brainstorming, planning, TDD, verification, and review when available.
