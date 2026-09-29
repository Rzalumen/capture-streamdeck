/**
 * AppleScript generation for the Accessibility bridge.
 *
 * All scripts are passed to /usr/bin/osascript as separate `-e` lines. Every string that goes into a
 * script is turned into an ASCII-only AppleScript expression by `asString`, so no quoting, encoding
 * or shell-escaping problem can arise from names such as `Duplicate…`, `Emoji & Symbols` or
 * `Say "hi"`:
 *   - printable ASCII is emitted inside "…" with only `\` and `"` escaped;
 *   - everything else (incl. …, control characters, non-BMP) becomes `(character id N)`.
 *
 * What these scripts may do to Capture (handoff 07):
 *   - read menus and their `enabled` state (any time, never activates Capture);
 *   - `click` a menu item, or one of the six tab radio buttons, only when a user presses a key;
 *   - never send mouse/keyboard events, never launch or quit Capture (only System Events is addressed,
 *     and Capture is only brought to front via `set frontmost of process`, which cannot launch it).
 */

export const CAPTURE_PROCESS = "Capture";
export const TABS = ["Design", "Fixtures", "Universes", "Media", "Snapshots", "Library"] as const;
export type TabName = (typeof TABS)[number];

export function asString(s: string): string {
  const parts: string[] = [];
  let lit = "";
  const flush = (): void => {
    if (lit) {
      parts.push(`"${lit}"`);
      lit = "";
    }
  };
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x20 && cp <= 0x7e) {
      lit += ch === '"' || ch === "\\" ? "\\" + ch : ch;
    } else {
      flush();
      parts.push(`(character id ${cp})`);
    }
  }
  flush();
  if (parts.length === 0) return '""';
  return parts.length === 1 ? parts[0] : `(${parts.join(" & ")})`;
}

export const asList = (items: string[]): string => `{${items.map(asString).join(", ")}}`;

export type MatchMode = "exact" | "prefix" | "alternates";

export interface MenuTarget {
  /** Menu bar item, then submenu items…, then the command. e.g. ["View","Camera","Position 1"]. */
  path: string[];
  match: MatchMode;
}

/** Candidate names for the last path element. Alternates are written "A|B" in one element. */
export function candidates(t: MenuTarget): string[] {
  const last = t.path[t.path.length - 1] ?? "";
  return t.match === "alternates" ? last.split("|").map((s) => s.trim()).filter(Boolean) : [last];
}

/** Path elements used to descend to the item's parent (all but the last), always matched exactly. */
export function parentSegments(t: MenuTarget): string[] {
  return t.path.slice(0, -1);
}

export function validateTarget(t: MenuTarget): void {
  if (!Array.isArray(t.path) || t.path.length < 2 || t.path.some((p) => typeof p !== "string" || p === "")) {
    throw new Error(`Invalid menu path: ${JSON.stringify(t.path)}`);
  }
  if (!["exact", "prefix", "alternates"].includes(t.match)) throw new Error(`Invalid match mode: ${t.match}`);
}

