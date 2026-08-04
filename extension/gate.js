const NEGOTIATE_URL = "http://localhost:3111/negotiate";

// The model call runs adaptive thinking, so it is slow by design. This only
// needs to be short enough that a hung server doesn't leave the page waiting
// forever with no way back.
const REQUEST_TIMEOUT_MS = 60_000;

const LEDGER_KEY = "ledger";
// Grants are written by background.js and read here through the shared schema —
// this page does not restate the key or the shape.
const { activeGrant: readActiveGrant } = self.PineCharGrants;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Storage cap. Anything older than a week is already excluded from the prompt,
// so trimming past this only drops events nothing reads.
const LEDGER_MAX_EVENTS = 500;

// How often the active-session countdown redraws.
const SESSION_TICK_MS = 30_000;

// No settings UI yet — these are what the server sees until there is one.
const DEFAULT_SETTINGS = {
  strictness: "moderate",
  persona: "A fair, plain-spoken gatekeeper.",
};

const params = new URLSearchParams(location.search);
const site = params.get("site") ?? "instagram";
// Set when we pulled this tab off the site rather than blocking a fresh visit.
// The judge prices these differently, so it rides along as a flag.
const postExpiry = params.get("expired") === "true";

const siteLabel = site.charAt(0).toUpperCase() + site.slice(1);

const heading = document.querySelector("h1");
const log = document.getElementById("log");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const grantPanel = document.getElementById("grant");
const grantMinutes = document.getElementById("grantMinutes");
const grantCode = document.getElementById("grantCode");
const grantError = document.getElementById("grantError");
const codeInput = document.getElementById("codeInput");
const goButton = document.getElementById("go");
const sessionPanel = document.getElementById("session");
const sessionTime = document.getElementById("sessionTime");
const sessionGo = document.getElementById("sessionGo");

// The turns the judge sees. The opening challenge below is deliberately absent:
// the system prompt already tells the model it asked that, and the server
// requires the first entry to be a user turn.
const conversation = [];

// Every user turn in this negotiation. Written to the ledger only once a real
// decision lands — a clarifying question resolves nothing, so it logs nothing.
const userTurns = [];

// Rule 12 lets the judge ask before scoring. The server can't count these
// itself: it sees each turn cold.
let questionsAsked = 0;

// The site's real domain, from the worker's registry. Null if the lookup fails,
// which means no link can be offered.
let siteDomain = null;

