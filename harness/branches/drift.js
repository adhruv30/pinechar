// The drift check.
//
// Facts that live in more than one file, asserted to still agree. Two kinds
// here: the domain list, which the manifest has to restate because JSON cannot
// read a JS object, and the grant record, which three contexts read and one
// writes. The second kind is what silently broke the pill — a reader that
// disagrees with the writer finds undefined, calls it "no grant", and draws
// nothing. Nothing crashes, nothing logs, and the feature is just gone.
//
// So the schema is asserted from both ends: the shape rejects divergent values
// loudly, and no file outside grant-schema.js is allowed to reach for the
// grants key on its own.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { branch, group, expect } = require("../runner.js");
const { EXTENSION_DIR, readSource } = require("../load.js");

const manifest = JSON.parse(readSource("manifest.json"));

// The schema in isolation — no chrome, no DOM. If it needs either to load, it
// is not loadable in all three contexts.
function loadSchema() {
  const sandbox = { console };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readSource("grant-schema.js"), sandbox, { filename: "grant-schema.js" });
  return sandbox.PineCharGrants;
}

const schema = loadSchema();
const domains = Object.values(schema.SITES).map((site) => site.domain).sort();

// The schema is loaded in its own realm, so its arrays and objects have that
// realm's prototypes and deepStrictEqual would reject them on identity alone.
// Copying into this realm compares the values, which is what the branch means.
const problemsFor = (value) => [...schema.grantMapProblems(value)];

// `*://*.instagram.com/*` -> `instagram.com`
const domainFromPattern = (pattern) => pattern.replace(/^\*:\/\/\*\./, "").replace(/\/\*$/, "");

group("drift: the domain list");

branch("host_permissions matches SITES", () => {
  expect.eq(
    manifest.host_permissions.map(domainFromPattern).sort(),
    domains,
    "host_permissions and SITES in grant-schema.js disagree",
  );
});

branch("content_scripts.matches matches SITES", () => {
  const matched = manifest.content_scripts.flatMap((entry) => entry.matches.map(domainFromPattern));
  expect.eq(
    matched.sort(),
    domains,
    "content_scripts.matches and SITES in grant-schema.js disagree — " +
      "the overlay would be injected where it has no grant to read, or not injected where it does",
  );
});

branch("every site has a unique, stable rule id", () => {
  const ids = Object.values(schema.SITES).map((site) => site.ruleId);
  expect.eq([...new Set(ids)].length, ids.length, "two sites share a DNR rule id");
  expect.ok(
    ids.every((id) => Number.isInteger(id) && id > 0),
    "rule ids must be positive integers",
  );
});

group("drift: the grant schema");

