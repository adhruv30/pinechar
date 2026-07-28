// Site registry. The key is what gate.html receives as ?site= and what unlock()
// takes as its `domain` argument; ruleId must be stable across restarts because
// dynamic rules are addressed by ID.
const SITES = {
  instagram: { ruleId: 1, domain: "instagram.com" },
};

const GRANTS_KEY = "grants";
const ALARM_PREFIX = "relock:";

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

async function relock(key) {
  await addRule(key);
  await clearGrant(key);
  await chrome.alarms.clear(ALARM_PREFIX + key);
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
      // fired because the browser was closed through the expiry.
      await relock(key);
    }
  }
}

// Listeners are registered synchronously at the top level so Chrome knows which
// events should wake a stopped worker.
chrome.runtime.onInstalled.addListener(() => {
  reconcile();
});

chrome.runtime.onStartup.addListener(() => {
  reconcile();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  relock(alarm.name.slice(ALARM_PREFIX.length));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "unlock") return;
  unlock(msg.site, msg.minutes)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async sendResponse
});

// Also runs on a plain wake-up, which is neither onInstalled nor onStartup.
reconcile();
