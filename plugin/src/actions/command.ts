import streamDeck, { type KeyAction, type KeyDownEvent, type KeyUpEvent, type SendToPluginEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { ENTRIES, type CatalogEntry, targetOf } from "../catalog/index.js";
import type { MatchMode, MenuTarget } from "../lib/applescript.js";
import { AxError, isNotFound } from "../lib/axBridge.js";
import { axKeyOptions } from "../lib/axKeys.js";
import { defaultHoldToFire, HoldToFire } from "../lib/holdToFire.js";
import { iconForCommand } from "../lib/icons.js";
import { targetTitle } from "../lib/menu.js";
import { rt } from "../runtime.js";
import { draw, Flasher, logEvent, logSettingsChange, openSettingsIfBlocked, reportAxFailure } from "./util.js";

export type CommandSettings = {
  menuPath?: string[];
  match?: MatchMode;
  holdToFire?: boolean;
  dimWhenDisabled?: boolean;
  label?: string;
};

interface Ctx {
  action: KeyAction<CommandSettings>;
  settings: CommandSettings;
  hold: HoldToFire;
  flasher: Flasher;
}

/** What a key does, resolved from its settings (generic key) or from the catalog (named key). */
export interface Resolved {
  target: MenuTarget;
  label: string;
  icon: string;
  hold: boolean;
  /** For catalog keys: the entry, so a path that doesn't exist in this Capture can be re-resolved from the live menus. */
  entry?: CatalogEntry;
}

async function loadMenus(force: boolean): Promise<{ commands: unknown[]; error?: string }> {
  const r = await rt.menus.ensure(force);
  return { commands: r.commands, error: r.error };
}

export function targetFromSettings(s: CommandSettings): MenuTarget | undefined {
  const p = s.menuPath;
  if (!Array.isArray(p) || p.length < 2 || p.some((x) => typeof x !== "string" || !x)) return undefined;
  return { path: p, match: s.match ?? "exact" };
}

/** Shared behaviour of the generic "Capture Command" key and every named command key. */
abstract class CommandKeys extends SingletonAction<CommandSettings> {
  protected ctxs = new Map<string, Ctx>();

  protected abstract resolve(s: CommandSettings): Resolved | undefined;

  /** Menu commands whose enabled state this key shows (default: the one it fires). */
  protected polled(s: CommandSettings): MenuTarget[] {
    const r = this.resolve(s);
    return r ? [r.target] : [];
  }

  protected redrawAll(): void {
    for (const c of this.ctxs.values()) this.view(c);
  }

  protected view(c: Ctx): void {
    const r = this.resolve(c.settings);
    if (!r) {
      const f = c.flasher.flash;
      draw(c.action, { icon: "unset", label: "Choose command", dim: false, big: f?.text, tone: f?.tone });
      return;
    }
    const enabled = rt.axKeys.isEnabled(r.target);
    const o = axKeyOptions({
      label: c.settings.label?.trim() || r.label,
      icon: r.icon,
      enabled,
      dimWhenDisabled: c.settings.dimWhenDisabled !== false,
      ax: rt.ax.status,
      flash: c.flasher.flash,
    });
    draw(c.action, o);
    c.action.setState(enabled === false && c.settings.dimWhenDisabled !== false ? 1 : 0).catch(() => undefined);
  }

  private attach(id: string, a: KeyAction<CommandSettings>, settings: CommandSettings): void {
    this.ctxs.get(id)?.hold.cancel();
    const flasher = new Flasher(() => ctx && this.view(ctx));
    const hold = new HoldToFire(
      () => void this.fire(ctx),
      () => flasher.show({ text: "Hold", tone: "accent" }, 900),
    );
    const ctx: Ctx = { action: a, settings, hold, flasher };
    this.ctxs.set(id, ctx);
    rt.axKeys.unregister(id);
    rt.axKeys.register({
      id,
      targets: () => this.polled(ctx.settings),
      redraw: () => this.view(ctx),
    });
    this.view(ctx);
  }

  override onWillAppear(ev: WillAppearEvent<CommandSettings>): void {
    if (!ev.action.isKey()) return;
    this.attach(ev.action.id, ev.action, ev.payload.settings ?? {});
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CommandSettings>): void {
    if (!ev.action.isKey()) return;
    logSettingsChange(this.manifestId, ev.payload.settings);
    this.attach(ev.action.id, ev.action, ev.payload.settings ?? {});
  }

  override onWillDisappear(ev: WillDisappearEvent<CommandSettings>): void {
    const c = this.ctxs.get(ev.action.id);
    c?.hold.cancel();
    c?.flasher.clear();
    this.ctxs.delete(ev.action.id);
    rt.axKeys.unregister(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent<CommandSettings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const r = this.resolve(c.settings);
    if (!r) {
      logEvent("Key press", this.manifestId, c.settings, "no command configured (open the key's settings and choose a command)");
      c.flasher.show({ text: "Not set", tone: "red" }, 1800);
      ev.action.showAlert().catch(() => undefined);
      return;
    }
    if (openSettingsIfBlocked()) {
      logEvent("Key press", this.manifestId, c.settings, `blocked: Accessibility ${rt.ax.status}; opened System Settings`);
      return;
    }
    const hold = c.settings.holdToFire ?? r.hold;
    logEvent("Key press", this.manifestId, c.settings, `${r.target.path.join(" > ")}${hold ? " (hold to fire)" : ""}`);
    if (hold) c.hold.keyDown();
    else void this.fire(c);
  }

  override onKeyUp(ev: KeyUpEvent<CommandSettings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    if (c.hold.isDown && c.settings.holdToFire !== false) logEvent("Key release", this.manifestId, c.settings);
    c.hold.keyUp();
  }

  /** Only ever reached from a user's key press (directly, or after a completed 1 s hold). */
  private async fire(c: Ctx): Promise<void> {
    const r = this.resolve(c.settings);
    if (!r) return;
    const t0 = Date.now();
    try {
      let t = r.target;
      let res;
      try {
        res = await rt.ax.clickMenu(t);
      } catch (e) {
        // The catalog path doesn't exist in this Capture: click the command where the live menus have it.
        const healed = r.entry && isNotFound(e) ? rt.menus.effective(r.entry) : undefined;
        if (!healed || healed.path.join("\u0001") === t.path.join("\u0001")) throw e;
        rt.log.warn(`${r.entry?.menuPath.join(" > ")} not found; using ${healed.path.join(" > ")} from Capture's live menus`);
        t = healed;
        res = await rt.ax.clickMenu(t);
      }
      logEvent("Key result", this.manifestId, c.settings, `${res} ${t.path.join(" > ")} in ${Date.now() - t0} ms`);
      if (res === "DISABLED") c.action.showAlert().catch(() => undefined);
      else c.action.showOk().catch(() => undefined);
    } catch (e) {
      logEvent("Key result", this.manifestId, c.settings, `ERROR ${e instanceof AxError ? `${e.kind}: ${e.raw}` : String(e)}`);
      reportAxFailure(c.action, e, c.flasher);
    } finally {
      rt.axKeys.pressed();
    }
  }

  // ---- Property Inspector: menu list from the cache (read-only)
  override async onSendToPlugin(ev: SendToPluginEvent<{ cmd?: string; force?: boolean }, CommandSettings>): Promise<void> {
    if (ev.payload?.cmd === "listMenus") {
      const r = await loadMenus(ev.payload.force === true);
      await streamDeck.ui.sendToPropertyInspector({ event: "menus", commands: r.commands as never, error: r.error ?? null });
    }
  }
}

/** "Capture Command": any menu path, chosen in the Property Inspector. */
export class CaptureCommand extends CommandKeys {
  override readonly manifestId = "com.rezabehjat.capture.command";

  protected resolve(s: CommandSettings): Resolved | undefined {
    const t = targetFromSettings(s);
    if (!t) return undefined;
    return { target: t, label: targetTitle(t), icon: iconForCommand(t.path), hold: defaultHoldToFire(t.path) };
  }
}

/** "Camera: Position 3" → the catalog entry "Camera: Store Position 3" (what the key fires while Camera: Store Modifier is held). */
export function storeEntryFor(e: CatalogEntry): CatalogEntry | undefined {
  const m = e.category === "camera" ? /^position-([1-5])$/.exec(e.id) : null;
  return m ? ENTRIES.find((x) => x.category === "camera" && x.id === `store-${m[1]}`) : undefined;
}

/**
 * One named key per catalog entry ("Camera: Swing to Front"): nothing to configure.
 * "Camera: Position 1–5" also follow the "Camera: Store Modifier" key: while it is held they store the camera
 * (View > Store Camera > Position n) instead of recalling it, exactly as the v0.2 Camera Slot key did.
 */
export class NamedCommand extends CommandKeys {
  override readonly manifestId: string;
  private store: CatalogEntry | undefined;

  constructor(
    uuid: string,
    private entry: CatalogEntry,
  ) {
    super();
    this.manifestId = uuid;
    this.store = storeEntryFor(entry);
    if (this.store) rt.storeModifier.listen(() => this.redrawAll());
  }

  protected resolve(): Resolved | undefined {
    const e = this.store && rt.storeModifier.isHeld ? this.store : this.entry;
    const base = targetOf(e);
    if (!base) return undefined;
    const held = e !== this.entry;
    return { target: rt.menus.effective(e), label: held ? `Store ${this.entry.title.replace(/^Position /, "")}` : e.title, icon: held ? "store" : e.icon, hold: e.holdToFire, entry: e };
  }

  protected override polled(): MenuTarget[] {
    return [this.entry, this.store].flatMap((e) => (e ? [rt.menus.effective(e)] : []));
  }
}
