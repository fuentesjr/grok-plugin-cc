# Architecture

Visual companion to the README's [How it works](../README.md#how-it-works). Terms follow [CONTEXT.md](../CONTEXT.md). Sources of truth are cited per diagram; if a diagram and the code disagree, the code wins — fix the diagram.

## Component map

Where each piece lives and what talks to what.

```mermaid
flowchart LR
    subgraph claude["Claude Code session"]
        cmds["/grok:* commands"]
        rescue["grok-rescue subagent"]
        hooks["hooks: SessionStart / SessionEnd / Stop"]
    end

    subgraph companion["grok-companion.mjs (CLI, per invocation)"]
        sub["subcommands: setup · review · adversarial-review · task · status · result · cancel"]
        acp["GrokAcpClient.connect"]
    end

    subgraph broker["Broker (acp-broker.mjs, one per workspace)"]
        route["session router + per-job budget timer"]
        ro["read-only child<br/>grok --sandbox read-only"]
        ws["workspace child (lazy)<br/>grok --sandbox workspace"]
    end

    subgraph state["State dir (GROK_COMPANION_DATA_DIR/state/&lt;slug-hash&gt;)"]
        sj["state.json — config, job index, last task session"]
        jf["jobs/&lt;id&gt;.json + &lt;id&gt;.log"]
        bj["broker.json — endpoint, pid"]
    end

    cmds --> sub
    rescue --> sub
    hooks -->|"Stop"| stopgate["stop-review-gate-hook.mjs"]
    stopgate -->|"spawns stop-review-task"| sub
    hooks -->|"SessionEnd: broker/shutdown + kill session jobs"| route
    sub --> acp
    acp -->|"JSON-RPC over unix socket"| route
    acp -.->|"fallback: direct grok spawn<br/>(broker busy, or --model/--effort)"| direct["grok agent stdio (direct child)"]
    route --> ro
    route --> ws
    sub --> sj
    sub --> jf
    acp --> bj
```

Notes, from `acp-client.mjs` (`GrokAcpClient.connect`) and `session-lifecycle-hook.mjs`:

- The Broker is the default path, but not the only one. `--model` or `--effort` forces a **direct** `grok` spawn (sandbox profile still applies), and a busy/unreachable Broker falls back to a direct spawn unless `brokerFallback` is disabled (the stop-review gate disables it so it can detect "busy" instead).
- The Broker is single-flight: one request socket at a time; concurrent callers get a `broker busy` RPC error.
- Broker clients verify `_meta.broker: "grok-companion"` during `initialize`. A foreign persisted endpoint is discarded and the current request falls back to a direct Grok child.
- `SessionEnd` sends `broker/shutdown` only after the same identity check, kills this session's queued/running job processes, and removes their records.
- `SessionStart` copies Claude's plugin-scoped data path into `GROK_COMPANION_DATA_DIR`; exporting a Grok-specific name prevents another plugin's hook from redirecting Grok state.

## Job dispatch sequence

The full path of a foreground `/grok:rescue` (a `task` Job). Reviews follow the same path with the read-only child and a review prompt. Source: `grok-companion.mjs` (`handleTask`/`executeTaskRun`), `acp-broker.mjs` (`routeRequest`), `tracked-jobs.mjs` (`runTrackedJob`).

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant GC as grok-companion.mjs
    participant ST as State dir
    participant BR as Broker
    participant GK as grok child (ACP)

    CC->>GC: task [--write] [--background] <prompt>
    GC->>ST: job record → status: running, pid, log file
    GC->>BR: connect (spawn Broker first if no live endpoint)
    Note over BR,GK: read-only child spawned at Broker start,<br/>workspace child spawned lazily on first --write job
    GC->>BR: session/new (_meta: access, budgetMs)
    BR->>GK: session/new (+ standing rules merged into _meta.rules)
    GK-->>BR: sessionId
    BR-->>GC: sessionId (Broker records owner socket + budget)
    GC->>BR: session/prompt
    BR->>GK: session/prompt (budget timer armed)
    loop streamed turn
        GK-->>BR: session/update notifications
        BR-->>GC: routed to owning socket
        GC->>ST: progress → job log + phase/threadId patches
    end
    alt budget expires - default 20 min then wind-down handoff
        BR->>GK: session/cancel
        GK-->>BR: result marked brokerBudgetExpired
        Note over GC: short wind-down handoff turn under grace budget
        GC->>BR: session/prompt handoff
        BR->>GK: session/prompt
        GK-->>GC: handoff message
    end
    GK-->>BR: final result
    BR-->>GC: final result
    GC->>ST: job → completed / failed, result payload stored
    GC-->>CC: rendered result (or JSON)
