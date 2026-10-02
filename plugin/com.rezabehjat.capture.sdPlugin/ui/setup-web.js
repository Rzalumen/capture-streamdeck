/* The browser page for "Fixtures: Setup". Every request to the plugin carries the token from this page's address (?t=...).
 * The table itself is in setup-core.js (shared with the Property Inspector). */
(function () {
  "use strict";
  const token = new URLSearchParams(location.search).get("t") || "";
  let core;
  let busy = 0;

  async function api(payload, quiet) {
    busy++;
    try {
      const r = await fetch("api?t=" + encodeURIComponent(token), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(r.status === 403 ? "this address is no longer valid — press Setup on the deck again" : "the plugin answered " + r.status);
      const j = await r.json();
      core.receive(j.view, quiet ? undefined : j.error);
    } catch (e) {
      core.showError("The plugin is not answering (" + e.message + "). Press Setup on the deck to open this page again.");
    } finally {
      busy--;
    }
  }

  core = window.SetupCore.start({ send: (p) => api(p, false) });
  api({ cmd: "get" }, false);
  // keep the page current (show read finishing, output state); a request still running is not overlapped
  setInterval(() => { if (!busy && !document.hidden) api({ cmd: "get" }, true); }, 2000);
})();
