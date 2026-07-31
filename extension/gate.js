const params = new URLSearchParams(location.search);
const site = params.get("site") ?? "instagram";
const button = document.getElementById("unlock");

// Set when we pulled this tab off the site rather than blocking a fresh visit.
if (params.get("expired") === "true") {
  document.querySelector("h1").textContent = "Time's up";
}

// Remind me what I said I'd be doing instead.
chrome.storage.local.get("goalsText").then(({ goalsText }) => {
  const el = document.getElementById("goals");
  const text = goalsText?.trim();
  el.textContent = text || "No goals set yet — click the toolbar icon to add some.";
  el.classList.toggle("empty", !text);
});

button.addEventListener("click", async () => {
  button.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: "unlock",
    site,
    minutes: 2,
  });

  if (res?.ok) {
    // The rule is gone by the time we get here, so this navigation goes through.
    location.href = `https://${res.domain}`;
  } else {
    button.disabled = false;
    button.textContent = `Unlock failed: ${res?.error ?? "no response"}`;
  }
});