/** Shared handlers. `act` finds the menu item and performs "click" or "enabled" on it. */
const HANDLERS: string[] = [
  // Variable names are deliberately unlike any System Events term (name, mode, depth, found…), which
  // AppleScript can otherwise confuse with a property inside a `tell` block.
  "on nameMatches(itemName, matchKind, candList)",
  "  repeat with k from 1 to (count of candList)",
  "    set cand to item k of candList",
  '    if matchKind is "prefix" then',
  "      if itemName starts with cand then return true",
  "    else",
  "      if itemName is cand then return true",
  "    end if",
  "  end repeat",
  "  return false",
  "end nameMatches",
  "",
  "on isPermissionError(errMsg, errNum)",
  '  if errMsg contains "assistive access" then return true',
  "  if errNum is -25211 then return true",
  "  if errNum is -1743 then return true",
  "  return false",
  "end isPermissionError",
  "",
  "on act(procName, topMenuName, parentNames, matchKind, candList, wantWhat)",
  "  tell application \"System Events\"",
  "    tell process procName",
  "      set cur to menu bar item topMenuName of menu bar 1",
  "      repeat with k from 1 to (count of parentNames)",
  "        set cur to menu item (item k of parentNames) of menu 1 of cur",
  "      end repeat",
  "      set hit to missing value",
  "      repeat with mi in (menu items of menu 1 of cur)",
  "        set itemName to missing value",
  "        try",
  "          set itemName to name of mi",
  "        end try",
  "        if itemName is not missing value then",
  "          if my nameMatches(itemName, matchKind, candList) then",
  "            set hit to mi",
  "            exit repeat",
  "          end if",
  "        end if",
  "      end repeat",
  "      if hit is missing value then error \"No such menu item\" number -1728",
  '      if wantWhat is "enabled" then',
  "        if (enabled of hit) then return \"1\"",
  '        return "0"',
  "      end if",
  "      if not (enabled of hit) then return \"DISABLED\"",
  "      click hit",
  '      return "OK"',
  "    end tell",
  "  end tell",
  "end act",
];

const NOT_RUNNING_GUARD = (proc: string): string[] => [
  `tell application "System Events"`,
  `  if not (exists process ${asString(proc)}) then return "NOTRUNNING"`,
  `end tell`,
];

const ACTIVATE = (proc: string): string[] => [
  `tell application "System Events"`,
  `  tell process ${asString(proc)}`,
  `    if not frontmost then`,
  `      set frontmost to true`,
  `      delay 0.2`,
  `    end if`,
  `  end tell`,
  `end tell`,
];

const actCall = (proc: string, t: MenuTarget, what: "click" | "enabled"): string =>
  `my act(${asString(proc)}, ${asString(t.path[0])}, ${asList(t.path.slice(1, -1))}, ${asString(t.match)}, ${asList(candidates(t))}, ${asString(what)})`;

/** Click one menu command (activating Capture first if needed). Returns "OK" | "DISABLED" | "NOTRUNNING". */
export function buildClickMenu(t: MenuTarget, proc = CAPTURE_PROCESS): string[] {
  validateTarget(t);
  return [...HANDLERS, ...NOT_RUNNING_GUARD(proc), ...ACTIVATE(proc), `return ${actCall(proc, t, "click")}`];
}

/**
 * Enabled state of many commands in ONE call. Never activates Capture, never clicks.
 * Returns "NOTRUNNING" or a comma separated list of "1" | "0" | "?" (item not found), in input order.
 * A permission error is re-raised (so it surfaces as an osascript error) instead of becoming "?".
 */
export function buildEnabledBatch(targets: MenuTarget[], proc = CAPTURE_PROCESS): string[] {
  targets.forEach(validateTarget);
  const lines = [...HANDLERS, ...NOT_RUNNING_GUARD(proc), 'set out to ""'];
  targets.forEach((t, i) => {
    lines.push(
      "try",
      `  set r to ${actCall(proc, t, "enabled")}`,
      "on error errMsg number errNum",
      "  if my isPermissionError(errMsg, errNum) then error errMsg number errNum",
      '  set r to "?"',
      "end try",
      i === 0 ? "set out to r" : 'set out to out & "," & r',
    );
  });
  lines.push("return out");
  return lines;
}

/** Click one of the six tab radio buttons. The window is found by the presence of `tab group 1`. */
export function buildClickTab(tab: TabName, proc = CAPTURE_PROCESS): string[] {
  if (!(TABS as readonly string[]).includes(tab)) throw new Error(`Unknown tab: ${tab}`);
  return [
    ...HANDLERS.slice(HANDLERS.indexOf("on isPermissionError(errMsg, errNum)"), HANDLERS.indexOf("on act(procName, topMenuName, parentNames, matchKind, candList, wantWhat)")),
    ...NOT_RUNNING_GUARD(proc),
    ...ACTIVATE(proc),
    `tell application "System Events"`,
    `  tell process ${asString(proc)}`,
    `    repeat with w in (windows)`,
    `      try`,
    `        set g to tab group 1 of w`,
    `        set rb to radio button ${asString(tab)} of g`,
    `        click rb`,
    `        return "OK"`,
    `      on error errMsg number errNum`,
    `        if my isPermissionError(errMsg, errNum) then error errMsg number errNum`,
    `      end try`,
    `    end repeat`,
    `  end tell`,
    `end tell`,
    `return "NOTAB"`,
  ];
}

