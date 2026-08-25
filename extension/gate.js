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

// The redemption ritual branches here. At 7+ the case was made and the only
// question left is how much of the ceiling to spend, so the input is a bare
// number. Below that the grant is real but marginal, and the same number has
// to be said as a sentence naming what it costs. 1-3 never reaches either:
// those score to zero minutes and there is no grant to redeem.
const FAST_PATH_SCORE = 7;

// The floor on a redemption. Granted minutes are the ceiling; this is the other
// end. Mirrored in background.js, which is where it is actually enforced.
const MIN_TAKEN_MINUTES = 1;

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
const redeemFast = document.getElementById("redeemFast");
const redeemSentence = document.getElementById("redeemSentence");
const takeFast = document.getElementById("takeFast");
const takeSentence = document.getElementById("takeSentence");
const sentenceSite = document.getElementById("sentenceSite");
const insteadOfText = document.getElementById("insteadOf");
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

// The one event that is written twice: a grant is logged when the judge makes
// it, and amended when the user says how much of it they are spending. Those
// are minutes apart and the second may never come, so the alternative — hold
// the write until redemption — would lose every walked-away grant, which is
// exactly the record worth keeping.
//
// Found by code, which is why the server still generates one: it is the
// grant's ID. Joins the same serialized chain as appendEvent, so the read
// here cannot straddle an append.
function recordTaken(code, taken) {
  ledgerWrites = ledgerWrites.then(async () => {
    const { [LEDGER_KEY]: ledger = [] } = await chrome.storage.local.get(LEDGER_KEY);
    if (!Array.isArray(ledger)) return;

    // Last match, not first: codes are random enough not to repeat, but the
    // newest entry is the right answer if one ever did.
    const entry = [...ledger].reverse().find((e) => e?.type === "grant" && e.code === code);
    if (!entry) {
      console.error("[pinechar] no grant to amend for code", code);
      return;
    }

    entry.taken = taken;
    entry.takenAt = Date.now();
    await chrome.storage.local.set({ [LEDGER_KEY]: ledger.slice(-LEDGER_MAX_EVENTS) });
  });
  return ledgerWrites;
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
    // Two numbers since the ritual swap: the ceiling earned, and the minutes
    // actually spent under it. `e.minutes` is the pre-swap field name, still
    // in ledgers written before this change.
    minutesGranted: grants.reduce((sum, e) => sum + (e.granted ?? e.minutes ?? 0), 0),
    minutesTaken: grants.reduce((sum, e) => sum + (e.taken ?? e.minutes ?? 0), 0),
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
  // otherwise turn into `granted: undefined` and a silently broken unlock.
  const granted = Number(data.minutes);
  if (!Number.isFinite(granted) || granted < 0) throw new Error("malformed minutes");

  const code = typeof data.code === "string" ? data.code : null;
  const score = Number.isInteger(data.score) ? data.score : null;

  // Both of these are load-bearing on a grant and neither has a safe default:
  // the code is the ledger entry's ID, and the score decides which ritual the
  // user is asked for. Missing either means a response we don't understand, so
  // the gate stays shut rather than guessing. Denials need neither.
  if (granted > 0 && !code) throw new Error("grant arrived without a code");
  if (granted > 0 && score === null) throw new Error("grant arrived without a score");

  return {
    kind: "judgment",
    // A ceiling. What the user chooses under it is `taken`, decided at
    // redemption, and that is what actually opens the gate.
    granted: Math.floor(granted),
    code,
    message,
    reasoning: typeof data.reasoning === "string" ? data.reasoning : "",
    score,
    // Only the mid-score sentence reads this, and only as decoration, so an
    // absent one falls back here rather than failing the grant.
    insteadOf:
      typeof data.insteadOf === "string" && data.insteadOf.trim()
        ? data.insteadOf.trim()
        : "your goals",
    claims: Array.isArray(data.claims) ? data.claims.filter((c) => typeof c === "string") : [],
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

// Strict on purpose. `type="number"` already hands back "" for input the
// browser itself couldn't parse, but it will happily pass through "20.5",
// "-5" and "1e3" — all of which Number() accepts and none of which is a
// number of minutes. Digits only, then the range.
function parseTaken(raw, ceiling) {
  const trimmed = String(raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const taken = Number(trimmed);
  return taken >= MIN_TAKEN_MINUTES && taken <= ceiling ? taken : null;
}

// The commitment ritual. The gate does not open as a side effect of the judge
// saying yes: the user has to name a number under the ceiling and act on it.
//
// Two stages on one button, and the split is not cosmetic. The first click
// redeems; only once the worker has answered does a listener that can navigate
// get attached. That ordering is the whole guard — the capability to reach the
// site must not exist before the DNR rule is actually gone, and `disabled`
// alone would leave a handler in the DOM one stray .click() from firing.
function armRedemption(decision) {
  const ceiling = decision.granted;
  const field = decision.score >= FAST_PATH_SCORE ? takeFast : takeSentence;

  let taken = null;
  let redeeming = false;
  let redeemed = false;

  // Live validation only — no unlock happens here. An input listener that
  // redeemed on its own would fire on the "2" of "20" and take two minutes of
  // a twenty-minute grant.
  function refresh() {
    taken = parseTaken(field.value, ceiling);
    goButton.disabled = taken === null;
    goButton.textContent = taken === null ? `Take up to ${ceiling} min` : `Take ${taken} min`;
  }

  field.addEventListener("input", refresh);

  goButton.addEventListener("click", async () => {
    // This listener outlives redemption — the navigation handler is added
    // alongside it rather than replacing it — so it has to go quiet once its
    // work is done.
    if (redeemed || redeeming || taken === null) return;

    redeeming = true;
    field.disabled = true;
    goButton.disabled = true;

    const res = await chrome.runtime.sendMessage({
      type: "unlock",
      site,
      // What the user chose, and the ceiling it has to fit under. The worker
      // clamps against both rather than trusting either.
      minutes: taken,
      granted: ceiling,
    });

    if (!res?.ok) {
      // The choice was valid; the plumbing wasn't. Let them try again rather
      // than stranding a legitimate grant.
      grantError.textContent = `Couldn't open the gate: ${res?.error ?? "no response from the extension"}`;
      grantError.hidden = false;
      field.disabled = false;
      redeeming = false;
      refresh();
      return;
    }

    redeemed = true;
    grantError.hidden = true;

    // The worker clamps, so what it opened may be less than what was asked
    // for. The ledger records its answer, not the request.
    const opened = Number.isFinite(res.minutes) ? res.minutes : taken;
    await recordTaken(decision.code, opened);
    grantMinutes.textContent = `${opened} min on ${siteLabel} — running`;

    siteDomain = res.domain ?? siteDomain;
    goButton.textContent = `Go to ${siteDomain}`;
    goButton.addEventListener("click", () => {
      location.href = `https://${siteDomain}`;
    });
    goButton.disabled = false;
    goButton.focus();
  });

  if (field === takeSentence) {
    sentenceSite.textContent = siteLabel;
    insteadOfText.textContent = decision.insteadOf;
    redeemSentence.hidden = false;
  } else {
    redeemFast.hidden = false;
  }

  // The browser's own bounds, so the spinner and the arrow keys agree with
  // parseTaken instead of quietly offering numbers it will reject.
  field.min = String(MIN_TAKEN_MINUTES);
  field.max = String(ceiling);
  field.step = "1";

  refresh();
  field.focus();
}

async function handleGrant(decision) {
  await appendEvent(requestEvent());
  await appendEvent({
    type: "grant",
    at: Date.now(),
    site,
    score: decision.score,
    // Two numbers, deliberately. `granted` is what the score bought;
    // `taken` is what was actually spent, and it stays 0 until a redemption
    // patches it — a grant walked away from is a real and interesting event,
    // not a missing one.
    granted: decision.granted,
    taken: 0,
    // The code is the grant's ID now rather than something typed back. It is
    // what recordTaken() finds this entry by.
    code: decision.code,
    insteadOf: decision.insteadOf,
    claims: decision.claims,
    reasoning: decision.reasoning,
  });

  grantMinutes.textContent = `Up to ${decision.granted} min on ${siteLabel}`;
  grantCode.textContent = decision.code;
  grantPanel.hidden = false;
  composer.hidden = true;

  // Deliberately not automatic: navigating away the instant a number is typed
  // would blow the grant off the screen before it could be read. armRedemption
  // owns the button from here.
  goButton.disabled = true;

  armRedemption(decision);
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
    } else if (decision.granted > 0) {
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
