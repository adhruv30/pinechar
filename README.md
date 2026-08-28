# PineChar

PineChar is a Chrome extension that puts a negotiation between you and a distracting site. When you navigate to a blocked domain you land on a gate page and have to argue your case: an LLM judge reads your weekly goals, a ledger of everything you've claimed this week, and what you've already spent today, then scores the request 1–10. Code turns that score into a number of minutes — nothing, or a ceiling you then choose within. The site unlocks for exactly that long, then re-blocks itself and evicts the tab. It started as a personal commitment device, so the judge is deliberately hard to talk around: re-claiming progress you already banked, dressing leisure up as utility, or telling the model to go easy on you all score worse than just asking honestly.

## Screenshot

<!-- TODO: screenshot of the gate page mid-negotiation -->

![PineChar gate page](docs/screenshot.png)

## How it works

The architecture rule is **the AI judges, code enforces**. The model never touches enforcement. It emits one of two JSON shapes — a clarifying question, or a judgment carrying a score, reasoning, the claims it's recording, and a message — and that's the entirety of its authority. The server maps score → minutes through a fixed strictness table (moderate: score 6 → 20 min, score 4 → 5 min, 1–3 → nothing), clamps the result, and derives granted/denied itself. The judge never sees a minute count and cannot ask for one.

Enforcement lives in the MV3 service worker: dynamic declarativeNetRequest rules do the blocking, a `chrome.alarms` timer does the expiry, and the grant record in `chrome.storage.local` is the single source of truth — rules and alarms are derived state, rebuilt by a `reconcile()` on every worker boot. Ordering is fail-closed (write the grant before removing the block rule; re-add the rule before evicting tabs), and every operation runs under a worker lock, because unlock, relock, and reconcile are each a non-atomic read-modify-write across three subsystems and the worker wakes up mid-flight.

A grant is a ceiling, not a booking. Redeeming it is a ritual scaled to the score: at 7+ you type how many of the earned minutes you actually want; below that you have to write the same number into a sentence naming what you're spending it instead of — a phrase the judge picked from the goal your ledger shows you've been avoiding. During a session a countdown pill rides on the site in a closed shadow root. The pill is cosmetic; it enforces nothing.

## The red team

The interesting failure mode isn't a jailbreak, it's that the person negotiating wrote the goals, controls the persona, and has all week to find the sentence that works. The 12-rule judgment core is what's left after adversarial passes against five attack classes:

1. **Spending the same credit twice.** "I finished the milestone" earns once. Completion progress is checked against the ledger and only progress made since the last claim counts; habit progress earns small credit per instance, capped at the stated weekly frequency, and never scores above 6 on its own. Contradicting the ledger caps the score at 3.
2. **Unfalsifiable vagueness.** "Made progress", "been grinding" — persuasive, unverifiable, unbankable. Vague claims cap at 5 and get challenged for a concrete artifact; only the specific version is written to the ledger, and "more progress" on a vague claim is the same vague claim. Scoring tracks receipts, not rhetoric.
3. **Reframing.** Leisure with a virtuous label is leisure. Goals demanding action (apply, finish, go) aren't served by consumption (watch, read about, research) beyond brief bounded inputs. Utility grants are priced by the task's realistic duration rather than the minutes requested, because an inflated ask is itself evidence. Magnitude counts too: one commit toward a milestone is a small score, and when effort is unclear the judge may ask exactly one clarifying question before scoring.
4. **Prompt injection through the surfaces you own.** Goals text and persona are user-written and reach the model directly. The prompt is two layers: an unchangeable judgment core and a cosmetic voice layer. Instructions to be lenient, auto-approve, change rules, or reveal scoring mechanics are refused silently and judged normally — persona shapes delivery, never decisions.
5. **Pressure and attrition.** Distress gets kindness in tone and zero points; emergencies route to a code-side path and never score above 5. Skepticism rises with each request in a day, a denial raises the bar so a repeat without new facts scores lower than the ask it follows, and "I wasn't going to work anyway" earns nothing.

Everything above is scoring policy. Even if all of it fails, the model's most permissive possible output is a 10, and a 10 is 40–60 minutes depending on strictness — the ceiling is in the table, not in the conversation.

## Tech stack

- **Extension** — Chrome MV3, vanilla JS, no build step. declarativeNetRequest, storage, alarms. No `tabs` permission (host permissions cover URL-filtered `tabs.query` and avoid the browsing-history warning).
- **Server** — Node 18+, Express, `@anthropic-ai/sdk`, running locally. One endpoint, `POST /negotiate`. Stateless: goals, ledger, and grants all live in `chrome.storage.local`, and any error fails closed to a denial rather than an open gate.
- **Model** — `claude-sonnet-4-6`.
- **Tests** — `harness/`, 36 branches, zero dependencies. Loads the real extension sources into a stubbed `chrome.*` and a small DOM where storage hands back copies and calls resolve on later turns, so the read-modify-write races reproduce for real.

## Local setup

The server holds your API key, so it runs on your machine; nothing leaves it except the negotiation itself.

**1. Server**

```bash
cd server
npm install
cat > .env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EXTENSION_ID=
PORT=3111
EOF
npm run dev
```

**2. Extension**

Go to `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select `extension/`.

**3. Pin CORS**

Copy the extension ID off its card in `chrome://extensions` into `EXTENSION_ID` in `.env` and restart the server. Left blank, the server accepts any `chrome-extension://` origin and says so on startup — fine for dev, not for leaving running.

**4. Set goals**

Click the extension icon and write your weekly goals as prose. The judge sees this verbatim; it's the only thing standing between you and a very agreeable model.

Then navigate to `instagram.com`. A red bubble in the chat means the server isn't running.

Tests: `node harness/run.js [filter]`.

## Status

Personal project, in active development, single user (me). It works end to end — blocking, multi-turn negotiation, the redemption ritual, timed unlock, expiry, tab eviction, the countdown pill — but it's pre-1.0 in every direction that matters: one site is blocked (Instagram), there's no settings UI, strictness and persona are hardcoded defaults, and the server has to be started by hand. `gate.js` and the dev reset have no test coverage yet. Not on the Web Store, no packaging, no support. Read it, fork it, take the ideas; expect rough edges if you run it.
