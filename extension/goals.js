const textarea = document.getElementById("goals");
const saveButton = document.getElementById("save");
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

load();