```

Background variant (`--background`): `handleTask` writes a `queued` job record, spawns a detached `task-worker` process, and returns immediately; the worker re-reads the stored request and runs the same `executeTaskRun` path. Write jobs additionally require a clean working tree before queueing.

## Job lifecycle

States are the `status` field on job records; every transition is written to both `state.json` and `jobs/<id>.json`. Source: `tracked-jobs.mjs` (`runTrackedJob`), `grok-companion.mjs` (`enqueueBackgroundTask`, `handleCancel`), `session-lifecycle-hook.mjs` (`cleanupSessionJobs`).

```mermaid
stateDiagram-v2
    [*] --> queued: --background dispatch
    [*] --> running: foreground dispatch
    queued --> running: detached task-worker starts
    running --> completed: turn finished, exit status 0
    running --> failed: nonzero exit, error thrown,<br/>or budget-expired turn
    queued --> cancelled: /grok:cancel
    running --> cancelled: /grok:cancel — session/cancel<br/>+ kill worker process tree
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

How the commands relate to states:

- `/grok:status` reads all states; `--wait` polls until the job leaves `queued`/`running`.
- `/grok:result` only resolves `completed`/`failed`/`cancelled` jobs; an active job is an error.
- `/grok:cancel` only accepts `queued`/`running` jobs.
- `SessionEnd` kills and deletes this session's `queued`/`running` jobs outright (no `cancelled` record survives — the records are removed).
- Jobs also carry a finer-grained `phase` (starting → investigating/reviewing/editing/verifying → finalizing → done) used only for status display; `status` is the state machine.

## Stop-review gate decision flow

What happens on every `Stop` hook fire when deciding whether Claude Code may end the turn. Source: `stop-review-gate-hook.mjs` (`main`, `runStopReview`, `parseStopReviewOutput`).

```mermaid
flowchart TD
    stop([Stop hook fires]) --> gate{Gate enabled<br/>for workspace?}
    gate -- no --> allow([ALLOW — note any running job])
    gate -- yes --> setup{Grok installed<br/>and logged in?}
    setup -- no --> allow2([ALLOW — note: run /grok:setup])
    setup -- yes --> busy{Workspace job in flight?<br/>pid alive, or recent<br/>when pid unknowable}
    busy -- yes --> allow3([ALLOW — note the running job])
    busy -- no --> run["Run stop-review-task<br/>8 min Grok budget · 10 min subprocess timeout<br/>· 12 min hook ceiling"]
    run --> outcome{Outcome}
    outcome -- broker busy --> allow4([ALLOW])
    outcome -- timeout / nonzero exit /<br/>invalid JSON --> block([BLOCK — fail closed])
    outcome -- output parsed --> verdict{Verdict token<br/>in output}
    verdict -- "ALLOW:" --> allow5([ALLOW])
    verdict -- "BLOCK:" --> block2([BLOCK — with Grok's reason])
    verdict -- none, or both --> block3([BLOCK — fail closed, excerpt in reason])
```

The asymmetry is deliberate: *infrastructure absence* fails open (gate off, Grok not set up, Broker busy) while *review failure* fails closed (timeout, crash, unparseable verdict). The escape hatch is `/grok:setup --disable-review-gate`.
