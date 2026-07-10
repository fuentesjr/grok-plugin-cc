# ACP sandbox/cancel spike (2026-07-09, grok 0.2.93)

Working ACP-over-stdio probes that produced the verified findings in
`implementation-notes.md` ("Verified by live ACP spike"). Kept as a reference
skeleton for `scripts/lib/acp-client.mjs` and the fake-grok fixture.

- `spike-acp.mjs` — handshake probe: `initialize` + `session/new`, optional
  `_meta.agentProfile` (JSON object or name). Showed the profile requires
  `name`/`description`/`prompt` and that a malformed profile silently falls
  back to the default agent.
- `spike-prompt.mjs` — live-turn probe: write-attempt under a restriction
  (proves/disproves enforcement) or a slow turn plus `session/cancel`.
  The write-probe workdir must be outside temp dirs — `read-only` permits
  temp-dir writes, which invalidated the first run.

Caution: `--debug-file` output includes the OAuth bearer token; delete logs
after use. Live probes each burn a small real model turn.
