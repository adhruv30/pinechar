// Countdown readout for an active session. Injected on every blocked domain;
// renders nothing unless this site has a live grant.
//
// The grant is read from storage exactly once. Everything after that is local
// arithmetic against expiresAt — no polling, no messaging, no wakeups. A
// sleeping service worker and a closed extension page both leave this ticking.

// The site list and the grant shape come from grant-schema.js, which the
// manifest loads immediately before this file — same isolated world, so it is
// simply on the global by the time this runs. This script does not get its own
// idea of either; that divergence is what kept the pill from ever appearing.
const { SITES, loadGrants, isActive, siteForHost } = self.PineCharGrants;

const RED_BELOW_MS = 60_000;
const MARKER = "data-pinechar-overlay";

// Top-right first, then around. Clicking the affordance walks this list, which
// is the whole escape hatch for the overlay covering something the user needs.
const CORNERS = [
  { top: "12px", right: "12px" },
  { bottom: "12px", right: "12px" },
  { bottom: "12px", left: "12px" },
  { top: "12px", left: "12px" },
];

function formatRemaining(ms) {
  // Ceil, so the last second reads 0:01 rather than flipping to 0:00 while a
  // second of access is still live.
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// The host element sits in Instagram's DOM, where a stray `div { position:
// static !important }` would be enough to break it. Its own layout properties
// are set !important for that reason; everything else is inside a shadow root
// the page's CSS can't reach.
function applyImportant(el, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    el.style.setProperty(prop, value, "important");
  }
}

function placeAt(host, index) {
  for (const side of ["top", "right", "bottom", "left"]) {
    host.style.removeProperty(side);
  }
  applyImportant(host, CORNERS[index]);
}

// Instagram is a single-page app. A route change re-renders whole subtrees, and
// a framework is free to sweep up a node it did not put there — this one. The
// content script does not run again on a client-side navigation, so once the
// host is detached it stays detached for the rest of the session, and the pill
// silently disappears partway through a grant.
//
// Watching documentElement's child list is enough: that is the only place the
// host is ever attached, and the observer fires whether the host was removed by
// itself or as part of a larger sweep. Re-appending inside the callback queues
// one more record, which then finds the host connected and stops — no loop.
function keepAttached(host) {
  const observer = new MutationObserver(() => {
    if (host.isConnected) return;
    document.documentElement.append(host);
  });
  observer.observe(document.documentElement, { childList: true });
  return observer;
}

function render(expiresAt) {
  const host = document.createElement("div");
  host.setAttribute(MARKER, "");

  applyImportant(host, {
    position: "fixed",
    "z-index": "2147483647",
    margin: "0",
    padding: "0",
    border: "0",
    width: "auto",
    height: "auto",
    // The overlay must never eat a click meant for the page underneath. The
    // corner-swap button opts back in individually.
    "pointer-events": "none",
  });

  let corner = 0;
  placeAt(host, corner);

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .pill {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px 5px 11px;
      border-radius: 999px;
      background: rgba(17, 17, 19, 0.82);
      color: #f2f3f5;
      font: 500 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.02em;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(6px);
      user-select: none;
      transition: background-color 200ms ease;
    }
    .pill.low {
      background: rgba(176, 32, 32, 0.9);
      color: #fff;
    }
    .swap {
      pointer-events: auto;
      cursor: pointer;
      width: 16px;
      height: 16px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.16);
      color: inherit;
      font: inherit;
      font-size: 10px;
      line-height: 16px;
      opacity: 0.75;
    }
    .swap:hover {
      opacity: 1;
    }
  `;

  const pill = document.createElement("div");
  pill.className = "pill";

  const time = document.createElement("span");
  time.textContent = formatRemaining(expiresAt - Date.now());

  const swap = document.createElement("button");
  swap.className = "swap";
  swap.textContent = "⇱";
  swap.title = "Move PineChar timer to another corner";
  swap.setAttribute("aria-label", "Move timer to another corner");
  swap.addEventListener("click", () => {
    corner = (corner + 1) % CORNERS.length;
    placeAt(host, corner);
  });

  pill.append(time, swap);
  shadow.append(style, pill);
  // documentElement, not body: Instagram re-renders its body subtree freely,
  // and client-side routing never reloads this script.
  document.documentElement.append(host);
  keepAttached(host);

  const ticker = setInterval(() => {
    const remaining = expiresAt - Date.now();
    time.textContent = formatRemaining(remaining);
    pill.classList.toggle("low", remaining < RED_BELOW_MS);

    if (remaining > 0) return;

    clearInterval(ticker);

    // Zero is a readout, not an action. Re-blocking deliberately does not
    // happen here: the relock alarm, the DNR rule, and tab eviction all live
    // in the service worker, which no page script can observe or reach. Moving
    // any of that into the page would put the wall in the one context
    // Instagram's own JS could in principle interfere with — and would fail
    // open entirely whenever this script failed to inject or was throttled in
    // a background tab. The worker evicts this tab a moment from now.
  }, 1000);

  pill.classList.toggle("low", expiresAt - Date.now() < RED_BELOW_MS);
}

async function start() {
  // An extension reload re-injects into live tabs; without this the overlays
  // stack up, each with its own interval.
  if (document.querySelector(`[${MARKER}]`)) return;

  const site = siteForHost(location.hostname);
  if (!site) {
    // The manifest matched this page but the schema doesn't know the host, so
    // content_scripts.matches and SITES have drifted apart. Silence here is how
    // a mismatch hides, so say it out loud.
    console.error(
      `[pinechar] overlay injected on ${location.hostname}, which is not a known ` +
        `site (known: ${Object.keys(SITES).join(", ")}). ` +
        `content_scripts.matches and SITES in grant-schema.js disagree.`,
    );
    return;
  }

  // loadGrants reports divergence itself, loudly. Anything it hands back here
  // matches the schema.
  const { grants } = await loadGrants(chrome.storage.local);
  const expiresAt = grants[site];

  // No grant, or one that lapsed while the page was loading. Either way the
  // worker is about to take this tab; nothing to draw.
  if (!isActive(expiresAt)) return;

  render(expiresAt);
}

start();
