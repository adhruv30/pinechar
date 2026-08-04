// A chrome.* stub with the two properties that matter for finding real bugs:
// storage hands back copies rather than live references, and every async call
// resolves on a later turn of the event loop. Both are true of the real APIs,
// and a stub that skipped either would quietly hide read-modify-write races —
// the exact class of bug this harness exists to catch.

const { setImmediate } = require("node:timers");

// One turn of the loop. Every fake API call awaits this at least once, so two
// overlapping async functions interleave here the same way they would in the
// worker.
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The real storage serializes values in and out. Without this, a caller that
// mutates the object it read would be mutating the store itself, and a
// clobbering write would look like a successful one.
const copy = (value) => (value === undefined ? undefined : structuredClone(value));

function matchesPattern(pattern, url) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^\\\*:\\\/\\\//, "https?://")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function createChrome({ storage = {}, tabs = [], now = () => Date.now() } = {}) {
  const state = {
    storage: structuredClone(storage),
    rules: new Map(),
    alarms: new Map(),
    tabs: tabs.map((tab) => ({ ...tab })),
    // Every navigation the extension forced on a tab, in order.
    evictions: [],
    errors: [],
    logs: [],
  };

  const messageListeners = [];

  const local = {
    async get(query) {
      await tick();
      if (query === null || query === undefined) return copy(state.storage);
      const keys = Array.isArray(query) ? query : [query];
      const out = {};
      for (const key of keys) {
        if (key in state.storage) out[key] = copy(state.storage[key]);
      }
      return out;
    },
    async set(items) {
      await tick();
      for (const [key, value] of Object.entries(items)) {
        state.storage[key] = copy(value);
      }
    },
    async remove(keys) {
      await tick();
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete state.storage[key];
      }
    },
  };

  const chrome = {
    storage: { local },

    declarativeNetRequest: {
      async updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
        await tick();
        for (const id of removeRuleIds) state.rules.delete(id);
        for (const rule of addRules) {
          // The real API throws on a duplicate ID; background.js relies on
          // remove-then-add to stay idempotent, so the stub enforces it too.
          if (state.rules.has(rule.id)) {
            throw new Error(`duplicate dynamic rule id ${rule.id}`);
          }
          state.rules.set(rule.id, structuredClone(rule));
        }
      },
      async getDynamicRules() {
        await tick();
        return [...state.rules.values()];
      },
    },

    alarms: {
      async create(name, { when }) {
        await tick();
        state.alarms.set(name, when);
      },
      async clear(name) {
        await tick();
        return state.alarms.delete(name);
      },
      onAlarm: { addListener() {} },
    },

    tabs: {
      async query({ url }) {
        await tick();
        return state.tabs.filter((tab) => matchesPattern(url, tab.url));
      },
      async update(id, { url }) {
        await tick();
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`no such tab: ${id}`);
        tab.url = url;
        state.evictions.push({ id, url });
        return tab;
      },
    },

    runtime: {
      id: "harness",
      getURL: (path) => `chrome-extension://harness/${path.replace(/^\//, "")}`,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
      // Promise-flavoured sendMessage, as MV3 exposes it. Honours the
      // `return true` protocol so an async handler is actually awaited.
      sendMessage(message) {
        return new Promise((resolve, reject) => {
          if (messageListeners.length === 0) {
            reject(new Error("Could not establish connection."));
            return;
          }
          let answered = false;
          const sendResponse = (response) => {
            if (answered) return;
            answered = true;
            resolve(response);
          };
          for (const listener of messageListeners) {
            const keepOpen = listener(message, { id: "harness" }, sendResponse);
            if (keepOpen === true) return;
          }
          if (!answered) resolve(undefined);
        });
      },
    },
  };

  return {
    chrome,
    state,
    now,
    hasRule: (id) => state.rules.has(id),
    alarmFor: (name) => state.alarms.get(name) ?? null,
    grants: () => copy(state.storage.grants),
  };
}

module.exports = { createChrome, tick, matchesPattern };
