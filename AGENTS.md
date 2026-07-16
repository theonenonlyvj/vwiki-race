# AGENTS.md - VWiki Race

This project is intended to become a public GitHub repository. Treat it as
public unless Vijay explicitly says otherwise.

## Local Rules

- Do not copy private material from other `/Users/vijayram/Cursor` projects into
  this repo.
- Do not add a remote, push, publish, deploy, or upload anything unless Vijay
  explicitly asks.
- In this repo, Vijay's instruction `ship it` explicitly means: finish and
  verify the change, commit it locally, verify the production D1 migration
  ledger, deploy and smoke-test the API Worker, then push `main` / allow the
  Pages frontend to deploy, and run production smoke checks. Do not push first
  when Git-connected Pages auto-deployment could reverse Worker-before-Pages.
- Keep early product thinking in `docs/` until an implementation direction is
  approved.
- If using Wikipedia or Wikimedia APIs, preserve attribution, follow Wikimedia
  API usage rules, and avoid high-volume scraping.
- Before implementation work, use the workspace Superpowers workflow for
  brainstorming, planning, TDD, verification, and review when available.
