// The site registry and everything about the grant record live in
// grant-schema.js, which the gate page and the overlay load too. This worker is
// the only writer; it does not get its own idea of the shape.
importScripts("./grant-schema.js");

const { SITES, GRANTS_KEY, loadGrants, saveGrants, isActive } = self.PineCharGrants;

const ALARM_PREFIX = "relock:";
const LEDGER_KEY = "ledger"; // written by gate.js; only read here for the count

// The wall's own ceiling on a single session, in minutes. The server clamps to
// the same number on the way out, but that clamp lives on the other side of an
// HTTP call the page makes — it is a policy, not a wall. This one is the wall:
// nothing that reaches unlock() can open the site for longer than this,
// whatever the page believes it was granted.
const MAX_MINUTES = 60;
const MIN_MINUTES = 1;

// taken <= granted <= MAX_MINUTES.
//
// `taken` is what the user chose on the gate; `granted` is the ceiling the
// judge's score paid out. The page is the only thing that has ever seen the
// grant, so the worker cannot verify `granted` — but it can refuse to be told
// a ceiling it doesn't understand, and it can refuse to exceed one it does.
// Returns null for anything it will not open the gate on; a request for more
// than the ceiling is clamped down rather than refused, since asking for too
// much is a slip, not an attack the wall needs to punish.
function clampMinutes(taken, granted) {
  const ceiling = Math.min(Math.floor(Number(granted)), MAX_MINUTES);
  const want = Math.floor(Number(taken));

  // Fail closed on either being absent or unreadable. A missing ceiling used to
  // be harmless because the page sent the full grant and nothing else; now the
  // two numbers are separate, and a dropped one must not default to "all of it".
  if (!Number.isFinite(ceiling) || ceiling < MIN_MINUTES) return null;
  if (!Number.isFinite(want) || want < MIN_MINUTES) return null;

  return Math.min(want, ceiling);
}

function blockRule(key) {
  const site = SITES[key];
  return {
    id: site.ruleId,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { extensionPath: `/gate.html?site=${key}` },
    },
    condition: {
      requestDomains: [site.domain],
      resourceTypes: ["main_frame"],
    },
  };
}

// Adding a rule whose ID already exists throws, so every add removes the same ID
// first. That makes addRule() safe to call when we don't know the current state.
async function addRule(key) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [SITES[key].ruleId],
    addRules: [blockRule(key)],
  });
}

async function removeRule(key) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [SITES[key].ruleId],
  });
}

// Re-adding a rule only affects future navigations, so tabs already sitting on
// the site stay alive. This kicks them to the gate.
//
// The url filter is doing double duty: it selects the tabs, and it keeps this
// call inside our host_permissions, which is why no "tabs" permission is needed.
// A pattern of `*.instagram.com` covers the bare domain as well as subdomains.
async function evictTabs(key) {
  const gateUrl = chrome.runtime.getURL(
    `gate.html?site=${key}&expired=true`,
  );
  const tabs = await chrome.tabs.query({
    url: `*://*.${SITES[key].domain}/*`,
  });

  // allSettled: a tab can close between the query and the update, and one
  // failure shouldn't strand the rest on the site.
  await Promise.allSettled(
    tabs.map((tab) => chrome.tabs.update(tab.id, { url: gateUrl })),
  );
}

async function getGrants() {
  const { grants } = await loadGrants(chrome.storage.local);
  return grants;
}

async function setGrant(key, expiresAt) {
  const grants = await getGrants();
  grants[key] = expiresAt;
  await saveGrants(chrome.storage.local, grants);
}

async function clearGrant(key) {
  const grants = await getGrants();
  delete grants[key];
  await saveGrants(chrome.storage.local, grants);
}

// ---------------------------------------------------------------------------
// The worker lock
// ---------------------------------------------------------------------------

