#!/usr/bin/env node
// Fake /usr/bin/osascript for integration tests. Behaviour comes from the JSON file named in FAKE_AX_STATE;
// every call is appended to FAKE_AX_LOG as one JSON line ({ lines: [...] }).
import fs from "node:fs";

const args = process.argv.slice(2);
const lines = [];
for (let i = 0; i < args.length; i++) if (args[i] === "-e") lines.push(args[++i]);
const text = lines.join("\n");
fs.appendFileSync(process.env.FAKE_AX_LOG, JSON.stringify({ lines }) + "\n");

const st = JSON.parse(fs.readFileSync(process.env.FAKE_AX_STATE, "utf8"));
const fail = (msg) => (process.stderr.write(msg + "\n"), process.exit(1));

if (st.mode === "noperm") fail("execution error: System Events got an error: osascript is not allowed assistive access. (-25211)");
if (st.mode === "noautomation") fail("execution error: Not authorized to send Apple events to System Events. (-1743)");
if (st.mode === "error") fail('execution error: System Events got an error: Can’t get menu item "Zap". (-1728)');
if (st.mode === "notrunning") (console.log("NOTRUNNING"), process.exit(0));
if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));

if (text.includes("on dumpMenu")) {
  console.log(st.dump ?? "");
} else if (text.includes('"enabled")')) {
  const res = [...text.matchAll(/set r to my act\([^\n]*?, \{([^}]*)\}, "enabled"\)/g)].map((m) => {
    const cand = (m[1].match(/"([^"]*)"/) ?? [])[1] ?? "";
    const v = st.enabled?.[cand];
    return v === undefined ? "1" : v === null ? "?" : v ? "1" : "0";
  });
  console.log(res.join(","));
} else if (text.includes('"click")')) {
  const cand = (text.match(/return my act\([^\n]*?, \{([^}]*)\}, "click"\)/) ?? [])[1] ?? "";
  const name = (cand.match(/"([^"]*)"/) ?? [])[1] ?? "";
  console.log(st.disabledClicks?.includes(name) ? "DISABLED" : "OK");
} else if (text.includes("radio button")) {
  console.log("OK");
} else {
  console.log("OK"); // check
}
