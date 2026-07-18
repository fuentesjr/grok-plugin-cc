# Project tracker (superseded)

Work tracking moved to `.trk/` (STATE.md + LOG.md), written through the `trk`
CLI — see the routing rules in `AGENTS.md`. Fresh sessions resume via
`trk status --json`, not this file.

Recovery of pre-migration chronology:

```sh
git log -- PROJECT_TRACKER.md
git show HEAD~1:PROJECT_TRACKER.md   # last full tracker before migration
```
