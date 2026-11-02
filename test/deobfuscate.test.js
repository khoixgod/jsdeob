import { test, after } from "node:test";
import assert from "node:assert/strict";
import { deobfuscate, Sandbox } from "../src/index.js";

const sandbox = new Sandbox();
after(() => sandbox.close());
const run = (code) => deobfuscate(code, { sandbox });

test("proxy call keeps argument evaluation order when params are swapped", async () => {
  // `function(a, b) { return b - a }` can't be inlined: x() would run after y().
  const input = `const p = { s: function (a, b) { return b - a; } };
let log = "";
const x = () => (log += "x", 1), y = () => (log += "y", 5);
console.log(p.s(x(), y()), log);`;
  const out = await run(input);
  assert.deepEqual(await sandbox.run(out), await sandbox.run(input));
});

test("object that is written to is not treated as a proxy table", async () => {
  const input = `const p = { a: 1 };
p.a = 2;
console.log(p.a);`;
  assert.deepEqual(await sandbox.run(await run(input)), ["2"]);
});

test("unreferenced program-scope declarations with readable names are kept", async () => {
  // Another <script> may call these.
  const out = await run("function helper() {} var config = 1;");
  assert.match(out, /function helper/);
  assert.match(out, /config/);
});

test("renaming never captures an existing name", async () => {
  const input = `const index = 10;
for (let _0x1a = 0; _0x1a < 2; _0x1a++) console.log(index + _0x1a);`;
  assert.deepEqual(await sandbox.run(await run(input)), ["10", "11"]);
});

test("a decoder call that throws is left in place with its machinery", async () => {
  const input = `function _0xa() { const k = ["log"]; _0xa = function () { return k; }; return _0xa(); }
function _0xb(i) { if (i > 5) throw new Error("x"); return _0xa()[i]; }
console[_0xb(0)]("ok");
try { _0xb(9); } catch (e) { console.log("caught"); }`;
  const out = await run(input);
  assert.deepEqual(await sandbox.run(out), ["ok", "caught"]);
  assert.match(out, /console\.log\("ok"\)/);
});

test("runaway decoder in the sandbox times out instead of hanging", async () => {
  const input = `function _0xa() { const k = ["log"]; _0xa = function () { return k; }; return _0xa(); }
function _0xb(i) { while (i === 7) {} return _0xa()[i]; }
console[_0xb(0)]("x");
if (typeof window !== "undefined") _0xb(7);`;
  const slow = new Sandbox({ timeout: 200 });
  const out = await deobfuscate(input, { sandbox: slow }).finally(() => slow.close());
  assert.match(out, /console\.log\("x"\)/);
  assert.match(out, /_0xb|func/);
});