if (postExpiry) {
  heading.textContent = "Time's up";
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

// textContent throughout: `text` is model output, and this page has the
// extension's origin and its chrome.* access.
function addBubble(who, text, extraClass) {
  const el = document.createElement("div");
  el.className = `bubble ${who}${extraClass ? ` ${extraClass}` : ""}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

// Appends are read-modify-write, so two of them in flight would lose one.
// Every caller goes through this chain, which is enough because a gate page
// only ever writes on its own turn. Two gate tabs racing can still clobber —
// same tradeoff background.js already makes for grants.
let ledgerWrites = Promise.resolve();

function appendEvent(event) {
  ledgerWrites = ledgerWrites.then(async () => {
    const { [LEDGER_KEY]: ledger = [] } = await chrome.storage.local.get(LEDGER_KEY);
    ledger.push(event);
    await chrome.storage.local.set({
      [LEDGER_KEY]: ledger.slice(-LEDGER_MAX_EVENTS),
    });
  });
  return ledgerWrites;
}

async function readLedger() {
  await ledgerWrites;
  const { [LEDGER_KEY]: ledger = [] } = await chrome.storage.local.get(LEDGER_KEY);
  return Array.isArray(ledger) ? ledger : [];
}

// The request that produced a decision, flushed alongside it. The opening ask
// is the request; anything after it is answering the judge's question.
function requestEvent() {
  const event = { type: "request", at: Date.now(), site, text: userTurns[0] ?? "" };
  if (userTurns.length > 1) event.clarifications = userTurns.slice(1);
  return event;
}

// "This week" is the trailing seven days rather than a calendar week: a Monday
// reset would blank the ledger exactly when a Sunday binge matters most.
function thisWeek(ledger) {
  const cutoff = Date.now() - WEEK_MS;
  return ledger.filter((e) => typeof e?.at === "number" && e.at >= cutoff);
}

function summarizeToday(ledger) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = ledger.filter((e) => typeof e?.at === "number" && e.at >= midnight);

  // Offline failures are excluded on purpose. They are denials in effect, but
  // the judge never saw the request, and post_denial raises the bar on the next
  // one — the server being down shouldn't cost the user points.
  const denials = today.filter((e) => e.type === "denial" && !e.offline);
  const grants = today.filter((e) => e.type === "grant");

  return {
    // +1 for the negotiation in flight, which hasn't been written yet. It
    // counts once no matter how many turns it takes.
    requests: today.filter((e) => e.type === "request").length + 1,
    grants: grants.length,
    minutesGranted: grants.reduce((sum, e) => sum + (e.minutes ?? 0), 0),
    denials: denials.length,
    flags: { post_expiry: postExpiry, post_denial: denials.length > 0 },
  };
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

async function negotiate() {
  const { goalsText = "", settings } = await chrome.storage.local.get([
    "goalsText",
    "settings",
  ]);
  const ledger = await readLedger();

  const res = await fetch(NEGOTIATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      site,
      messages: conversation,
      goalsText,
      ledger: thisWeek(ledger),
      today: summarizeToday(ledger),
      todayEvents: [], // calendar isn't wired up yet
      settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      questionsAsked,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`server responded ${res.status}`);

  const data = await res.json();
  if (!data || typeof data !== "object") throw new Error("malformed response");

  const message = typeof data.message === "string" ? data.message : "";

  // A question carries no score and settles nothing.
  if (data.decision === "question") {
    if (!message.trim()) throw new Error("empty question");
    return { kind: "question", message };
  }

  // The server fails closed on its own errors, but a malformed body here would
  // otherwise turn into `minutes: undefined` and a silently broken unlock.
  const minutes = Number(data.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("malformed minutes");

  const code = typeof data.code === "string" ? data.code : null;
  // The code is the only way to redeem a grant, so a grant without one is not
  // usable — treat it as a broken response rather than opening the gate.
  if (minutes > 0 && !code) throw new Error("grant arrived without a code");

  return {
    kind: "judgment",
    minutes: Math.floor(minutes),
    code,
    message,
    reasoning: typeof data.reasoning === "string" ? data.reasoning : "",
    score: Number.isInteger(data.score) ? data.score : null,
    claims: Array.isArray(data.claims) ? data.claims.filter((c) => typeof c === "string") : [],
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

// Typing the code back is the commitment ritual — the gate does not open as a
// side effect of the judge saying yes, only of the user acting on it.
function armRedemption(decision) {
  const expected = decision.code.trim().toUpperCase();
  let redeeming = false;

  codeInput.addEventListener("input", async () => {
    if (redeeming) return;
    if (codeInput.value.trim().toUpperCase() !== expected) {
      goButton.disabled = true;
      return;
    }

    redeeming = true;
    codeInput.disabled = true;

    const res = await chrome.runtime.sendMessage({
      type: "unlock",
      site,
      minutes: decision.minutes,
    });

    if (!res?.ok) {
      // The code was right; the plumbing wasn't. Let them try again rather
      // than stranding a legitimate grant.
      grantError.textContent = `Couldn't open the gate: ${res?.error ?? "no response from the extension"}`;
      grantError.hidden = false;
      codeInput.disabled = false;
      codeInput.value = "";
      redeeming = false;
      return;
    }

    // Only now does a way to the site exist. The listener is attached here
    // rather than up front so the capability to navigate cannot predate the
    // worker's reply — and that reply is only sent once the DNR rule is
    // actually gone. `disabled` alone would leave the guard in the DOM, one
    // stray .click() away from sending the tab at a still-blocked site.
    grantError.hidden = true;
    siteDomain = res.domain ?? siteDomain;
    goButton.textContent = `Go to ${siteDomain}`;
    goButton.addEventListener("click", () => {
      location.href = `https://${siteDomain}`;
    });
    goButton.disabled = false;
    goButton.focus();
  });
}

async function handleGrant(decision) {
  await appendEvent(requestEvent());
  await appendEvent({
    type: "grant",
    at: Date.now(),
    site,
    score: decision.score,
    minutes: decision.minutes,
    code: decision.code,
    claims: decision.claims,
    reasoning: decision.reasoning,
  });

  grantMinutes.textContent = `${decision.minutes} min on ${siteLabel}`;
  grantCode.textContent = decision.code;
  grantPanel.hidden = false;
  composer.hidden = true;

  // Deliberately not automatic: navigating away the instant the code is
  // accepted would blow the grant off the screen before it could be read.
  // Inert until redemption — armRedemption() attaches the click handler.
  goButton.textContent = `Go to ${siteDomain ?? siteLabel}`;
  goButton.disabled = true;

  armRedemption(decision);
  codeInput.focus();
}

async function handleDenial(decision) {
  await appendEvent(requestEvent());
  await appendEvent({
    type: "denial",
    at: Date.now(),
    site,
    score: decision.score,
    claims: decision.claims,
    reasoning: decision.reasoning,
  });
}

