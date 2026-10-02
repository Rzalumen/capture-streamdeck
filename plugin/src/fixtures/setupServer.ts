/**
 * The Setup page server (v0.4.1): a tiny HTTP server on 127.0.0.1 ONLY (random port) that serves the Setup page from ui/ and answers its
 * commands. Every request must carry the random token (`?t=<token>`), otherwise 403. Started on the first press of Fixtures: Setup, not before.
 *
 * Routes (all need the token): GET / (page), GET /setup-core.js | /setup-web.js | /pi.css (fixed list), POST /api (JSON command → {view, error}).
 * Also refused: a Host header that is not 127.0.0.1:<port> (DNS rebinding), a POST that is not application/json, bodies over 64 KB.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { SetupCommand } from "./setupCommands.js";

export interface SetupServerOptions {
  /** Directory with setup-web.html, setup-core.js, setup-web.js, pi.css. */
  uiDir: string;
  /** Runs one command and returns the new view (a JSON-able object) and the error text (or null). */
  handle: (m: SetupCommand) => Promise<{ view: unknown; error: string | null }>;
  log?: (line: string) => void;
}

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "setup-web.html", type: "text/html; charset=utf-8" },
  "/setup-core.js": { file: "setup-core.js", type: "text/javascript; charset=utf-8" },
  "/setup-web.js": { file: "setup-web.js", type: "text/javascript; charset=utf-8" },
  "/pi.css": { file: "pi.css", type: "text/css; charset=utf-8" },
};
const MAX_BODY = 64 * 1024;

export class SetupServer {
  /** Random per run: 24 bytes, hex. */
  readonly token = randomBytes(24).toString("hex");
  private server: http.Server | undefined;
  private starting: Promise<number> | undefined;
  private _port = 0;

  constructor(private opts: SetupServerOptions) {}

  get port(): number {
    return this._port;
  }
  /** The address the server is bound to ("127.0.0.1"), or null when not listening. */
  get boundAddress(): string | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.address : null;
  }
  get listening(): boolean {
    return !!this.server?.listening;
  }

  /** Starts listening (once) and returns the page address including the token. */
  async url(): Promise<string> {
    const port = await this.start();
    return `http://127.0.0.1:${port}/?t=${this.token}`;
  }

  private start(): Promise<number> {
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const s = http.createServer((req, res) => {
        this.onRequest(req, res).catch((e) => {
          this.opts.log?.(`setup page: request failed: ${(e as Error).message}`);
          if (!res.headersSent) this.reply(res, 500, "text/plain; charset=utf-8", "error");
          else res.end();
        });
      });
      s.on("error", (e) => {
        this.starting = undefined;
        this.server = undefined;
        reject(e);
      });
      // Loopback only: never "0.0.0.0" or "localhost" (which may resolve to more than 127.0.0.1).
      s.listen(0, "127.0.0.1", () => {
        this.server = s;
        this._port = (s.address() as { port: number }).port;
        this.opts.log?.(`setup page: listening on 127.0.0.1:${this._port} (loopback only, token required)`);
        resolve(this._port);
      });
    });
    return this.starting;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (!s) return;
    await new Promise<void>((r) => s.close(() => r()));
  }

  private tokenOk(given: string | null): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private reply(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    // 1. the token, on every request
    if (!this.tokenOk(url.searchParams.get("t"))) return this.reply(res, 403, "text/plain; charset=utf-8", "Forbidden");
    // 2. only our own address as Host (a page on another name that resolves to 127.0.0.1 is refused)
    if (req.headers.host !== `127.0.0.1:${this._port}`) return this.reply(res, 403, "text/plain; charset=utf-8", "Forbidden");

    if (url.pathname === "/api") {
      if (req.method !== "POST") return this.reply(res, 405, "text/plain; charset=utf-8", "Method not allowed");
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return this.reply(res, 415, "text/plain; charset=utf-8", "JSON only");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return this.reply(res, 413, "text/plain; charset=utf-8", "Too large");
        chunks.push(c as Buffer);
      }
      let m: SetupCommand;
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
        m = j as SetupCommand;
      } catch {
        return this.reply(res, 400, "text/plain; charset=utf-8", "Bad JSON");
      }
      const out = await this.opts.handle(m);
      return this.reply(res, 200, "application/json; charset=utf-8", JSON.stringify(out));
    }

    const f = FILES[url.pathname];
    if (!f) return this.reply(res, 404, "text/plain; charset=utf-8", "Not found");
    if (req.method !== "GET") return this.reply(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(this.opts.uiDir, f.file));
    } catch {
      return this.reply(res, 404, "text/plain; charset=utf-8", "Not found");
    }
    // the page's own links (style, scripts) carry the token as well
    this.reply(res, 200, f.type, url.pathname === "/" ? Buffer.from(body.toString("utf8").replaceAll("__T__", this.token)) : body);
  }
}
