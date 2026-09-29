import streamDeck, { action, type KeyAction, type KeyDownEvent, type KeyUpEvent, type SendToPluginEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { MatchMode, MenuTarget } from "../lib/applescript.js";
import { axKeyOptions } from "../lib/axKeys.js";
import { defaultHoldToFire, HoldToFire } from "../lib/holdToFire.js";
import { iconForCommand } from "../lib/icons.js";
import { flattenMenu, targetTitle, type FlatCommand } from "../lib/menu.js";
import { rt } from "../runtime.js";
import { draw, Flasher, openSettingsIfBlocked, reportAxFailure } from "./util.js";

type Settings = {
  menuPath?: string[];
  match?: MatchMode;
  holdToFire?: boolean;
  dimWhenDisabled?: boolean;
  label?: string;
};

interface Ctx {
  action: KeyAction<Settings>;
  settings: Settings;
  hold: HoldToFire;
  flasher: Flasher;
}

let menuCache: { at: number; commands: FlatCommand[] } | undefined;

async function loadMenus(force: boolean): Promise<{ commands: FlatCommand[]; error?: string }> {
  if (!force && menuCache && Date.now() - menuCache.at < 60_000) return { commands: menuCache.commands };
  try {
    // READ-ONLY: walks the menu bar; never clicks anything.
    const tree = await rt.ax.dumpMenus();
    menuCache = { at: Date.now(), commands: flattenMenu(tree) };
    return { commands: menuCache.commands };
  } catch (e) {
    return { commands: menuCache?.commands ?? [], error: describe(e) };
  }
}

function describe(e: unknown): string {
  const k = (e as { kind?: string })?.kind;
  if (k === "noPermission" || k === "noAutomation") return "Allow Access: give Stream Deck access in System Settings → Privacy & Security → Accessibility (and Automation → System Events).";
  if (k === "notRunning") return "Capture is not running. Open Capture, then reload.";
  return `Could not read Capture's menus: ${(e as Error)?.message ?? e}`;
}

export function targetFromSettings(s: Settings): MenuTarget | undefined {
  const p = s.menuPath;
  if (!Array.isArray(p) || p.length < 2 || p.some((x) => typeof x !== "string" || !x)) return undefined;
  return { path: p, match: s.match ?? "exact" };
}

@action({ UUID: "com.rezabehjat.capture.command" })
export class CaptureCommand extends SingletonAction<Settings> {
  private ctxs = new Map<string, Ctx>();

  private view(c: Ctx): void {
    const t = targetFromSettings(c.settings);
    if (!t) {
      draw(c.action, { icon: "unset", label: "Choose command", dim: false });
      return;
    }
    const enabled = rt.axKeys.isEnabled(t);
    const o = axKeyOptions({
      label: c.settings.label?.trim() || targetTitle(t),
      icon: iconForCommand(t.path),
      enabled,
      dimWhenDisabled: c.settings.dimWhenDisabled !== false,
      ax: rt.ax.status,
      flash: c.flasher.flash,
    });
    draw(c.action, o);
    c.action.setState(enabled === false && c.settings.dimWhenDisabled !== false ? 1 : 0).catch(() => undefined);
  }

  private attach(id: string, a: KeyAction<Settings>, settings: Settings): void {
    this.ctxs.get(id)?.hold.cancel();
    const flasher = new Flasher(() => ctx && this.view(ctx));
    const hold = new HoldToFire(
      () => void this.fire(ctx),
      () => flasher.show({ text: "Hold", tone: "accent" }, 900),
    );
    const ctx: Ctx = { action: a, settings, hold, flasher };
    this.ctxs.set(id, ctx);
    const t = targetFromSettings(settings);
    rt.axKeys.unregister(id);
    rt.axKeys.register({ id, targets: t ? [t] : undefined, redraw: () => this.view(ctx) });
    this.view(ctx);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (!ev.action.isKey()) return;
    this.attach(ev.action.id, ev.action, ev.payload.settings ?? {});
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (!ev.action.isKey()) return;
    this.attach(ev.action.id, ev.action, ev.payload.settings ?? {});
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    c?.hold.cancel();
    c?.flasher.clear();
    this.ctxs.delete(ev.action.id);
    rt.axKeys.unregister(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent<Settings>): void {
    const c = this.ctxs.get(ev.action.id);
    if (!c) return;
    const t = targetFromSettings(c.settings);
    if (!t) {
      ev.action.showAlert().catch(() => undefined);
      return;
    }
    if (openSettingsIfBlocked()) return;
    const hold = c.settings.holdToFire ?? defaultHoldToFire(t.path);
    if (hold) c.hold.keyDown();
    else void this.fire(c);
  }

  override onKeyUp(ev: KeyUpEvent<Settings>): void {
    this.ctxs.get(ev.action.id)?.hold.keyUp();
  }

  /** Only ever reached from a user's key press (directly, or after a completed 1 s hold). */
  private async fire(c: Ctx): Promise<void> {
    const t = targetFromSettings(c.settings);
    if (!t) return;
    try {
      const r = await rt.ax.clickMenu(t);
      if (r === "DISABLED") c.action.showAlert().catch(() => undefined);
      else c.action.showOk().catch(() => undefined);
    } catch (e) {
      reportAxFailure(c.action, e, c.flasher);
    }
  }

  // ---- Property Inspector: live menu list (read-only)
  override async onSendToPlugin(ev: SendToPluginEvent<{ cmd?: string; force?: boolean }, Settings>): Promise<void> {
    if (ev.payload?.cmd === "listMenus") await this.sendMenus(ev.payload.force === true);
  }

  private async sendMenus(force: boolean): Promise<void> {
    const r = await loadMenus(force);
    await streamDeck.ui.sendToPropertyInspector({ event: "menus", commands: r.commands as unknown as never, error: r.error ?? null });
  }
}
