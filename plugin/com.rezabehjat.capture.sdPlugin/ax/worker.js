/*
 * Capture Accessibility worker  (osascript -l JavaScript worker.js)
 *
 * ONE long-running process. Reads newline-delimited JSON requests on stdin, drives Capture's menu bar through
 * System Events, writes one JSON reply per request on stdout:
 *     request   {"id":1,"op":"click","path":["View","Plot"],"match":"exact"}
 *     reply     {"id":1,"ok":true,"result":"OK","pid":1234}
 *               {"id":1,"ok":false,"error":{"message":"…","number":-25211,"internal":false}}
 *
 * What this worker may do to Capture (Handoff 07/08 rules):
 *   - read menus, their names and `enabled` state (any time; never activates Capture);
 *   - `click` ONE menu item ("click" op) or ONE of the six tab radio buttons ("tab" op), only when the plugin sends
 *     that op — the plugin only does so for a user's key press;
 *   - bring Capture to the front (frontmost = true) before a click if it isn't already. It never launches Capture.
 *   - it never synthesises mouse or keyboard events.
 *
 * `result` strings use the same vocabulary as the AppleScript fallback (src/lib/applescript.ts):
 *   click → "OK" | "DISABLED" | "NOTRUNNING";  tab → "OK" | "NOTAB" | "NOTRUNNING";
 *   enabled → "NOTRUNNING" | comma list of "1" | "0" | "?";  check → "OK" | "NOTRUNNING";
 *   menubar → item count | "NOTRUNNING";  dumpTop → TAB-separated "depth|enabled|encodedName|hasSub" records.
 *
 * The JS below avoids everything that isn't plain ECMAScript, apart from `Application`/`ObjC`/`$`, which only exist
 * inside osascript. `createHandler(SE, sleep)` is exported for Node so tests can drive it with a fake System Events.
 */
"use strict";

var PROCESS = "Capture";
var TABS = ["Design", "Fixtures", "Universes", "Media", "Snapshots", "Library"];
var INTERNAL_NAMES = { TypeError: 1, ReferenceError: 1, SyntaxError: 1, RangeError: 1 };

