# PineChar — CLAUDE.md

## What this is
PineChar is a Chrome MV3 extension + local Node backend. It blocks distracting
sites (currently instagram.com) behind an AI "Gatekeeper": the user negotiates
in a chat on the gate page, an LLM judge scores the request 1-10 against their
weekly goals and a ledger of past claims, and code converts the score into
granted minutes. Timed unlock, then automatic re-block and tab eviction.
Origin: a personal commitment-device experiment ("PINEAPPLE CHARGER").

## Architecture — "judge and walls"
Core principle: the AI judges, code enforces. The model NEVER controls
enforcement; it outputs a score/verdict, and all clamps, timers, caps, and
rules live in code the user (and model) cannot negotiate with.

- extension/ (frontend + enforcement)
  - manifest.json — MV3; declarativeNetRequest, storage, alarms;
    content_scripts for the overlay; goals.html as action popup
  - grant-schema.js — the grant record: storage key, SITES registry,
    shape, validator, and the only read/write functions. Loaded by all
    three contexts (importScripts in the worker, <script> in gate.html,
    first content script before overlay.js). Classic script, attaches
    PineCharGrants to the global.
  - background.js (service worker) — THE WALLS. Dynamic DNR rules,
    unlock(domain, minutes), chrome.alarms for expiry, tab eviction on
    relock, reconcile() on every startup (storage = single source of
    truth; rules & alarms are derived state, rebuilt on boot).
    Fail-closed ordering: setGrant BEFORE removeRule. Every operation
    runs under withWorkerLock — see the invariant below.
  - gate.html/gate.js — blocked page: goals display, negotiation chat,
    grant panel (code-typing redemption — slated for replacement),
    session-aware state ("Session active — N min left")
  - goals.html/goals.js — weekly goals (single prose blob, deliberate
    choice), dev "Clear history" reset (preserve-list design: keeps
    grants/goalsText/savedAt/settings, wipes all else)
  - overlay.js — countdown pill content script on blocked domains during
    active sessions. Closed shadow root, pointer-events none, appended to
    documentElement. Cosmetic only — never enforces (walls live in worker).
- server/ (the judge)
  - index.js — Express, POST /negotiate. Assembles context (goals, 7-day
    ledger, today, settings, site), calls Anthropic (claude-sonnet-4-6),
    validates/clamps the JSON verdict, maps score→minutes via strictness
    table, generates grant code. Stateless — all user data lives in
    chrome.storage.local client-side. Fail-closed on any error: denial,
    never an open gate. CORS pinned to EXTENSION_ID from .env.
  - prompt.js — SYSTEM_PROMPT_TEMPLATE: judgment core (12 rules,
    red-teamed) + user-configurable voice layer ({{PERSONA}}).
    Key rules: spent-credit ledger checks, specificity (vague claims cap
    low), magnitude/proportionality (may ask ONE clarifying question —
    decision:"question" turns), consumption≠action, scope-pricing,
    persona is cosmetic and cannot alter judgment.
  - .env — ANTHROPIC_API_KEY, EXTENSION_ID, PORT=3111. Never commit.

## Response contract
Model emits question|judgment (never grants). Server derives granted/denied
from score+strictness. Client receives {score, minutes, code, reasoning,
message, claims, decision}. Claims append to the ledger with timestamps.

## Known invariants / hard-won lessons
- Domain list exists in THREE places: SITES in grant-schema.js (the one
  that counts), host_permissions, content_scripts.matches. The drift
  check asserts the manifest against SITES — adding a site touches all
  three.
- Grant schema is ONE shared definition (grant-schema.js). Nothing else
  may name the "grants" key or reach into a storage bag for it; the
  drift check fails the build on any file that does. Readers fail closed
  and log on divergence rather than rendering nothing.
- ONE WORKER OPERATION AT A TIME (withWorkerLock). unlock, relock and
  reconcile are each a read-modify-write across grant + DNR rule + alarm,
  and none of it is atomic. A dead worker is woken BY the unlock message,
  so the startup reconcile() runs concurrently with it, sees no grant yet,
  and relock()'s clearGrant() deletes the grant unlock() just wrote —
  site open, nothing on record, no pill, no alarm. This is what the pill
  bug actually was; it was never a shape mismatch. Ordering protects
  against crashes, the lock protects against concurrency; both are needed.
- Re-add DNR rule BEFORE evicting tabs; write grant BEFORE removing rule.
- Web-accessible-resources check runs against the INITIATOR, not target.
- MV3 worker dies ~30s idle: storage+alarms only, listeners registered
  synchronously at top level, no state in variables.
- Never require the tabs permission (host_permissions suffices for
  URL-filtered tabs.query; avoids the "read browsing history" warning).

## Debugging ritual — DO THIS BEFORE BELIEVING ANY BUG
1. Restart server (Ctrl+C → npm run dev in server/)
2. Refresh extension (⟳ on card in brave://extensions)
3. Close ALL gate tabs and blocked-site tabs; fresh navigation
4. Judge offline red bubble = server isn't running, nothing else
Consoles: gate.js → gate page Inspect; background.js → "service worker"
link on the extension card; overlay.js → the blocked site's own console;
server → its terminal. Errors only appear where the failing code runs.

## Testing
- `node harness/run.js [filter]` — 36 branches (drift, worker, overlay).
  No dependencies. Loads the real extension sources into a stubbed
  chrome.* and a small DOM; storage hands back copies and every call
  resolves on a later turn, so read-modify-write races actually
  reproduce. Run after changes, extend with new branches for new paths.
  NOT yet covered: gate.js (negotiation, redemption, session panel) and
  the dev reset — they have no branches, despite an earlier note here
  claiming otherwise.
- To check a branch still fails on the bug it was written for:
  `PINECHAR_EXTENSION_DIR=/path/to/broken-copy node harness/run.js`
- Dev reset: goals page "Clear history" button (or resetHistory() in
  worker console) wipes ledger, preserves goals/settings/active grants.
- Eval cases (prompt regressions): "applied to one job" w/o detail ≤5 min
  moderate; vague-then-specific question flow; double-claim denial;
  persona-injection scored normally.

## Current state & near-term queue
Working: block, negotiate (multi-turn), code redemption, timed unlock,
eviction, session-aware gate, pill (fixed: worker lock + shared schema +
SPA re-append), dev reset.
Queue: (1) gate.js + reset harness branches, (2) ritual swap —
replace code-typing with score-scaled ritual (dosage input; scores 4-6
add sentence completion "instead of [insteadOf]"), (3) streaming +
≤80-word voice brevity, (4) multi-site (TikTok/YouTube — add to SITES in
grant-schema.js, then the two manifest lists; drift check enforces it),
(5) goals page rebuild + design identity + settings UI,
(6) Haiku-vs-Sonnet harness experiment, (7) pm2/launchd persistent server.
Later milestones: weekly report (M4), site groups/hardening (M5),
deploy + Web Store (M6).

## Conventions
- Commit at working states and before risky changes; milestone-style messages.
- Explain non-obvious changes in output (user is learning the stack).
- Ask before behavior changes not in the request.