# Releasing

This plugin is distributed through Claude Code's plugin/marketplace system, which changes
what "a release" means in one important way (read the first section before anything else).

## The rule that bites: bump or the install goes stale

Claude Code installs a **cached snapshot** of the plugin (under
`~/.claude/plugins/cache/grok/grok/<version>/`) and registers its hooks from that snapshot
**at session start** — it does *not* run your working tree, even when the marketplace source
is a local directory. Two consequences:

- **`/plugin update` is version-gated.** If the version string hasn't changed, the update
  no-ops and the user keeps running the old snapshot. A `0.1.0 → 0.1.0` "update" does nothing.
- **Any change to the installed surface must bump the version** — commands, hooks, agents,
  skills, prompts, schemas, or the companion/runtime code under `plugins/grok/scripts/`.
  Otherwise consumers cannot receive it. (Repo-only changes — tests, docs, this file,
  `scripts/` dev tooling — do not need a bump; they can sit under `[Unreleased]`.)

After a release, consumers pick it up with `/plugin` update, then **`/reload-plugins`**, which
re-registers hooks live without a full session restart.

## Versioning policy (SemVer, pre-1.0)

Version lives in four places, kept in lockstep (a `node --test` case fails on drift):
`package.json`, `plugins/grok/.claude-plugin/plugin.json`, and both `version` fields in
`.claude-plugin/marketplace.json`.

While at `0.x`:

- **minor** (`0.x.0`) — new user-facing surface (a command, hook, skill, agent) or a behavior
  change to existing surface. Phase 1 → Phase 2 was `0.1.0 → 0.2.0`.
- **patch** (`0.x.y`) — bug fixes and internal changes to the runtime that ship to users
  without changing the surface. Still requires a bump so the fix actually reaches installs.
- **major** (`1.0.0`) — reserved for the first stable release.

Post-1.0, apply standard SemVer (breaking → major).

## Release checklist

1. `npm test` is green (includes the version-lockstep + changelog-entry checks).
2. `scripts/bump-version.sh <major|minor|patch>` — bumps all four version strings and rolls
   the `[Unreleased]` changelog section into a dated release heading.
3. Edit `CHANGELOG.md`: make sure the new version's `Added`/`Changed`/`Fixed` notes are
   accurate, and start a fresh empty `[Unreleased]` if the script left one.
4. `npm test` again (the changelog-entry check now requires a section for the new version).
5. Commit: `git commit -am "Release X.Y.Z"`.
6. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
7. Push: `git push --follow-tags`.
8. Verify the install refreshes: in a session, `/plugin` update → `/reload-plugins`, then
   confirm `~/.claude/plugins/cache/grok/grok/X.Y.Z/hooks/hooks.json` exists and lists the
   expected hooks. `scripts/phase2-live-smoke.sh` runs the behavioral regression pass.
