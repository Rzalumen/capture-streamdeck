import dgram from "node:dgram";
import { decodeMessage, encodeMessage, oscF, oscI, oscS, type OscMessage } from "../../src/lib/osc.ts";

/** A tiny fake Capture: records every packet and answers like Capture 2026.1.6. */
export class StubCapture {
  sock = dgram.createSocket("udp4");
  raw: Buffer[] = [];
  msgs: OscMessage[] = [];
  port = 0;
  answering = true;
  catalogs: { name: string; positions: string[] }[] = [
    { name: "Main", positions: ["Front", "Back", "Truss"] },
    { name: "Extra", positions: ["Wide"] },
  ];
  async start(): Promise<void> {
    this.sock.on("message", (buf, rinfo) => {
      this.raw.push(Buffer.from(buf));
      const m = decodeMessage(buf);
      this.msgs.push(m);
      if (!this.answering) return;
      const reply = (addr: string, args: Parameters<typeof encodeMessage>[1]) => this.sock.send(encodeMessage(addr, args), rinfo.port, rinfo.address);
      let x: RegExpExecArray | null;
      if (m.address === "/ping") reply("/pong", [oscS("Capture 2026"), oscS("2026.1.6")]);
      else if (m.address === "/getCatalogs") reply("/catalogs", this.catalogs.map((_, i) => oscI(i + 1)));
      else if ((x = /^\/catalog\/(\d+)\/getName$/.exec(m.address))) reply(`/catalog/${x[1]}/name`, [oscS(this.catalogs[+x[1] - 1].name)]);
      else if ((x = /^\/catalog\/(\d+)\/getPositions$/.exec(m.address)))
        reply(`/catalog/${x[1]}/positions`, this.catalogs[+x[1] - 1].positions.map((_, i) => oscI(i + 1)));
      else if ((x = /^\/catalog\/(\d+)\/position\/(\d+)\/getName$/.exec(m.address)))
        reply(`/catalog/${x[1]}/position/${x[2]}/name`, [oscS(this.catalogs[+x[1] - 1].positions[+x[2] - 1])]);
      else if (m.address === "/view/live/getStatus") reply("/view/live/status", [oscI(0), oscF(1), oscF(2), oscF(3), oscF(0), oscF(0), oscF(0)]);
    });
    await new Promise<void>((r) => this.sock.bind(0, "127.0.0.1", r));
    this.port = this.sock.address().port;
  }
  stop(): void {
    this.sock.close();
  }
}