// Fail closed. The gate stays shut whenever the judge can't be reached, and the
// event is logged so the week's record doesn't have a hole in it — but flagged
// `offline` so it never counts against the next request.
async function handleOffline(err) {
  console.error("[pinechar] negotiate failed:", err);

  await appendEvent(requestEvent());
  await appendEvent({
    type: "denial",
    at: Date.now(),
    site,
    offline: true,
    reasoning: `Judge unreachable: ${err?.message ?? String(err)}`,
  });

  addBubble(
    "gatekeeper",
    "The judge is offline — I can't reach it, so the gate stays shut. " +
      "Check that the PineChar server is running, then try again. " +
      "(The console has the specific error.)",
    "offline",
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function setBusy(busy) {
  input.disabled = busy;
  sendButton.disabled = busy;
  sendButton.textContent = busy ? "…" : "Send";
  if (!busy) input.focus();
}

async function submit() {
  const text = input.value.trim();
  if (!text || input.disabled) return;

  input.value = "";
  addBubble("user", text);
  conversation.push({ role: "user", content: text });
  userTurns.push(text);
  setBusy(true);

  const pending = addBubble("gatekeeper", "thinking…", "pending");

  try {
    const decision = await negotiate();
    pending.remove();

    addBubble("gatekeeper", decision.message || "(no reply)");
    // Only real replies join the conversation — an offline notice was never
    // said by the judge and must not come back to it as its own words.
    conversation.push({ role: "assistant", content: decision.message });

    if (decision.kind === "question") {
      // Nothing decided, nothing logged. The user answers and we go again.
      questionsAsked += 1;
    } else if (decision.minutes > 0) {
      await handleGrant(decision);
      return; // composer is hidden; the negotiation is over
    } else {
      await handleDenial(decision);
    }
  } catch (err) {
    pending.remove();
    await handleOffline(err);
  }

  setBusy(false);
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});

// Enter sends, Shift+Enter breaks the line — the textarea is there for the
// second case, not because arguments are expected to be long.
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

// ---------------------------------------------------------------------------
// Active session
// ---------------------------------------------------------------------------

let sessionTicker = null;
let sessionAlarm = null;
let sessionExpiry = null;

function describeRemaining(ms) {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "Session active — less than a minute left";
  return `Session active — ${minutes} minutes left`;
}

function stopSessionTimers() {
  if (sessionTicker !== null) clearInterval(sessionTicker);
  if (sessionAlarm !== null) clearTimeout(sessionAlarm);
  sessionTicker = null;
  sessionAlarm = null;
}

function tickSession() {
  const remaining = sessionExpiry - Date.now();
  if (remaining <= 0) {
    endSession();
    return;
  }
  sessionTime.textContent = describeRemaining(remaining);
}

// The grant ran out while this page sat open. Drop straight into the ordinary
// blocked state — the user has to make a fresh case.
function endSession() {
  stopSessionTimers();
  sessionPanel.hidden = true;
  heading.textContent = "Time's up";
  startNegotiation();
}

// Already redeemed, so no code is asked for again.
function showSession(expiresAt) {
  sessionExpiry = expiresAt;
  heading.textContent = "Session active";
  log.hidden = true;
  composer.hidden = true;
  sessionPanel.hidden = false;

  if (siteDomain) {
    sessionGo.textContent = `Go to ${siteDomain}`;
    sessionGo.addEventListener("click", () => {
      location.href = `https://${siteDomain}`;
    });
  } else {
    sessionGo.hidden = true;
  }

  tickSession();
  sessionTicker = setInterval(tickSession, SESSION_TICK_MS);

  // The 30s tick alone would leave a dead session on screen for up to half a
  // minute, offering a link that just bounces back here. This lands on the
  // exact expiry. Clamped because setTimeout overflows past ~24.8 days and
  // would then fire immediately.
  sessionAlarm = setTimeout(endSession, Math.min(expiresAt - Date.now(), 2_000_000_000));
}

async function activeGrant() {
  return readActiveGrant(chrome.storage.local, site);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let negotiationStarted = false;

function startNegotiation() {
  if (negotiationStarted) return;
  negotiationStarted = true;
  log.hidden = false;
  composer.hidden = false;
  addBubble("gatekeeper", `Why do you deserve ${siteLabel} right now?`);
  input.focus();
}

async function lookupDomain() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "siteInfo", site });
    return res?.ok ? res.domain : null;
  } catch (err) {
    console.error("[pinechar] siteInfo lookup failed:", err);
    return null;
  }
}

async function boot() {
  // Remind me what I said I'd be doing instead.
  chrome.storage.local.get("goalsText").then(({ goalsText }) => {
    const el = document.getElementById("goals");
    const text = goalsText?.trim();
    el.textContent = text || "No goals set yet — click the toolbar icon to add some.";
    el.classList.toggle("empty", !text);
  });

  siteDomain = await lookupDomain();

  const expiresAt = await activeGrant();
  if (expiresAt) {
    showSession(expiresAt);
    return;
  }

  startNegotiation();
}

boot();
