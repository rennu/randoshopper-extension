// Bridges the page-world script (no extension APIs) to the background worker.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.data?.type !== "randoshopper-request") return;
  const { id, payload } = ev.data;
  chrome.runtime.sendMessage({ type: "randoshopper-fetch", payload }, (res) => {
    const err = chrome.runtime.lastError;
    window.postMessage(
      { type: "randoshopper-response", id, ...(err ? { ok: false, error: err.message } : res) },
      "*"
    );
  });
});
