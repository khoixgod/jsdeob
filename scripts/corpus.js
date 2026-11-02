// Runs jsdeob over a devirt-corpus checkout and checks each output against the input:
// both run in the sandbox, and their console output must match exactly.
// usage: node scripts/corpus.js <corpus-dir> [--filter substring] [--show N] [-j threads]
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { Sandbox } from "../src/index.js";
import { DeobfuscatorPool } from "../src/pool.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { filter: { type: "string" }, show: { type: "string", default: "3" }, jobs: { type: "string", short: "j" } },
});
const root = positionals[0];
if (!root) {
  process.stderr.write("usage: node scripts/corpus.js <corpus-dir> [--filter s] [--show N]\n");
  process.exit(2);
}

const devirt = new Map();
for (const f of await readdir(join(root, "metrics"))) {
  for (const line of (await readFile(join(root, "metrics", f), "utf8")).split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    devirt.set(r.path, r);
  }
}

const files = [];
for (const top of ["generated", "real"]) {
  for (const dir of await readdir(join(root, top))) {
    for (const f of await readdir(join(root, top, dir))) files.push(join(root, top, dir, f));
  }
}
const selected = files.filter((f) => !values.filter || f.replaceAll("\\", "/").includes(values.filter));

// Same definition as the dataset card: hex `_0x…` names, or names of 1–2 characters.
function opaquePct(code) {
  const ids = new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const KEYWORDS = new Set(["if", "in", "do", "of"]);
  const names = [...ids].filter((n) => !KEYWORDS.has(n));
  if (names.length === 0) return 0;
  return (100 * names.filter((n) => /^_0x[0-9a-f]+$/i.test(n) || n.length <= 2).length) / names.length;
}

// Deobfuscation runs on worker threads; the equivalence check runs both versions in a
// separate sandbox pool on this thread.
const pool = new DeobfuscatorPool(values.jobs ? { threads: Number(values.jobs) } : {});
const sandbox = new Sandbox();
const stats = new Map();
const failures = [];
const started = Date.now();
await Promise.all(
  selected.map(async (file) => {
    const rel = relative(root, file).replaceAll("\\", "/");
    const source = rel.split("/").slice(0, 2).join("/");
    const s = stats.get(source) ?? { n: 0, ok: 0, kept: 0, opaque: 0, devirtOpaque: 0, devirtKept: 0 };
    stats.set(source, s);
    s.n++;
    const input = await readFile(file, "utf8");
    let output;
    let verdict;
    try {
      output = await pool.deobfuscate(input);
      const [before, after] = await Promise.all([sandbox.run(input), sandbox.run(output)]);
      verdict = JSON.stringify(before) === JSON.stringify(after) ? null : `behavior: ${JSON.stringify(before).slice(0, 200)} vs ${JSON.stringify(after).slice(0, 200)}`;
    } catch (e) {
      verdict = `error: ${e.message}`;
    }
    if (verdict) failures.push({ rel, verdict });
    else s.ok++;
    if (output) {
      s.kept += (100 * output.length) / input.length;
      s.opaque += opaquePct(output);
    }
    const d = devirt.get(rel);
    if (d) {
      s.devirtOpaque += d.opaque_out;
      s.devirtKept += d.kept_pct;
    }
  }),
);
await pool.close();
sandbox.close();

const rows = [...stats].sort(([a], [b]) => a.localeCompare(b));
const fmt = (x) => x.toFixed(1).padStart(6);
console.log(`${"source".padEnd(30)} ${"n".padStart(5)} ${"equiv".padStart(6)} ${"kept%".padStart(6)} ${"opq%".padStart(6)} | devirt ${"kept%".padStart(6)} ${"opq%".padStart(6)}`);
let total = 0;
let ok = 0;
for (const [source, s] of rows) {
  total += s.n;
  ok += s.ok;
  console.log(`${source.padEnd(30)} ${String(s.n).padStart(5)} ${String(s.ok).padStart(6)} ${fmt(s.kept / s.n)} ${fmt(s.opaque / s.n)} |        ${fmt(s.devirtKept / s.n)} ${fmt(s.devirtOpaque / s.n)}`);
}
console.log(`\n${ok}/${total} behavior-equivalent, ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const f of failures.slice(0, Number(values.show))) console.log(`FAIL ${f.rel}\n  ${f.verdict}`);
process.exitCode = failures.length ? 1 : 0;