function createHandler(SE, sleep) {
  function getProc() {
    var p = SE.processes.byName(PROCESS);
    return p.exists() ? p : null;
  }

  function pidOf(p) {
    try {
      return p.unixId();
    } catch (e) {
      return undefined;
    }
  }

  function fail(message, number, extra) {
    var e = new Error(message);
    e.axNumber = number;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  function nameMatches(itemName, kind, cands) {
    if (itemName === null || itemName === undefined) return false;
    for (var i = 0; i < cands.length; i++) {
      if (kind === "prefix" ? String(itemName).indexOf(cands[i]) === 0 : itemName === cands[i]) return true;
    }
    return false;
  }

  /** The Menu object that holds the parents' children: menu bar item → submenus by exact name. */
  function menuOf(p, path, cache) {
    var key = path.join("\u0001");
    if (cache && cache[key]) return cache[key];
    var bar = p.menuBars[0];
    var topNames = bar.menuBarItems.name();
    var ti = topNames.indexOf(path[0]);
    if (ti < 0) throw fail("No such menu: " + path[0], -1728);
    var cur = bar.menuBarItems[ti].menus[0];
    for (var i = 1; i < path.length; i++) {
      var names = cur.menuItems.name();
      var idx = names.indexOf(path[i]);
      if (idx < 0) throw fail("No such submenu: " + path[i], -1728);
      cur = cur.menuItems[idx].menus[0];
    }
    if (cache) cache[key] = cur;
    return cur;
  }

  /** Finds the item and reports its enabled state. With a cache, each parent menu is read once for any number of targets. */
  function locate(p, target, cache) {
    var path = target.path;
    var parent = path.slice(0, -1);
    var last = path[path.length - 1];
    var cands = target.match === "alternates" ? last.split("|").map(function (s) { return s.trim(); }).filter(Boolean) : [last];
    var listKey = "L" + parent.join("\u0001");
    var info = cache && cache[listKey];
    if (!info) {
      var menu = menuOf(p, parent, cache);
      info = { menu: menu, names: menu.menuItems.name(), enabled: menu.menuItems.enabled() };
      if (cache) cache[listKey] = info;
    }
    var idx = -1;
    for (var i = 0; i < info.names.length && idx < 0; i++) if (nameMatches(info.names[i], target.match, cands)) idx = i;
    if (idx < 0) throw fail("No such menu item", -1728);
    return { item: info.menu.menuItems[idx], enabled: info.enabled[idx] === true };
  }

  function activate(p) {
    if (p.frontmost()) return;
    p.frontmost = true;
    for (var i = 0; i < 20; i++) {
      // wait until Capture is really in front (up to ~0.4 s), instead of a fixed delay
      if (p.frontmost()) break;
      sleep(0.02);
    }
  }

  function enc(name) {
    var s = name === null || name === undefined ? "" : String(name);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 32 || cp > 126 || cp === 124 || cp === 92) out += "\\u{" + cp.toString(16).toUpperCase() + "}";
      else out += s.charAt(i);
    }
    return out;
  }

  function dumpMenu(menu, lvl) {
    var out = "";
    var names = menu.menuItems.name();
    var enabled = menu.menuItems.enabled();
    for (var k = 0; k < names.length; k++) {
      var hasSub = false;
      var sub = "";
      var item = menu.menuItems[k];
      try {
        var subs = item.menus;
        if (subs.length > 0) {
          hasSub = true;
          sub = dumpMenu(subs[0], lvl + 1);
        }
      } catch (e) {
        if (e && e.name && INTERNAL_NAMES[e.name]) throw e;
        hasSub = false;
      }
      out += lvl + "|" + (enabled[k] === true ? "1" : "0") + "|" + enc(names[k]) + "|" + (hasSub ? "1" : "0") + "\t" + sub;
    }
    return out;
  }

  var ops = {
    hello: function () {
      return { result: "capture-ax-worker 1" };
    },
    check: function () {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      p.menuBars[0].menuBarItems.length; // touches Accessibility: throws when access is missing
      return { result: "OK", pid: pidOf(p) };
    },
    enabled: function (req) {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      var cache = {};
      var out = [];
      for (var i = 0; i < req.targets.length; i++) {
        try {
          out.push(locate(p, req.targets[i], cache).enabled ? "1" : "0");
        } catch (e) {
          if (e && e.axNumber !== -1728) throw e; // permission errors etc. surface; a missing item is just "?"
          out.push("?");
        }
      }
      return { result: out.join(","), pid: pidOf(p) };
    },
    click: function (req) {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      activate(p);
      var hit = locate(p, req, null);
      if (!hit.enabled) return { result: "DISABLED", pid: pidOf(p) };
      try {
        hit.item.click();
      } catch (e) {
        // The click was attempted: the plugin must not fall back and click again.
        if (e && typeof e === "object") e.clickAttempted = true;
        throw e;
      }
      return { result: "OK", pid: pidOf(p) };
    },
    tab: function (req) {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      if (TABS.indexOf(req.tab) < 0) throw fail("Unknown tab: " + req.tab, undefined);
      activate(p);
      var wins = p.windows;
      var n = wins.length;
      for (var i = 0; i < n; i++) {
        var button = null;
        try {
          var g = wins[i].tabGroups[0];
          button = g.radioButtons.byName(req.tab);
          button.name(); // throws if it isn't there
        } catch (e) {
          if (e && e.name && INTERNAL_NAMES[e.name]) throw e;
          if (e && /assistive access|-25211|-1743/i.test(String(e.message))) throw e;
          button = null;
        }
        if (button) {
          try {
            button.click();
          } catch (e2) {
            if (e2 && typeof e2 === "object") e2.clickAttempted = true;
            throw e2;
          }
          return { result: "OK", pid: pidOf(p) };
        }
      }
      return { result: "NOTAB", pid: pidOf(p) };
    },
    menubar: function () {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      return { result: String(p.menuBars[0].menuBarItems.length), pid: pidOf(p) };
    },
    dumpTop: function (req) {
      var p = getProc();
      if (!p) return { result: "NOTRUNNING" };
      var bar = p.menuBars[0];
      var names = bar.menuBarItems.name();
      var name = names[req.index];
      var text = name === null || name === undefined ? "" : String(name);
      var out = "0|1|" + enc(text) + "|1\t";
      if (text !== "Apple" && text !== PROCESS) out += dumpMenu(bar.menuBarItems[req.index].menus[0], 1);
      return { result: out, pid: pidOf(p) };
    },
  };

  /** Runs one request line; always returns a reply object (never throws). */
  return function handle(req) {
    var id = req && req.id;
    try {
      var op = ops[req.op];
      if (!op) return { id: id, ok: false, error: { message: "Unknown op: " + req.op, internal: true } };
      var r = op(req);
      var reply = { id: id, ok: true, result: r.result };
      if (r.pid !== undefined) reply.pid = r.pid;
      return reply;
    } catch (e) {
      var message = e && e.message !== undefined ? String(e.message) : String(e);
      var number = e && (e.axNumber !== undefined ? e.axNumber : e.errorNumber !== undefined ? e.errorNumber : e.code);
      if (typeof number !== "number") {
        var m = /\((-?\d+)\)/.exec(message);
        number = m ? parseInt(m[1], 10) : undefined;
      }
      var internal = !!(e && e.name && INTERNAL_NAMES[e.name]);
      var err = { message: message, internal: internal };
      if (number !== undefined) err.number = number;
      if (e && e.clickAttempted) err.clickAttempted = true;
      return { id: id, ok: false, error: err };
    }
  };
}

// ------------------------------------------------------------------ osascript entry point

function runWorker() {
  ObjC.import("Foundation");
  var SE = Application("System Events");
  var handle = createHandler(SE, function (s) {
    $.NSThread.sleepForTimeInterval(s);
  });
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  var stdout = $.NSFileHandle.fileHandleWithStandardOutput;

  function write(obj) {
    // ASCII-only JSON so the plugin never has to worry about split multi-byte sequences.
    var text = JSON.stringify(obj).replace(/[\u007f-￿]/g, function (c) {
      return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
    stdout.writeData($.NSString.stringWithString(text + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
  }

  var buf = "";
  for (;;) {
    var data = stdin.availableData; // blocks until input or EOF
    if (data.length === 0) break; // plugin closed the pipe
    buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      var line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      var req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        write({ ok: false, error: { message: "Bad request line: " + line.slice(0, 200), internal: true } });
        continue;
      }
      write(handle(req));
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createHandler: createHandler };
} else if (typeof ObjC !== "undefined") {
  runWorker();
}
