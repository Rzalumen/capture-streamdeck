/* Setup table (plain JS) for the Property Inspector (fixtures.js).
 * SetupCore.start({send}) wires the page; send({cmd: get | resync | set | clear | autofill, ...}) goes to the plugin; the plugin's
 * answer is handed to the returned object's receive(view, error) (error: text, null = none, undefined = leave the shown error alone). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let view = null;
  let built = "";
  let send = () => undefined;
  // the row the last edit was on, and the error that edit got (shown right under that row as well as at the top)
  let lastKey = null;
  let rowError = null;
  const toPlugin = (p) => {
    lastKey = p.cmd === "set" || p.cmd === "clear" ? p.key : null;
    send(p);
  };

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
    const unp = el("div", "unproven hidden", "Check this type against Capture's patch view: the channel list parsed consistently, but the parser could not prove it is the only possible reading.");
    r.appendChild(unp);
    const det = el("details", "chans");
    det.appendChild(el("summary", "", "Channels"));
    det.appendChild(el("div", "chlist"));
    r.appendChild(det);
    return r;
  }

  /** The type's channel list (Handoff 20 §5): number, name, 8/16-bit, page. Rebuilt only when it changes, so an open list stays open. */
  function channels(r, f) {
    const det = r.querySelector(".chans");
    const t = view.types && view.types[f.typeKey];
    det.classList.toggle("hidden", !t);
    r.querySelector(".unproven").classList.toggle("hidden", !(t && t.unproven));
    if (!t) return;
    const sig = JSON.stringify(t.channels);
    if (det.dataset.sig === sig) return;
    det.dataset.sig = sig;
    det.querySelector("summary").textContent = "Channels (" + t.channels.length + ")" + (t.unproven ? " — check against Capture" : "");
    const box = det.querySelector(".chlist");
    box.textContent = "";
    const tbl = el("table", "chtbl");
    const head = el("tr");
    for (const h of ["#", "Name", "Bits", "Page"]) head.appendChild(el("th", "", h));
    tbl.appendChild(head);
    for (const c of t.channels) {
      const tr = el("tr", c.bits === "16-bit fine" ? "fine" : "");
      tr.appendChild(el("td", "n", String(c.n)));
      tr.appendChild(el("td", "", c.name));
      tr.appendChild(el("td", "b", c.bits === "8-bit" ? "8-bit" : c.bits === "16-bit" ? "16-bit (fine " + c.pair + ")" : "fine of " + c.pair));
      tr.appendChild(el("td", "p", c.page));
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
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
    if (rowError && rowError.key === f.key) { st.classList.remove("ok"); st.classList.add("err"); text = rowError.text; }
    if (f.parsed && f.notes.length) text += " · " + f.notes.length + " note(s) in the plugin log";
    st.textContent = text;
    channels(r, f);
  }

  function start(transport) {
    send = transport.send;
    $("resync").onclick = () => { $("show").textContent = "Reading the show from Capture…"; toPlugin({ cmd: "resync" }); };
    $("all").onchange = () => { built = ""; render(); };
    $("fill-go").onclick = () => {
      const t = $("fill-type")._types && $("fill-type")._types.get($("fill-type").value);
      if (!t) return showError("Choose a fixture type first.");
      toPlugin({ cmd: "autofill", keys: t.keys, universe: Number($("fill-u").value), address: Number($("fill-a").value) });
    };
    return {
      receive(v, error) {
        view = v;
        if (error !== undefined) {
          rowError = error && lastKey ? { key: lastKey, text: error } : null;
          showError(error);
        }
        render();
      },
      showError,
    };
  }

  window.SetupCore = { start };
})();