// Everything this worker does to the world — unlock, relock, reconcile — is a
// read-modify-write across three stores that have to agree: the grant in
// storage, the DNR rule, and the alarm. None of that is atomic, and the worker
// happily runs two of them at once.
//
// It does, in the one case that matters most. A dead worker is woken *by* the
// unlock message, so the startup reconcile() and the unlock handler start
// within a turn of each other. reconcile() reads grants before unlock() writes
// one, concludes the site should be shut, and calls relock() — whose
// clearGrant() then deletes the grant unlock() has just written. The unlock
// still reports ok, the rule still comes down, and the site opens with no grant
// on record and no alarm pending: no pill, no session on the gate page, and
// nothing to put the wall back until the next wake. That is not a rare
// interleaving — a negotiation with a clarifying question in it takes minutes,
// which is several times the ~30s the worker will idle before dying, so by
// redemption time the worker is reliably dead and the race is the normal path.
//
// So: one operation at a time, in the order they arrived. Each waits for the
// last to finish, which means each reads state the previous one has finished
// writing. The queue is worker-local, which is all it needs to be — the worker
// is the only writer of rules, alarms, and grants.
let workerLock = Promise.resolve();

function withWorkerLock(label, fn) {
  const run = workerLock.then(fn, fn);
  // The chain must survive a failed operation, or one rejection would strand
  // every operation after it. Callers still see their own rejection.
  workerLock = run.then(
    () => {},
    (err) => {
      console.error(`[pinechar] ${label} failed inside the worker lock`, err);
    },
  );
  return run;
}

// Open the gate for the minutes the user chose, up to the minutes they earned.
//
// Order matters, and it is storage first. Every step after the grant write is
// re-derivable from it by reconcile(), so the only question at each await is
// what a worker death right there would leave behind:
//
//   crash after setGrant     — grant on record, rule still up. The site stays
//                              blocked and reconcile() opens it on the next
//                              wake. Fails closed.
//   crash after removeRule   — site open, grant on record, alarm missing.
//                              reconcile() re-arms it, and relocks outright if
//                              the expiry has already passed.
//
// The reverse order has no such story: removing the rule first and dying
// before the write leaves the site open with nothing recorded and no alarm
// pending, so nothing would ever put the wall back.
//
// Ordering only settles what a crash leaves behind, though. What a *concurrent*
// operation leaves behind is settled by withWorkerLock — without it, the
// reconcile() that runs on this very wake-up can delete the grant written two
// lines up.
async function unlockNow(domain, taken, granted) {
  const site = SITES[domain];
  if (!site) throw new Error(`unknown site: ${domain}`);

  const minutes = clampMinutes(taken, granted);
  if (minutes === null) {
    throw new Error(`unusable unlock minutes: taken=${taken}, granted=${granted}`);
  }

  const expiresAt = Date.now() + minutes * 60_000;
  await setGrant(domain, expiresAt);
  await removeRule(domain);
  await chrome.alarms.create(ALARM_PREFIX + domain, { when: expiresAt });
  // `minutes` goes back out because it is what actually happened — the page
  // asked, the wall decided, and the ledger records the wall's answer rather
  // than the page's request.
  return { expiresAt, minutes, domain: site.domain };
}

// Every path back to the blocked state goes through here — the expiry alarm and
// reconcile() both call it — so eviction lands in both cases from one place.
//
// Takes the lock via relock(); reconcile() calls this inner form because it is
// already holding it.
async function relockNow(key) {
  // Rule first: if eviction ran first, a tab could navigate back in through the
  // window before the rule exists.
  await addRule(key);
  await clearGrant(key);
  await chrome.alarms.clear(ALARM_PREFIX + key);

  // Eviction is best-effort and deliberately last. Re-blocking is the part that
  // must not fail, so a tabs error can't be allowed to propagate out of here.
  try {
    await evictTabs(key);
  } catch (err) {
    console.error("[pinechar] eviction failed for", key, err);
  }
}

