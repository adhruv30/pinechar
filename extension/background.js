// Site registry. The key is what gate.html receives as ?site= and what unlock()
// takes as its `domain` argument; ruleId must be stable across restarts because
// dynamic rules are addressed by ID.
const SITES = {
  instagram: { ruleId: 1, domain: "instagram.com" },
};

const GRANTS_KEY = "grants";
const ALARM_PREFIX = "relock:";
const LEDGER_KEY = "ledger"; // written by gate.js; only read here for the count

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
  const stored = await chrome.storage.local.get(GRANTS_KEY);
  return stored[GRANTS_KEY] ?? {};
}

async function setGrant(key, expiresAt) {
  const grants = await getGrants();
  grants[key] = expiresAt;
  await chrome.storage.local.set({ [GRANTS_KEY]: grants });
}

async function clearGrant(key) {
  const grants = await getGrants();
  delete grants[key];
  await chrome.storage.local.set({ [GRANTS_KEY]: grants });
}

// Open the gate for `minutes`. The expiry is written to storage before the alarm
// is set, so a worker death between the two still leaves a record reconcile()
// can act on.
async function unlock(domain, minutes) {
  const site = SITES[domain];
  if (!site) throw new Error(`unknown site: ${domain}`);

  const expiresAt = Date.now() + minutes * 60_000;
  await removeRule(domain);
  await setGrant(domain, expiresAt);
  await chrome.alarms.create(ALARM_PREFIX + domain, { when: expiresAt });
  return { expiresAt, domain: site.domain };
}

// Every path back to the blocked state goes through here — the expiry alarm and
// reconcile() both call it — so eviction lands in both cases from one place.
async function relock(key) {
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
async function reconcile() {
  const grants = await getGrants();
  const now = Date.now();

  for (const key of Object.keys(SITES)) {
    const expiresAt = grants[key];
    if (expiresAt && expiresAt > now) {
      // Grant is still live: keep the site reachable, and re-arm the alarm in
      // case it was dropped by an extension reload or update.
      await removeRule(key);
      await chrome.alarms.create(ALARM_PREFIX + key, { when: expiresAt });
    } else {
      // Expired or never granted — including the case where the alarm never
      // fired because the browser was closed through the expiry. relock()
      // evicts, which catches session-restored tabs that came back up on the
      // site after their grant had already lapsed.
      await relock(key);
    }
  }
}

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
    unlock(msg.site, msg.minutes)
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
