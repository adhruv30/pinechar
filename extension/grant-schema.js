// The grant schema. One definition, three contexts.
//
// A grant is the single record that says a site is currently open. The service
// worker writes it, the gate page reads it to show "Session active", and the
// overlay content script reads it to draw the countdown pill. Those three run
// in three JS contexts that cannot import from one another, so each used to
// carry its own copy of the storage key, the value's shape, and the site list.
// Three copies of an assumption is three chances to disagree, and a reader that
// disagreed had no way to say so — it found `undefined`, took that for "no
// grant", and rendered nothing.
//
// So the shape is written down once, here, along with the only functions
// allowed to read or write it. Anything that touches grants goes through this
// file; the drift check in the harness asserts that nothing bypasses it.
//
// The stored shape, version 1:
//
//   chrome.storage.local["grants"] = { [siteKey]: expiresAtEpochMs }
//
//   siteKey       a key of SITES below — "instagram", not "instagram.com"
//   expiresAtMs   a finite number, epoch milliseconds, absolute
//
// A bare number rather than an object is deliberate: the expiry is the whole
// fact, and every consumer wants arithmetic against it. Loaded as a classic
// script in all three contexts (importScripts in the worker, <script src> in
// gate.html, first entry in the manifest's content_scripts.js), so: no module
// syntax, and it attaches itself to the global.

(function (root) {
  "use strict";

  // Bump when the stored shape changes, and give loadGrants() a migration.
  const SCHEMA_VERSION = 1;
  const GRANTS_KEY = "grants";

  // The site registry, and the source of truth for the domain list. ruleId must
  // be stable across restarts because dynamic DNR rules are addressed by ID.
  //
  // The manifest cannot read a JS object, so host_permissions and
  // content_scripts.matches still restate these domains — the drift check
  // asserts all of them against this object, which is the one that counts.
  const SITES = {
    instagram: { ruleId: 1, domain: "instagram.com" },
  };

  const SITE_KEYS = Object.keys(SITES);

  function typeName(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return `a ${typeof value}`;
  }

  // Every way a stored grants map can fail to be one, described in the terms
  // whoever has to fix it will need: which key, what was there, what belongs
  // there. Returns [] for a valid map, and for absent storage — never having
  // been written is not a divergence.
  function grantMapProblems(value) {
    if (value === undefined || value === null) return [];
    if (typeof value !== "object" || Array.isArray(value)) {
      return [`grants is ${typeName(value)}, expected an object keyed by site`];
    }

    const problems = [];
    for (const [key, entry] of Object.entries(value)) {
      if (!SITES[key]) {
        problems.push(
          `grants["${key}"] is not a known site key (known: ${SITE_KEYS.join(", ")}) — ` +
            `keys are site keys, not domains`,
        );
      }
      if (typeof entry !== "number") {
        problems.push(
          `grants["${key}"] is ${typeName(entry)}, expected a number ` +
            `(expiresAt, epoch ms)`,
        );
      } else if (!Number.isFinite(entry)) {
        problems.push(`grants["${key}"] is ${entry}, expected a finite epoch ms`);
      }
    }
    return problems;
  }

  function divergenceMessage(problems) {
    return `grant schema v${SCHEMA_VERSION} divergence: ${problems.join("; ")}`;
  }

  // Throwing form, for writers and for the drift check. A writer that drifts
  // should fail at the write, where the stack still points at the culprit.
  function assertGrantMap(value) {
    const problems = grantMapProblems(value);
    if (problems.length) throw new Error(divergenceMessage(problems));
    return value ?? {};
  }

  // Reading form. Never throws: a corrupt map must not take down the worker's
  // reconcile or a content script on someone's page. It screams instead, and
  // reports no grants — which is the fail-closed answer, since "no grant" means
  // the wall stays up.
  async function loadGrants(area) {
    const stored = await area.get(GRANTS_KEY);
    const raw = stored ? stored[GRANTS_KEY] : undefined;
    const problems = grantMapProblems(raw);

    if (problems.length) {
      console.error(
        `[pinechar] ${divergenceMessage(problems)} — ignoring stored grants. ` +
          `Every writer and reader must go through grant-schema.js.`,
      );
      return { grants: {}, divergence: divergenceMessage(problems) };
    }

    return { grants: raw ? { ...raw } : {}, divergence: null };
  }

  async function saveGrants(area, grants) {
    assertGrantMap(grants);
    await area.set({ [GRANTS_KEY]: grants });
  }

  function isActive(expiresAt, now) {
    const at = typeof now === "number" ? now : Date.now();
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > at;
  }

  // The one question the gate page and the overlay both ask: is this site open
  // right now, and until when? Returns the expiry, or null.
  async function activeGrant(area, siteKey, now) {
    const { grants } = await loadGrants(area);
    const expiresAt = grants[siteKey];
    return isActive(expiresAt, now) ? expiresAt : null;
  }

  // A hostname belongs to a site if it is the domain or a subdomain of it —
  // matching the `*://*.domain/*` patterns the manifest uses.
  function siteForHost(hostname) {
    return (
      SITE_KEYS.find((key) => {
        const domain = SITES[key].domain;
        return hostname === domain || hostname.endsWith(`.${domain}`);
      }) ?? null
    );
  }

  root.PineCharGrants = {
    SCHEMA_VERSION,
    GRANTS_KEY,
    SITES,
    SITE_KEYS,
    grantMapProblems,
    assertGrantMap,
    loadGrants,
    saveGrants,
    isActive,
    activeGrant,
    siteForHost,
  };
})(typeof self !== "undefined" ? self : globalThis);
