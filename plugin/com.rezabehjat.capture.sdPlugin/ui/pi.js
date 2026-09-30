/* Property Inspector for all Capture actions (plain JS, no network access needed). */
(function () {
  "use strict";
  const C = window.CAPTURE;
  const $ = (id) => document.getElementById(id);
  let ws, uuid, actionUUID = "", settings = {};
  let commands = [];
  let loaded = false;

  // ---------------------------------------------------------------- plumbing
  window.connectElgatoStreamDeckSocket = function (port, inUUID, registerEvent, _info, actionInfoJson) {
    uuid = inUUID;
    const ai = JSON.parse(actionInfoJson);
    actionUUID = ai.action || "";
    settings = (ai.payload && ai.payload.settings) || {};
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: registerEvent, uuid }));
      ws.send(JSON.stringify({ event: "getSettings", context: uuid }));
      setup();
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event === "didReceiveSettings") {
        settings = (msg.payload && msg.payload.settings) || {};
        render();
      } else if (msg.event === "sendToPropertyInspector") {
        onPlugin(msg.payload || {});
      }
    };
  };

  function save(patch) {
    Object.assign(settings, patch);
    for (const k of Object.keys(settings)) if (settings[k] === undefined) delete settings[k];
    ws.send(JSON.stringify({ event: "setSettings", context: uuid, payload: settings }));
  }
  function toPlugin(payload) {
    ws.send(JSON.stringify({ event: "sendToPlugin", action: actionUUID, context: uuid, payload }));
  }

  const ALL = ["command", "tab", "slot", "position", "dial", "toggle", "ncmd", "ndial", "ntoggle"];
  // Generic actions end in their kind (…capture.dial). Generated ones: …capture.cmd.<category>.<id>, …capture.dial.<property>, …capture.toggle.<property>.
  const kind = () => {
    const p = actionUUID.split(".");
    if (p.length === 6 && p[3] === "cmd") return p[4] === "tabs" ? "ntab" : "ncmd";
    if (p.length === 5 && p[3] === "dial") return "ndial";
    if (p.length === 5 && p[3] === "toggle") return "ntoggle";
    return p[p.length - 1];
  };
  const namedProp = () => C.properties.find((p) => p.slug === actionUUID.split(".")[4]);
  const show = (id, on) => $(id).classList.toggle("hidden", !on);
  const num = (v) => (v === "" || v === null || v === undefined || isNaN(Number(v)) ? undefined : Number(v));
  const option = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };

  function fillSelect(sel, items) {
    sel.innerHTML = "";
    items.forEach(([v, t]) => sel.appendChild(option(v, t)));
  }

  // ---------------------------------------------------------------- setup (once)
  function setup() {
    const k = kind();
    ALL.forEach((s) => show("s-" + s, s === k));
    show("none", !ALL.includes(k));
    if (k === "ntab") $("none").textContent = "This key switches Capture to a tab. Nothing to configure.";

    if (k === "command") {
      $("cmd").onchange = onPickCommand;
      $("reload").onclick = () => { setStatus("Reading Capture's menus…"); toPlugin({ cmd: "listMenus", force: true }); };  // Refresh
      $("path").onchange = onPathEdited;
      $("match").onchange = onPathEdited;
      $("hold").onchange = () => save({ holdToFire: $("hold").checked });
      $("dim").onchange = () => save({ dimWhenDisabled: $("dim").checked });
      $("label").onchange = () => save({ label: $("label").value.trim() || undefined });
      setStatus("Reading Capture's menus…");
      toPlugin({ cmd: "listMenus", force: false });
    }
    if (k === "ncmd") {
      $("nhold").onchange = () => save({ holdToFire: $("nhold").checked });
      $("ndim").onchange = () => save({ dimWhenDisabled: $("ndim").checked });
    }
    if (k === "ndial") {
      fillSelect($("ndview"), Object.entries(C.views));
      $("ndview").onchange = () => save({ view: $("ndview").value });
      $("ndstep").onchange = () => save({ step: num($("ndstep").value) });
      $("ndreset").onchange = () => save({ reset: num($("ndreset").value) });
    }
    if (k === "ntoggle") {
      fillSelect($("ntview"), Object.entries(C.views));
      $("ntview").onchange = () => save({ view: $("ntview").value });
    }
    if (k === "tab") {
      fillSelect($("tab"), C.tabs.map((t) => [t, t]));
      $("tab").onchange = () => save({ tab: $("tab").value });
    }
    if (k === "slot") {
      fillSelect($("slot"), [1, 2, 3, 4, 5].map((n) => [String(n), "Slot " + n]));
      $("slot").onchange = () => save({ slot: Number($("slot").value) });
    }
    if (k === "position") {
      fillSelect($("pview"), Object.entries(C.views));
      $("mode").onchange = () => { save({ mode: $("mode").value }); render(); };
      for (const id of ["catalog", "position", "index", "time", "damp", "curve"]) $(id).onchange = () => save({ [id]: num($(id).value) });
      $("pview").onchange = () => save({ view: $("pview").value });
      $("reload-cats").onclick = () => toPlugin({ cmd: "listCatalogs" });
    }
    if (k === "dial") {
      fillSelect($("dprop"), C.properties.filter((p) => p.kind === "number").map((p) => [p.id, p.label]));
      fillSelect($("dview"), Object.entries(C.views));
      $("dprop").onchange = () => { save({ property: $("dprop").value, step: undefined, reset: undefined }); render(); };
      $("dview").onchange = () => save({ view: $("dview").value });
      $("dstep").onchange = () => save({ step: num($("dstep").value) });
      $("dreset").onchange = () => save({ reset: num($("dreset").value) });
    }
    if (k === "toggle") {
      fillSelect($("tprop"), C.properties.filter((p) => p.kind === "bool").map((p) => [p.id, p.label]));
      fillSelect($("tview"), Object.entries(C.views));
      $("tprop").onchange = () => save({ property: $("tprop").value });
      $("tview").onchange = () => save({ view: $("tview").value });
    }
    render();
  }

  // ---------------------------------------------------------------- render from settings
  const pathStr = (p) => (Array.isArray(p) ? p.join(" > ") : "");
  const holdDefault = (p) => {
    const last = String((p || [])[(p || []).length - 1] || "").replace(/(…|\.\.\.)$/, "").trim().toLowerCase();
    const inPath = (re) => (p || []).some((x) => re.test(String(x).replace(/(…|\.\.\.)$/, "").trim()));
    if (last === "clear" && inPath(/^plot adjustments$/i)) return true;
    if (/^import\b/.test(last) || inPath(/^import\b/i)) return true;
    return C.holdByDefault.some((n) => n.toLowerCase() === last);
  };
  const keyOf = (path, match) => JSON.stringify([path, match || "exact"]);

  function render() {
    const k = kind();
    if (k === "command") {
      $("path").value = pathStr(settings.menuPath);
      $("match").value = settings.match || "exact";
      $("match-hint").textContent =
        ($("match").value === "prefix") ? "Matches the item whose name starts with the last element (for titles that change, like “Undo Live”)."
        : ($("match").value === "alternates") ? "Separate names with | — the first item that exists is used (e.g. Enter Full Screen|Exit Full Screen)."
        : "";
      $("hold").checked = settings.holdToFire !== undefined ? !!settings.holdToFire : holdDefault(settings.menuPath);
      $("dim").checked = settings.dimWhenDisabled !== false;
      $("label").value = settings.label || "";
      syncDropdown();
    }
    if (k === "ncmd") {
      const c = C.commands[actionUUID] || { path: [], hold: false };
      $("ncmd-what").textContent = "Fires " + c.path.join(" › ").replace("|", " / ") + " in Capture. Nothing to configure.";
      const w = $("ncmd-warn");
      w.classList.toggle("hidden", !c.unverified);
      w.textContent = c.unverified ? "This menu path is a best guess from the description of Capture's File menu. If the key shows “?”, use Capture Command to pick it from the live menus." : "";
      $("nhold").checked = settings.holdToFire !== undefined ? !!settings.holdToFire : !!c.hold;
      $("ndim").checked = settings.dimWhenDisabled !== false;
    }
    if (k === "ndial") {
      const p = namedProp() || C.properties[0];
      $("ndview").value = settings.view || "live";
      $("ndstep").value = settings.step ?? "";
      $("ndstep").placeholder = String(p.step);
      $("ndreset").value = settings.reset ?? "";
      $("ndreset").placeholder = String(p.reset);
      const unit = { percent: "1.0 = 100 %", ev: "EV", kelvin: "K", degrees: "degrees", count: "whole number" }[p.unit];
      $("ndial-hint").textContent = p.label + ": range " + p.min + " … " + p.max + " (" + unit + "). Step and reset are in these units.";
    }
    if (k === "ntoggle") $("ntview").value = settings.view || "live";
    if (k === "tab") $("tab").value = settings.tab || "Design";
    if (k === "slot") $("slot").value = String(settings.slot || 1);
    if (k === "position") {
      $("mode").value = settings.mode || "fixed";
      $("catalog").value = settings.catalog ?? 1;
      $("position").value = settings.position ?? 1;
      $("index").value = settings.index ?? 1;
      $("time").value = settings.time ?? "";
      $("damp").value = settings.damp ?? "";
      $("curve").value = settings.curve ?? "";
      $("pview").value = settings.view || "live";
      show("row-position", $("mode").value === "fixed");
      show("row-index", $("mode").value === "auto");
      $("pos-hint").textContent = $("mode").value === "auto"
        ? "Shows and recalls the k-th position of this catalog in whatever show is open."
        : "Catalog and position numbers as Capture lists them (1–255).";
    }
    if (k === "dial") {
      const p = C.properties.find((x) => x.id === (settings.property || "exposureAdjustment")) || C.properties[0];
      $("dprop").value = p.id;
      $("dview").value = settings.view || "live";
      $("dstep").value = settings.step ?? "";
      $("dstep").placeholder = String(p.step);
      $("dreset").value = settings.reset ?? "";
      $("dreset").placeholder = String(p.reset);
      const unit = { percent: "1.0 = 100 %", ev: "EV", kelvin: "K", degrees: "degrees", count: "whole number" }[p.unit];
      $("dial-hint").textContent = "Range " + p.min + " … " + p.max + " (" + unit + "). Step and reset are in these units.";
    }
    if (k === "toggle") {
      $("tprop").value = settings.property || "automaticExposure";
      $("tview").value = settings.view || "live";
    }
  }

  // ---------------------------------------------------------------- command list
  function setStatus(t) { $("cmd-status").textContent = t; }

  function buildCommandList() {
    const sel = $("cmd");
    sel.innerHTML = "";
    sel.appendChild(option("", "— choose a command —"));
    const groups = new Map();
    commands.forEach((c, i) => {
      const top = c.path[0];
      if (!groups.has(top)) { const g = document.createElement("optgroup"); g.label = top; groups.set(top, g); sel.appendChild(g); }
      const rest = c.label.split(" › ").slice(1).join(" › ");
      groups.get(top).appendChild(option(String(i), rest + (c.enabled ? "" : "  (disabled now)")));
    });
    sel.appendChild(option("custom", "Custom path (typed below)"));
    syncDropdown();
  }

  function syncDropdown() {
    if (!loaded) return;
    const sel = $("cmd");
    const want = keyOf(settings.menuPath, settings.match);
    const i = commands.findIndex((c) => keyOf(c.path, c.match) === want);
    sel.value = i >= 0 ? String(i) : (settings.menuPath && settings.menuPath.length ? "custom" : "");
  }

  function onPickCommand() {
    const v = $("cmd").value;
    if (v === "" || v === "custom") return;
    const c = commands[Number(v)];
    // holdToFire follows the command's default unless the user has chosen otherwise before
    save({ menuPath: c.path, match: c.match, holdToFire: undefined });
    render();
  }

  function onPathEdited() {
    const parts = $("path").value.split(">").map((s) => s.trim()).filter(Boolean);
    save({ menuPath: parts.length >= 2 ? parts : undefined, match: $("match").value });
    render();
  }

  // ---------------------------------------------------------------- messages from the plugin
  function onPlugin(p) {
    if (p.event === "menus") {
      loaded = true;
      commands = p.commands || [];
      buildCommandList();
      const err = $("cmd-err");
      err.classList.toggle("hidden", !p.error);
      err.textContent = p.error || "";
      setStatus(commands.length ? commands.length + " commands read from Capture's menu bar." : "");
    }
    if (p.event === "catalogs") {
      const err = $("cat-err");
      err.classList.toggle("hidden", !p.error);
      err.textContent = p.error || "";
      $("cat-list").textContent = "";
      (p.catalogs || []).forEach((c) => {
        const d = document.createElement("div");
        d.textContent = "Catalog " + c.nr + ": " + (c.name || "(unnamed)") + " — " + c.positions.map((x, i) => (i + 1) + "/" + x.nr + " " + (x.name || "?")).join(", ");
        $("cat-list").appendChild(d);
      });
    }
  }
})();
