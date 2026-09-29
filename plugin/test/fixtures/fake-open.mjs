#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(process.env.FAKE_OPEN_LOG, process.argv.slice(2).join(" ") + "\n");
