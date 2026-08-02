const textarea = document.getElementById("goals");
const saveButton = document.getElementById("save");
const resetButton = document.getElementById("reset");
const status = document.getElementById("status");

function describeSavedAt(savedAt) {
  return savedAt
    ? `Last saved ${new Date(savedAt).toLocaleString()}`
    : "Not saved yet.";
}

// Runs on every open. As a popup this page is torn down and rebuilt each time
// the toolbar icon is clicked, so storage is the only thing carrying state.
async function load() {
  const { goalsText = "", savedAt = null } = await chrome.storage.local.get([
    "goalsText",
    "savedAt",
  ]);
  textarea.value = goalsText;
  status.textContent = describeSavedAt(savedAt);
}

saveButton.addEventListener("click", async () => {
  const savedAt = Date.now();
  await chrome.storage.local.set({ goalsText: textarea.value, savedAt });
  status.textContent = describeSavedAt(savedAt);
});

// The worker owns the operation so there is exactly one definition of what
// "history" means; this is the same call the console one-liner makes.
resetButton.addEventListener("click", async () => {
  const confirmed = confirm(
    "Clear all negotiation history?\n\n" +
      "Requests, grants, denials, and claims are deleted. " +
      "Your goals, settings, and any active session are kept.",
  );
  if (!confirmed) return;

  resetButton.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "reset_history" });
  resetButton.disabled = false;

  status.textContent = res?.ok
    ? `History cleared — ${res.events} event${res.events === 1 ? "" : "s"} removed.`
    : `Clear failed: ${res?.error ?? "no response"}`;
});

load();