/** Read-only probe used by the Connection key: is Capture running, and is Accessibility usable? */
export function buildCheck(proc = CAPTURE_PROCESS): string[] {
  return [
    ...NOT_RUNNING_GUARD(proc),
    `tell application "System Events"`,
    `  tell process ${asString(proc)}`,
    `    set c to count of menu bar items of menu bar 1`,
    `  end tell`,
    `end tell`,
    `return "OK"`,
  ];
}

/**
 * Read-only dump of the whole menu bar. One record per menu item, records separated by TAB:
 *   depth|enabled|encodedName|hasSubmenu
 * Names are ASCII-encoded (`\u{HEX}` for `|`, `\`, control and non-ASCII characters), see decodeName.
 */
export function buildMenuDump(proc = CAPTURE_PROCESS): string[] {
  return [
    "on hex(n)",
    '  set hexDigits to "0123456789ABCDEF"',
    '  if n is 0 then return "0"',
    '  set r to ""',
    "  repeat while n > 0",
    "    set d to n mod 16",
    "    set r to (character (d + 1) of hexDigits) & r",
    "    set n to n div 16",
    "  end repeat",
    "  return r",
    "end hex",
    "",
    "on enc(txt)",
    '  set r to ""',
    "  repeat with ch in (characters of txt)",
    "    set cp to id of (contents of ch)",
    "    if cp < 32 or cp > 126 or cp is 124 or cp is 92 then",
    '      set r to r & "\\\\u{" & my hex(cp) & "}"',
    "    else",
    "      set r to r & (contents of ch)",
    "    end if",
    "  end repeat",
    "  return r",
    "end enc",
    "",
    "on dumpMenu(theMenu, lvl)",
    '  set acc to ""',
    '  tell application "System Events"',
    "    set nameList to name of every menu item of theMenu",
    "    set enabledList to enabled of every menu item of theMenu",
    "    set total to count of nameList",
    "    repeat with k from 1 to total",
    "      set itemName to item k of nameList",
    '      set itemText to ""',
    "      if itemName is not missing value then set itemText to itemName",
    "      set mi to menu item k of theMenu",
    '      set hasSub to "0"',
    '      set subText to ""',
    "      if exists menu 1 of mi then",
    '        set hasSub to "1"',
    "        set subText to my dumpMenu(menu 1 of mi, lvl + 1)",
    "      end if",
    '      set en to "0"',
    "      if (item k of enabledList) is true then set en to \"1\"",
    '      set acc to acc & (lvl as text) & "|" & en & "|" & my enc(itemText) & "|" & hasSub & (character id 9) & subText',
    "    end repeat",
    "  end tell",
    "  return acc",
    "end dumpMenu",
    "",
    ...NOT_RUNNING_GUARD(proc),
    'set out to ""',
    'tell application "System Events"',
    `  tell process ${asString(proc)}`,
    "    set topItems to menu bar items of menu bar 1",
    "    repeat with ti in topItems",
    "      set topName to missing value",
    "      try",
    "        set topName to name of ti",
    "      end try",
    '      set topText to ""',
    "      if topName is not missing value then set topText to topName",
    '      set out to out & "0|1|" & my enc(topText) & "|1" & (character id 9)',
    `      if topText is not "Apple" and topText is not ${asString(proc)} then set out to out & my dumpMenu(menu 1 of ti, 1)`,
    "    end repeat",
    "  end tell",
    "end tell",
    "return out",
  ];
}

/** Reverse of the `enc` handler in the menu dump. */
export function decodeName(s: string): string {
  return s.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}