// Runs on every worker startup. Storage is the source of truth; the rule table
// and the alarm are both derived from it and re-derived here.
//
// This is the operation most likely to collide with another, because the thing
// that woke the worker is usually a message that wants to change exactly what
// reconcile is rebuilding. Holding the lock means it either runs before that
// message's handler and sees a stale-but-consistent world, or after it and sees
// the change — never halfway through it.
async function reconcileNow() {
  const grants = await getGrants();
  const now = Date.now();

  for (const key of Object.keys(SITES)) {
    const expiresAt = grants[key];
    if (isActive(expiresAt, now)) {
      // Grant is still live: keep the site reachable, and re-arm the alarm in
      // case it was dropped by an extension reload or update.
      await removeRule(key);
      await chrome.alarms.create(ALARM_PREFIX + key, { when: expiresAt });
    } else {
      // Expired or never granted — including the case where the alarm never
      // fired because the browser was closed through the expiry. relock()
      // evicts, which catches session-restored tabs that came back up on the
      // site after their grant had already lapsed.
      await relockNow(key);
    }
  }
}

// The public forms. Everything that reaches the worker from outside — a
// message, an alarm, a startup — enters through one of these and therefore
// through the queue.
const unlock = (domain, taken, granted) =>
  withWorkerLock("unlock", () => unlockNow(domain, taken, granted));
const relock = (key) => withWorkerLock("relock", () => relockNow(key));
const reconcile = () => withWorkerLock("reconcile", () => reconcileNow());

// ---------------------------------------------------------------------------
// Dev reset
// ---------------------------------------------------------------------------

// What a history wipe must not touch: the things the user typed, and the live
// grant. Everything else in storage is negotiation history.
//
// A preserve-list rather than a delete-list on purpose — claims and today's
// events aren't their own keys, they live inside ledger entries, and whatever
// history key gets added next should be cleared by this without anyone
// remembering to come back here.
const PRESERVED_KEYS = [GRANTS_KEY, "goalsText", "savedAt", "settings"];

// Deliberately does not touch rules, alarms, or grants: clearing history during
// an active session leaves that session running.
async function resetHistory() {
  const all = await chrome.storage.local.get(null);
  const cleared = Object.keys(all).filter((key) => !PRESERVED_KEYS.includes(key));
  const events = Array.isArray(all[LEDGER_KEY]) ? all[LEDGER_KEY].length : 0;

  await chrome.storage.local.remove(cleared);
  console.log("[pinechar] history reset:", { cleared, events });
  return { ok: true, cleared, events };
}

// runtime.sendMessage skips the sender's own listener, so the message below is
// for the popup and the gate page. From the worker console the one-liner is the
// function itself: `await resetHistory()`.
self.resetHistory = resetHistory;

// Nothing below awaits these, so without a catch a rejection would surface as a
// bare unhandled-rejection with no hint of which path produced it.
const report = (what) => (err) => console.error(`[pinechar] ${what} failed`, err);

// Listeners are registered synchronously at the top level so Chrome knows which
// events should wake a stopped worker.
chrome.runtime.onInstalled.addListener(() => {
  console.log("[pinechar] onInstalled");
  reconcile().catch(report("reconcile/onInstalled"));
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[pinechar] onStartup");
  reconcile().catch(report("reconcile/onStartup"));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  console.log("[pinechar] alarm fired:", alarm.name);
  relock(alarm.name.slice(ALARM_PREFIX.length)).catch(report("relock/alarm"));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "unlock") {
    // msg.minutes is what the user chose to take; msg.granted is the ceiling
    // the judge paid out. Both are required — see clampMinutes.
    unlock(msg.site, msg.minutes, msg.granted)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async sendResponse
  }

  // The gate page needs the domain to offer a link during an active session,
  // which happens without an unlock. SITES stays the one place it's written
  // down rather than being duplicated into the page.
  if (msg?.type === "reset_history") {
    resetHistory()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg?.type === "siteInfo") {
    const site = SITES[msg.site];
    sendResponse(
      site ? { ok: true, domain: site.domain } : { ok: false, error: `unknown site: ${msg.site}` },
    );
  }
});

// Also runs on a plain wake-up, which is neither onInstalled nor onStartup.
// If you don't see this line in the worker console, the script never evaluated.
console.log("[pinechar] worker evaluated, listeners registered");
reconcile().catch(report("reconcile/startup"));