branch("all three contexts load the schema, and load it first", () => {
  expect.match(
    readSource("background.js"),
    /importScripts\(\s*["']\.\/grant-schema\.js["']\s*\)/,
    "the worker must importScripts grant-schema.js",
  );

  const contentScripts = manifest.content_scripts[0].js;
  expect.is(contentScripts[0], "grant-schema.js", "the schema must load before overlay.js");
  expect.ok(contentScripts.includes("overlay.js"), "overlay.js must still be a content script");

  const sources = [...readSource("gate.html").matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  expect.ok(sources.includes("grant-schema.js"), "gate.html must load grant-schema.js");
  expect.ok(
    sources.indexOf("grant-schema.js") < sources.indexOf("gate.js"),
    "gate.html must load the schema before gate.js",
  );
});

// The assertion that would have caught this bug at the source. Any file that
// reaches for the grants key itself is holding a second, unchecked copy of the
// schema — which is exactly the state the overlay was in.
branch("no file outside grant-schema.js reaches for the grants key", () => {
  const offenders = [];
  for (const file of fs.readdirSync(EXTENSION_DIR)) {
    if (!file.endsWith(".js") || file === "grant-schema.js") continue;
    const source = readSource(file);
    // The storage key as a literal, or a reach into a bag of storage for the
    // grants property. Indexing a map that loadGrants() handed back is fine —
    // that map has already been through the schema.
    if (/["']grants["']/.test(source) || /\.grants\b/.test(source)) {
      offenders.push(file);
    }
  }
  expect.eq(
    offenders,
    [],
    "these files reach past grant-schema.js for grants; route them through it " +
      "(loadGrants / saveGrants / activeGrant / isActive)",
  );
});

branch("the shape accepts what the worker writes", () => {
  const now = Date.now();
  expect.eq(problemsFor(undefined), [], "never-written storage is not a divergence");
  expect.eq(problemsFor({}), [], "an empty map is valid");
  expect.eq(problemsFor({ instagram: now + 60_000 }), [], "the canonical shape is valid");
  expect.is(schema.assertGrantMap({ instagram: now }).instagram, now, "assert should pass the map back");
});

branch("the shape rejects every way it has drifted or could", () => {
  const divergent = {
    "wrapped in an object": { instagram: { expiresAt: Date.now() } },
    "minutes instead of an epoch": { instagram: "20 minutes" },
    "keyed by domain": { "instagram.com": Date.now() },
    "a stringified number": { instagram: String(Date.now()) },
    "not a map at all": [Date.now()],
    "NaN": { instagram: NaN },
    "null entry": { instagram: null },
  };

  for (const [what, value] of Object.entries(divergent)) {
    expect.ok(
      problemsFor(value).length > 0,
      `divergent grants (${what}) must be reported, not accepted`,
    );
    expect.throws(
      () => schema.assertGrantMap(value),
      /grant schema v\d+ divergence/,
      `assertGrantMap must throw for ${what}`,
    );
  }
});

branch("divergence messages name the key and say what belongs there", () => {
  try {
    schema.assertGrantMap({ instagram: { expiresAt: 1 } });
    expect.ok(false, "expected a throw");
  } catch (err) {
    expect.match(err.message, /instagram/, "the message must name the offending key");
    expect.match(err.message, /expiresAt, epoch ms/, "the message must say what the value should be");
  }
});

branch("a writer that drifts fails at the write", async () => {
  const writes = [];
  const area = { async set(items) { writes.push(items); } };
  await expect.rejects(
    schema.saveGrants(area, { instagram: "soon" }),
    /divergence/,
    "saveGrants must refuse a malformed map",
  );
  expect.eq(writes, [], "nothing malformed may reach storage");
});

branch("a reader that meets divergence fails closed and loudly", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const area = { async get() { return { grants: { instagram: "soon" } }; } };
    const { grants, divergence } = await schema.loadGrants(area);
    expect.eq({ ...grants }, {}, "a divergent map must read as no grants — the wall stays up");
    expect.match(divergence, /divergence/, "the divergence must be reported to the caller");
  } finally {
    console.error = originalError;
  }
  expect.is(errors.length, 1, "divergence must reach the console exactly once");
});

branch("isActive is the only expiry comparison anyone needs", () => {
  const now = 1_000_000;
  expect.is(schema.isActive(now + 1, now), true, "a future expiry is active");
  expect.is(schema.isActive(now, now), false, "the expiry moment itself is over");
  expect.is(schema.isActive(undefined, now), false, "no grant is not active");
  expect.is(schema.isActive("later", now), false, "a non-number is not active");
});

branch("siteForHost covers the domain and its subdomains", () => {
  expect.is(schema.siteForHost("instagram.com"), "instagram", "bare domain must match");
  expect.is(schema.siteForHost("www.instagram.com"), "instagram", "subdomain must match");
  expect.is(schema.siteForHost("notinstagram.com"), null, "a suffix lookalike must not match");
  expect.is(schema.siteForHost("example.com"), null, "an unrelated host must not match");
});

group("drift: the dev reset");

branch("the reset preserves the live grant", () => {
  const source = readSource("background.js");
  const list = /const PRESERVED_KEYS = \[([^\]]*)\]/.exec(source);
  expect.ok(list, "PRESERVED_KEYS must still exist");
  expect.match(
    list[1],
    /GRANTS_KEY/,
    "clearing history must not close an open session — grants stays preserved",
  );
});

branch("gate.html and goals.html live where the manifest says", () => {
  expect.ok(
    fs.existsSync(path.join(EXTENSION_DIR, "gate.html")),
    "gate.html is the redirect target for every blocked navigation",
  );
  expect.is(manifest.action.default_popup, "goals.html", "the popup must still be the goals page");
  expect.ok(
    manifest.web_accessible_resources.some((entry) => entry.resources.includes("gate.html")),
    "gate.html must stay web-accessible",
  );
});
