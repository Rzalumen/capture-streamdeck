// Prints the generated profile layout as Markdown (used to write DEFAULT-LAYOUT.md):  node --import tsx scripts/describe-layout.mjs
import { buildLayout, COMMAND_SLOTS, MORE_SLOT } from "../src/profile/layout.ts";

const layout = buildLayout();
const out = [];
const dialNames = (p) => [...p.dials.values()].map((d) => d.title).join(" · ");
function walk(page, depth) {
  const here = [...page.keys.entries()];
  const names = page === layout.home ? [...page.keys.values()] : COMMAND_SLOTS.filter((s) => page.keys.has(s)).map((s) => page.keys.get(s));
  out.push(`${"  ".repeat(depth)}- **${page.path}** — ${names.map((k) => k.title || (k.name ?? "").replace(/^Fixtures: /, "")).join(" · ")}   \n${"  ".repeat(depth)}  dials: ${dialNames(page)}`);
  for (const [, k] of here) if (k.type === "folder") walk(k.child, depth + 1);
}
walk(layout.home, 0);
console.log(out.join("\n"));
void MORE_SLOT;
