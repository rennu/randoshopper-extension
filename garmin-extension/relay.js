// Bridges the page-world script (no extension APIs) to the background worker.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.data?.type !== "randoshopper-request") return;
  const { id, payload } = ev.data;
  const reply = (body) => window.postMessage({ type: "randoshopper-response", id, ...body }, "*");
  // After the extension is reloaded, this orphaned script throws "Extension context invalidated".
  try {
    chrome.runtime.sendMessage({ type: "randoshopper-fetch", payload }, (res) => {
      const err = chrome.runtime.lastError;
      reply(err || !res ? { ok: false, error: err ? err.message : "No response" } : res);
    });
  } catch (e) {
    reply({ ok: false, error: "Extension was reloaded. Refresh the page." });
  }
});

// Lets the page-world script find the logo URL (it has no chrome.* access).
try { document.documentElement.dataset.randoshopperLogo = chrome.runtime.getURL("logo.svg"); } catch (_) { /* orphaned script */ }
