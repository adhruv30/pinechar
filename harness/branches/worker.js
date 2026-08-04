// background.js — the walls, and the grant record they derive from.

const { branch, group, expect } = require("../runner.js");
const { createChrome, tick } = require("../fake-chrome.js");
const { wakeWorker } = require("../load.js");

const RULE_ID = 1;
const ALARM = "relock:instagram";

const settle = async (n = 80) => {
  for (let i = 0; i < n; i++) await tick();
};

// A worker that has been asleep: nothing is running, and the next message is
// what wakes it. Returns without awaiting the startup reconcile(), because the
// whole point of several branches below is what happens when a message lands
// while that reconcile is still in flight.
function wake({ storage = {}, tabs = [], blocked = true } = {}) {
  const logs = [];
  const env = createChrome({ storage, tabs });
  if (blocked) {
    // The DNR rule survives worker death, so a cold worker starts with the wall
    // already up.
    env.state.rules.set(RULE_ID, { id: RULE_ID });
  }
  const capture = {
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => logs.push(`ERROR ${args.join(" ")}`),
  };
  wakeWorker({ chrome: env.chrome, console: capture });
  return { env, logs };
}

group("worker: grant record");

branch("unlock writes a schema-valid grant under the site key", async () => {
  const { env } = wake();
  await settle();

  const before = Date.now();
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
  });
  await settle();

  expect.is(res.ok, true, "unlock reported failure");
  const grants = env.grants();
  expect.eq(Object.keys(grants), ["instagram"], "grants must be keyed by site key, not domain");
  expect.is(typeof grants.instagram, "number", "expiresAt must be a bare number (epoch ms)");
  expect.ok(
    grants.instagram >= before + 20 * 60_000 && grants.instagram <= Date.now() + 20 * 60_000,
    "expiresAt must be now + minutes, absolute",
  );
  expect.is(res.expiresAt, grants.instagram, "response expiry must match what was stored");
});

branch("unlock takes the wall down and arms the relock alarm", async () => {
  const { env } = wake();
  await settle();
  await env.chrome.runtime.sendMessage({ type: "unlock", site: "instagram", minutes: 20 });
  await settle();

  expect.is(env.hasRule(RULE_ID), false, "site should be reachable during a grant");
  expect.is(env.alarmFor(ALARM), env.grants().instagram, "alarm must fire at the expiry");
});

// The bug this harness was written for.
//
// A negotiation with a clarifying question in it runs for minutes, and an MV3
// worker dies after ~30s idle. So by the time the user types the code, the
// worker is dead and the unlock message is what wakes it — putting the startup
// reconcile() and the unlock handler in flight at the same time. reconcile()
// reads grants before unlock() writes one, decides the site should be shut, and
// relock()'s clearGrant() deletes the grant that unlock() just wrote.
//
// The unlock still answers ok and the rule still comes down, so the site opens
// and looks granted — with no grant on record. The pill never appears.
group("worker: unlock racing the wake-up reconcile");

branch("clarifying-question path: grant survives the reconcile that woke with it", async () => {
  const { env } = wake({ tabs: [{ id: 7, url: "https://www.instagram.com/" }] });

  // No settle(): the message arrives mid-reconcile, exactly as it does when the
  // message is the thing that started the worker.
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
  });
  await settle();

  expect.is(res.ok, true, "unlock reported failure");
  expect.is(
    typeof env.grants()?.instagram,
    "number",
    "grant was erased by the concurrent reconcile — the overlay would render nothing",
  );
  expect.is(env.hasRule(RULE_ID), false, "site should be reachable after a successful unlock");
  expect.is(
    env.alarmFor(ALARM),
    env.grants().instagram,
    "relock alarm was cleared by the concurrent reconcile — the session would never end",
  );
});

branch("direct path: same race when the worker was already awake", async () => {
  const { env } = wake();
  await settle(); // reconcile finishes first — the easy ordering

  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
  });
  await settle();

  expect.is(res.ok, true, "unlock reported failure");
  expect.is(typeof env.grants()?.instagram, "number", "grant missing after a plain unlock");
  expect.is(env.hasRule(RULE_ID), false, "site should be reachable");
});

branch("two unlocks in flight leave one coherent grant", async () => {
  const { env } = wake();
  const [a, b] = await Promise.all([
    env.chrome.runtime.sendMessage({ type: "unlock", site: "instagram", minutes: 5 }),
    env.chrome.runtime.sendMessage({ type: "unlock", site: "instagram", minutes: 20 }),
  ]);
  await settle();

  expect.ok(a.ok && b.ok, "both unlocks should succeed");
  const stored = env.grants().instagram;
  expect.ok(
    stored === a.expiresAt || stored === b.expiresAt,
    "stored expiry must be one of the two writes, not a lost update",
  );
  expect.is(env.alarmFor(ALARM), stored, "alarm and grant must agree");
});

group("worker: reconcile and relock");

branch("reconcile leaves a live grant alone and re-arms its alarm", async () => {
  const expiresAt = Date.now() + 12 * 60_000;
  const { env } = wake({ storage: { grants: { instagram: expiresAt } } });
  await settle();

  expect.is(env.grants().instagram, expiresAt, "a live grant must survive a wake-up");
  expect.is(env.hasRule(RULE_ID), false, "a live grant must reopen the site");
  expect.is(env.alarmFor(ALARM), expiresAt, "a live grant must re-arm its alarm");
});

branch("reconcile relocks an expired grant and evicts the tab", async () => {
  const { env } = wake({
    storage: { grants: { instagram: Date.now() - 1000 } },
    tabs: [{ id: 7, url: "https://www.instagram.com/" }],
    blocked: false,
  });
  await settle();

  expect.eq(env.grants(), {}, "an expired grant must be cleared");
  expect.is(env.hasRule(RULE_ID), true, "the wall must go back up");
  expect.is(env.state.evictions.length, 1, "the open tab must be evicted");
  expect.match(env.state.evictions[0].url, /expired=true/, "eviction should land on the Time's up gate");
});

branch("a corrupt grants map fails closed and says so", async () => {
  const { env, logs } = wake({ storage: { grants: { instagram: "20 minutes" } } });
  await settle();

  expect.is(env.hasRule(RULE_ID), true, "an unreadable grant must leave the wall up");
  expect.ok(
    logs.some((line) => /divergence/.test(line)),
    "a grant-shape divergence must be logged loudly, not swallowed",
  );
});

branch("unknown site is refused rather than opening anything", async () => {
  const { env } = wake();
  await settle();
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "tiktok",
    minutes: 20,
  });
  await settle();

  expect.is(res.ok, false, "an unknown site must not unlock");
  expect.eq(env.grants() ?? {}, {}, "an unknown site must not be written to grants");
});

branch("a failed operation does not strand the queue", async () => {
  const { env } = wake();
  await settle();
  await env.chrome.runtime.sendMessage({ type: "unlock", site: "tiktok", minutes: 20 });
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
  });
  await settle();

  expect.is(res.ok, true, "a rejected operation must not block the ones behind it");
  expect.is(typeof env.grants().instagram, "number", "the following unlock must still land");
});
