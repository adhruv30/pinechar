const site = new URLSearchParams(location.search).get("site") ?? "instagram";
const button = document.getElementById("unlock");

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
