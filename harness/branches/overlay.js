// overlay.js — the countdown pill on the blocked site.
//
// Every branch here drives the grant through the real worker first, so what the
// overlay reads is whatever background.js actually wrote. That coupling is the
// point: the bug these branches exist for was the reader and the writer holding
// different ideas about the record, which a test that seeded storage by hand
// would have sailed straight past.

const { branch, group, expect } = require("../runner.js");
const { createChrome, tick } = require("../fake-chrome.js");
const { wakeWorker, openBlockedPage } = require("../load.js");

const MARKER = "data-pinechar-overlay";

// The worker stamps expiries with the real clock, so the page starts on the
// real clock too and is then driven by hand. A fixed fake epoch here would put
// the page years away from the grant it is meant to be reading — which looks
// exactly like the bug under test and would make these branches lie.
const now = () => Date.now();

const settle = async (n = 80) => {
  for (let i = 0; i < n; i++) await tick();
};

const quiet = (sink) => ({
  log: (...args) => sink.push(args.join(" ")),
  error: (...args) => sink.push(`ERROR ${args.join(" ")}`),
});

// Grant 20 minutes the way the direct path does: the worker is up, the user
// argues once, redeems, and unlock lands on a live worker.
async function grantViaDirectPath(logs) {
  const env = createChrome();
  env.state.rules.set(1, { id: 1 });
  wakeWorker({ chrome: env.chrome, console: quiet(logs) });
  await settle();
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
    granted: 20,
  });
  await settle();
  return { env, res };
}

// The same 20 minutes via the clarifying-question path: the judge asked one
// question, the extra round trip outlasted the worker's ~30s idle timeout, and
// the unlock message is what wakes the worker back up.
async function grantViaQuestionPath(logs) {
  const env = createChrome();
  env.state.rules.set(1, { id: 1 });
  wakeWorker({ chrome: env.chrome, console: quiet(logs) });
  // Deliberately no settle: unlock lands while the wake-up reconcile is in
  // flight, which is what a dead-worker redemption looks like.
  const res = await env.chrome.runtime.sendMessage({
    type: "unlock",
    site: "instagram",
    minutes: 20,
    granted: 20,
  });
  await settle();
  return { env, res };
}

async function injectOverlay(env, { hostname = "www.instagram.com", logs = [], page } = {}) {
  const opened = openBlockedPage({
    chrome: env.chrome,
    hostname,
    startMs: now(),
    console: quiet(logs),
    page,
  });
  await settle(10);
  return opened;
}

const pillOf = (document) => {
  const host = document.querySelector(`[${MARKER}]`);
  if (!host) return null;
  // The root is closed, so the harness reads it through the side reference the
  // fake DOM keeps.
  return [...host.__shadow.walk()].find((el) => el.classList.contains("pill")) ?? null;
};

const readoutOf = (document) => pillOf(document)?.children[0]?.textContent ?? null;

group("overlay: renders for a real grant");

branch("direct negotiation path: pill shows the full grant", async () => {
  const logs = [];
  const { env, res } = await grantViaDirectPath(logs);
  expect.is(res.ok, true, "unlock failed before the overlay was even reached");

  const { document } = await injectOverlay(env, { logs });
  expect.ok(document.querySelector(`[${MARKER}]`), "no overlay host in the page");
  expect.is(readoutOf(document), "20:00", "pill should read the granted time");
  expect.eq(
    logs.filter((l) => l.startsWith("ERROR")),
    [],
    "the overlay should have nothing to complain about",
  );
});

branch("clarifying-question path: pill shows the full grant", async () => {
  const logs = [];
  const { env, res } = await grantViaQuestionPath(logs);
  expect.is(res.ok, true, "unlock failed before the overlay was even reached");

  const { document } = await injectOverlay(env, { logs });
  expect.ok(
    document.querySelector(`[${MARKER}]`),
    "no pill for a grant made through the clarifying-question path",
  );
  expect.is(readoutOf(document), "20:00", "pill should read the granted time");
});

branch("pill is attached to documentElement, above the page, click-through", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const { document } = await injectOverlay(env, { logs });

  const host = document.querySelector(`[${MARKER}]`);
  expect.is(host.parentNode, document.documentElement, "host must hang off documentElement");
  expect.is(host.style.getPropertyValue("position"), "fixed", "host must be fixed");
  expect.is(host.style.getPropertyPriority("position"), "important", "page CSS must not win");
  expect.is(host.style.getPropertyValue("pointer-events"), "none", "pill must not eat page clicks");
  expect.is(host.__shadow.mode, "closed", "the page must not be able to reach in");
});

