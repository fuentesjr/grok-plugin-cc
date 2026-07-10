# CONTEXT

Glossary of terms for the grok-plugin-cc domain. Terms are canonical — use them exactly as defined.

## Terms

### Plugin
The Claude Code plugin this repo builds. It lets a Claude Code session delegate work to Grok, mirroring the codex plugin (`openai/codex-plugin-cc`) so the two feel interchangeable.

### Grok Build
xAI's agentic CLI (`grok`), the external agent the Plugin delegates to. Not the Grok chat product or the bare xAI API.

### Broker
The Plugin's persistent companion process that owns the connection to Grok Build and mediates all traffic between Claude Code and Grok. There is one Broker concern per Claude Code session.

### ACP (Agent Client Protocol)
The open JSON-RPC 2.0 protocol spoken between the Broker and Grok Build (`grok agent stdio`). Defines session lifecycle, prompt submission, streamed updates, and permission requests.

### Job
One delegated unit of work sent to Grok Build (e.g. a Rescue or a Review), tracked from dispatch to completion with its own identity and status.

### Rescue
A Job that hands Grok Build a stuck problem, a second-opinion pass, or a substantial delegated task. May be read-only (diagnosis) or write-enabled.

### Review
A Job in which Grok Build reviews a diff and returns structured findings. Always read-only.

### Transfer
Handing the current Claude Code session's context over to Grok Build so work continues there. (Phase 2.)
