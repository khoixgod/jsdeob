#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { deobfuscate } from "../src/index.js";
import { DeobfuscatorPool } from "../src/pool.js";

const USAGE = `usage: jsdeob <input.js | -> [-o output.js] [--no-rename]
       jsdeob <a.js> <b.js> ... --out-dir <dir> [-j threads] [--no-rename]
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o" },
    "out-dir": { type: "string" },
    jobs: { type: "string", short: "j" },
    "no-rename": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length === 0 || (positionals.length > 1 && !values["out-dir"])) {
  process.stderr.write(USAGE);
  process.exit(values.help ? 0 : 2);
}
const rename = !values["no-rename"];

if (positionals.length === 1 && !values["out-dir"]) {
  const input = positionals[0] === "-" ? await readStdin() : await readFile(positionals[0], "utf8");
  let output;
  try {
    output = await deobfuscate(input, { rename });
  } catch (e) {
    process.stderr.write(`jsdeob: ${e.message}\n`);
    process.exit(1);
  }
  if (values.output) await writeFile(values.output, output, "utf8");
  else process.stdout.write(output);
} else {
  const threads = values.jobs ? Number.parseInt(values.jobs, 10) : undefined;
  if (threads !== undefined && !(threads >= 1)) {
    process.stderr.write("jsdeob: -j must be a positive integer\n");
    process.exit(2);
  }
  await mkdir(values["out-dir"], { recursive: true });
  // More threads than files would only idle; default is cores - 1 (DeobfuscatorPool).
  const pool = new DeobfuscatorPool(threads || positionals.length < 8 ? { threads: Math.min(threads ?? positionals.length, positionals.length) } : {});
  let failed = 0;
  await Promise.all(
    positionals.map(async (file) => {
      const started = Date.now();
      try {
        const output = await pool.deobfuscate(await readFile(file, "utf8"), { rename });
        await writeFile(join(values["out-dir"], basename(file)), output, "utf8");
        process.stderr.write(`ok   ${file} (${Date.now() - started} ms)\n`);
      } catch (e) {
        failed++;
        process.stderr.write(`fail ${file}: ${e.message}\n`);
      }
    }),
  );
  await pool.close();
  process.exitCode = failed ? 1 : 0;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
