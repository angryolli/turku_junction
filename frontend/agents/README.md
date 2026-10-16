# Agents

Two Node-side agents in this Next.js process. They do not import each other.

| | Operator | System |
|---|---|---|
| Folder | `agents/operator` | `agents/system` |
| Where | `/agent` chat | System Dashboard → **Launch system agent** |
| Trigger | Operator sends a message | Manual cycle (demo). Same `runCycle()` will be on a timer for 24/7 later. |
| Job | Human-in-the-loop language | Autonomous pipeline |

## Operator (`agents/operator`)

Plain-language interface. The operator asks why a flag fired, challenges a conclusion, or pastes a rule in words. The model only answers from diagnosis artifacts and the decision log. It does not generate the understanding report, quality report, or root-cause diagnosis on its own.

Human **accept / question / override** lives on System Dashboard (Judgment). Questions also open this chat.

## System (`agents/system`)

The autonomous reliability loop. One **Launch** run, in order, over derived fingerprints (never raw rows):

1. **Understanding** — plain-language guess of what each channel is, confidence in that guess, and current stream observations
2. **Quality** — completeness / validity / consistency / timeliness as far as the moment table supports; separate broken data from process drift

Root cause is **on demand**: the operator clicks **Do root cause analysis** on a specific alarm card. The system agent then runs a separate prompt with full alarm context, prior understanding/quality notes, and channel fingerprints for that alarm only.

Drift yellow/red flags themselves come from the FastAPI expanding-moment engine, not the LLM. The system agent narrates and attributes them.

Demo scheduler: launch runs **one cycle** then stops (no token burn). Continuous looping is a scheduler change only.

## Challenge map

| Expected output | Owner | Where you look |
|---|---|---|
| Sensor understanding | System agent | System Dashboard (top) + Reports & Logs |
| Data quality checks | System agent | System Dashboard → Quality + Reports & Logs |
| Drift / anomaly | Compute plane + system narration | System Dashboard → Alarms |
| Root-cause diagnosis | System agent (on demand per alarm) | Alarm card → Do root cause analysis |
| Understanding / quality fields | System agent → decision log | Reports & Logs (Understanding, Quality checks, Decision log) |
| 6 Decision log | Both (model calls + overrides) | Reports & Logs → Current decision log; past runs after reset |
| 7 Adaptability | Architecture (unlabeled columns, source `kind`) | Reports & Logs → Data flow |
| 8 Data-flow record | Node LLM layer | Reports & Logs → Data flow |
