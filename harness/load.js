// Loads the extension's real source files into a sandbox, unmodified.
//
// Nothing here transforms the code. If a branch passes, it passes against the
// bytes Chrome would load — the only thing swapped out is the platform
// underneath (chrome.*, the DOM, the clock).

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Overridable so a branch set can be pointed at a deliberately broken copy of
// the extension — the way to check that a branch still fails on the bug it was
// written for, which is the only thing that makes a passing run mean anything.
const EXTENSION_DIR =
  process.env.PINECHAR_EXTENSION_DIR ?? path.join(__dirname, "..", "extension");

function readSource(file) {
  return fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
}

// A service-worker-shaped global: `self` is the global object, and
// importScripts pulls a sibling file into this same context, exactly as the
// worker does with grant-schema.js.
function createWorkerContext({ chrome, console: consoleImpl = console }) {
  const sandbox = {
    chrome,
    console: consoleImpl,
    structuredClone,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  sandbox.importScripts = (...files) => {
    for (const file of files) {
      const name = path.basename(file);
      vm.runInContext(readSource(name), sandbox, { filename: name });
    }
  };

  return sandbox;
}

function runInContext(sandbox, file) {
  vm.runInContext(readSource(file), sandbox, { filename: file });
  return sandbox;
}

// Boots background.js the way a wake-up does: the script evaluates top to
// bottom, which registers the listeners and kicks off reconcile(). The returned
// promise resolves when that startup reconcile has settled, but callers that
// are testing the wake-up race deliberately do not await it before sending a
// message — a real message can arrive mid-reconcile.
function wakeWorker({ chrome, console: consoleImpl }) {
  const sandbox = createWorkerContext({ chrome, console: consoleImpl });
  runInContext(sandbox, "background.js");
  return sandbox;
}

// A page context: `self` is the window, and the content scripts load in the
// order the manifest lists them, into one shared isolated world.
//
// Pass `page` to inject again into a page that is already open. That models an
// extension reload, which re-injects into live tabs: same document, same
// clock, brand new isolated world.
function openBlockedPage({
  chrome,
  hostname = "www.instagram.com",
  startMs = Date.now(),
  console: consoleImpl = console,
  page,
}) {
  const { createDomEnvironment } = require("./fake-dom.js");
  const { document, clock, globals } = page ?? createDomEnvironment({ hostname, startMs });

  const sandbox = { chrome, console: consoleImpl, structuredClone, ...globals };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const manifest = JSON.parse(readSource("manifest.json"));
  for (const file of manifest.content_scripts[0].js) {
    vm.runInContext(readSource(file), sandbox, { filename: file });
  }

  return { document, clock, globals, sandbox };
}

module.exports = {
  EXTENSION_DIR,
  readSource,
  createWorkerContext,
  runInContext,
  wakeWorker,
  openBlockedPage,
};