branch("countdown ticks down and turns red under a minute", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const { document, clock } = await injectOverlay(env, { logs });

  // Stepped either side of the one-minute line rather than onto it: the grant
  // was stamped by the worker a sub-millisecond before this page's clock
  // started, so "exactly 60s left" is not a moment that reliably exists.
  clock.advance(18 * 60_000);
  expect.is(readoutOf(document), "2:00", "readout should follow the clock");
  expect.is(pillOf(document).classList.contains("low"), false, "two minutes left is not low");

  clock.advance(61_000);
  expect.is(readoutOf(document), "0:59", "readout should follow the clock");
  expect.is(pillOf(document).classList.contains("low"), true, "under a minute should go red");

  clock.advance(59_000);
  expect.is(readoutOf(document), "0:00", "expiry should read zero");
  expect.is(clock.pending(), 0, "the ticker should stop at zero rather than run forever");
});

group("overlay: renders nothing when it should not");

branch("no grant: nothing drawn, nothing logged", async () => {
  const logs = [];
  const env = createChrome();
  const { document } = await injectOverlay(env, { logs });
  expect.is(document.querySelector(`[${MARKER}]`), null, "pill drawn without a grant");
  expect.eq(logs.filter((l) => l.startsWith("ERROR")), [], "no grant is normal, not an error");
});

branch("expired grant: nothing drawn", async () => {
  const logs = [];
  const env = createChrome({ storage: { grants: { instagram: now() - 1 } } });
  const { document } = await injectOverlay(env, { logs });
  expect.is(document.querySelector(`[${MARKER}]`), null, "pill drawn for a lapsed grant");
});

branch("injected twice: one pill, one ticker", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const page = await injectOverlay(env, { logs });
  const before = page.clock.pending();

  // An extension reload re-injects into live tabs: the same page, a second
  // isolated world. The marker check in start() is what has to notice.
  await injectOverlay(env, { logs, page });

  const hosts = [...page.document.documentElement.children].filter((el) => el.hasAttribute(MARKER));
  expect.is(hosts.length, 1, "re-injection must not stack overlays");
  expect.is(page.clock.pending(), before, "re-injection must not start a second ticker");
});

branch("grant-shape divergence is loud, not silent", async () => {
  const logs = [];
  const env = createChrome({
    // What a writer that skipped the schema might leave behind.
    storage: { grants: { instagram: { expiresAt: now() + 60_000 } } },
  });
  const { document } = await injectOverlay(env, { logs });

  expect.is(document.querySelector(`[${MARKER}]`), null, "a malformed grant must not render");
  expect.ok(
    logs.some((l) => /divergence/.test(l) && /instagram/.test(l)),
    "a malformed grant must name itself in the console instead of rendering nothing quietly",
  );
});

branch("unknown host is loud too", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  await injectOverlay(env, { hostname: "example.com", logs });
  expect.ok(
    logs.some((l) => /not a known site/.test(l)),
    "an overlay injected somewhere SITES doesn't know about must say so",
  );
});

group("overlay: SPA persistence");

branch("re-appends after the page detaches it", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const { document } = await injectOverlay(env, { logs });

  const host = document.querySelector(`[${MARKER}]`);
  host.remove();
  expect.is(document.querySelector(`[${MARKER}]`), null, "precondition: host detached");

  await settle(5);
  expect.ok(document.querySelector(`[${MARKER}]`), "the pill must survive an SPA re-render");
  expect.is(readoutOf(document), "20:00", "the re-attached pill must be the same live one");
});

branch("survives repeated re-renders and keeps counting", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const { document, clock } = await injectOverlay(env, { logs });

  for (let i = 0; i < 5; i++) {
    document.querySelector(`[${MARKER}]`).remove();
    await settle(5);
  }

  const hosts = [...document.documentElement.children].filter((el) => el.hasAttribute(MARKER));
  expect.is(hosts.length, 1, "re-appending must not multiply the pill");

  clock.advance(60_000);
  expect.is(readoutOf(document), "19:00", "the surviving pill must still be ticking");
});

branch("re-append does not fight the page forever", async () => {
  const logs = [];
  const { env } = await grantViaDirectPath(logs);
  const { document } = await injectOverlay(env, { logs });

  // Re-appending is itself a mutation; if the observer reacted to its own work
  // it would spin. Nudging the tree while the host is connected must be inert.
  document.documentElement.append(document.createElement("div"));
  await settle(5);

  const hosts = [...document.documentElement.children].filter((el) => el.hasAttribute(MARKER));
  expect.is(hosts.length, 1, "an unrelated mutation must not duplicate the pill");
});
