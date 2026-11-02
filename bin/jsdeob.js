#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deobfuscate } from "../src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o" },
    "no-rename": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length !== 1) {
  process.stderr.write("usage: jsdeob <input.js | -> [-o output.js] [--no-rename]\n");
  process.exit(values.help ? 0 : 2);
}

const input = positionals[0] === "-" ? await readStdin() : await readFile(positionals[0], "utf8");
let output;
try {
  output = await deobfuscate(input, { rename: !values["no-rename"] });
} catch (e) {
  process.stderr.write(`jsdeob: ${e.message}\n`);
  process.exit(1);
}
if (values.output) await writeFile(values.output, output, "utf8");
else process.stdout.write(output);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
