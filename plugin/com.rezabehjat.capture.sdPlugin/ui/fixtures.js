/* Property Inspector for "Fixtures: Setup" (plain JS, no network access needed). Talks to the plugin with {cmd: get | resync | set | clear | autofill}. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let ws, uuid, actionUUID = "";
  let view = null;
  let built = "";

  window.connectElgatoStreamDeckSocket = function (port, inUUID, registerEvent, _info, actionInfoJson) {
    uuid = inUUID;
    actionUUID = (JSON.parse(actionInfoJson) || {}).action || "";
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: registerEvent, uuid }));
      toPlugin({ cmd: "get" });
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event === "sendToPropertyInspector" && msg.payload && msg.payload.event === "setup") {
        view = msg.payload.view;
        showError(msg.payload.error);
        render();
      }
    };
  };
  function toPlugin(payload) {
    ws.send(JSON.stringify({ event: "sendToPlugin", action: actionUUID, context: uuid, payload }));
  }
  function showError(e) {
    $("err").textContent = e || "";
    $("err").classList.toggle("hidden", !e);
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** The fixtures to list: those with pan or tilt (and a channel list that parsed), or all with "show all". */
  function visible() {
    if (!view) return [];
    const all = $("all").checked;
    return view.fixtures.filter((f) => all || (f.parsed && f.hasPanTilt));
  }

  function render() {
    if (!view) return;
    $("blackout").textContent = view.blackoutWarning;
    const st = view.status;
    $("show").textContent =
      st === "ok" ? 'Show "' + (view.showName || "(unnamed)") + '" — ' + view.fixtures.length + " fixtures, " + view.controllable + " controllable" + (view.active ? ", output ON (universe " + view.universes.join(", ") + ")" : "")
      : st === "syncing" ? "Reading the show from Capture…"
      : st === "error" ? "The show could not be read: " + (view.error || "unknown error")
      : "The show has not been read yet.";
    const vis = visible();
    const hiddenCount = view.fixtures.length - vis.length;
    const bad = view.fixtures.filter((f) => !f.parsed).length;
    $("summary").textContent =
      vis.length + " listed" + (hiddenCount > 0 ? ", " + hiddenCount + " hidden (no pan/tilt or not readable; tick “Show all”)" : "") +
      (bad > 0 ? ". " + bad + " fixture(s) have a channel list that could not be read safely and can never be controlled (the reason is shown on each)." : "");

    // auto-fill: one entry per type among the listed fixtures
    const types = new Map();
    for (const f of vis) {
      const t = types.get(f.typeKey) || { name: f.name + " (" + f.mode + ", " + f.channelCount + " ch)", keys: [] };
      t.keys.push(f.key);
      types.set(f.typeKey, t);
    }
    const sel = $("fill-type");
    const prev = sel.value;
    sel.textContent = "";
    for (const [k, t] of types) {
      const o = el("option", "", t.name + " × " + t.keys.length);
      o.value = k;
      sel.appendChild(o);
    }
    if ([...types.keys()].includes(prev)) sel.value = prev;
    sel._types = types;

    // rows: rebuilt when the set of listed fixtures changes, otherwise updated in place (keeps the cursor in a field you are typing in)
    const sig = vis.map((f) => f.key).join("|");
    const list = $("list");
    if (sig !== built) {
      built = sig;
      list.textContent = "";
      for (const f of vis) list.appendChild(row(f));
    }
    for (const f of vis) update(f);
    if (!vis.length) list.textContent = st === "ok" ? "No fixture with pan or tilt in this show. Tick “Show all fixtures” to list the others." : "";
  }

  function row(f) {
    const r = el("div", "fx");
    r.dataset.key = f.key;
    r.appendChild(el("div", "l1", "Ch " + f.channel + "  " + f.name));
    r.appendChild(el("div", "l2", f.mode + " · " + f.channelCount + " ch · " + f.position));
    const l3 = el("div", "l3");
    const u = el("input");
    u.type = "number"; u.min = "1"; u.max = "16"; u.className = "u";
    const a = el("input");
    a.type = "number"; a.min = "1"; a.max = "512"; a.className = "a";
    const clear = el("button", "", "Clear");
    clear.style.flex = "0 0 auto";
    const commit = () => {
      const uv = u.value.trim(), av = a.value.trim();
      if (uv === "" && av === "") return toPlugin({ cmd: "clear", key: f.key });
      if (uv === "" || av === "") return; // wait for the other field
      toPlugin({ cmd: "set", key: f.key, universe: Number(uv), address: Number(av) });
    };
    u.onchange = commit;
    a.onchange = commit;
    clear.onclick = () => { u.value = ""; a.value = ""; toPlugin({ cmd: "clear", key: f.key }); };
    l3.append(el("label", "", "Universe"), u, el("label", "", "Address"), a, clear);
    r.appendChild(l3);
    r.appendChild(el("div", "st"));
    return r;
  }

  function update(f) {
    const r = document.querySelector('.fx[data-key="' + CSS.escape(f.key) + '"]');
    if (!r) return;
    const u = r.querySelector(".u"), a = r.querySelector(".a");
    if (document.activeElement !== u) u.value = f.addr ? String(f.addr.universe) : "";
    if (document.activeElement !== a) a.value = f.addr ? String(f.addr.address) : "";
    const st = r.querySelector(".st");
    st.className = "st";
    let text = "";
    if (f.issues.length) { st.classList.add("err"); text = "Not controllable: " + f.issues.join("; "); }
    else if (!f.parsed) { st.classList.add("err"); text = "Not controllable: channel list not read safely — " + f.parseError; }
    else if (f.controllable) { st.classList.add("ok"); text = "Controllable (" + f.addr.universe + "/" + f.addr.address + "–" + (f.addr.address + f.channelCount - 1) + ")"; }
    else text = "No address yet";
    if (f.parsed && f.notes.length) text += " · " + f.notes.length + " note(s) in the plugin log";
    st.textContent = text;
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("resync").onclick = () => { $("show").textContent = "Reading the show from Capture…"; toPlugin({ cmd: "resync" }); };
    $("all").onchange = () => { built = ""; render(); };
    $("fill-go").onclick = () => {
      const t = $("fill-type")._types && $("fill-type")._types.get($("fill-type").value);
      if (!t) return showError("Choose a fixture type first.");
      toPlugin({ cmd: "autofill", keys: t.keys, universe: Number($("fill-u").value), address: Number($("fill-a").value) });
    };
  });
})();
