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


test("split proxy object is merged when a method parameter shadows its name", async () => {
  // Minified obfuscator output reuses `c` for both the object and a parameter.
  const input = `const c = {}; c.ab = function (W, c) { return W / c; }, c.cd = "x"; const o = c; console.log(o.ab(4, 2), o.cd);`;
  const out = await run(input);
  assert.deepEqual(await sandbox.run(out), ["2 x"]);
  assert.doesNotMatch(out, /\.ab\(/);
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

test("renaming leaves labels alone when a binding shares their name", async () => {
  const input = `function f(){ for (const e of [1]) { e: for (const x of [2]) { continue e; } } return 1; }
console.log(f());`;
  assert.deepEqual(await sandbox.run(await run(input)), ["1"]);
});

test("dictionary junk identifiers are renamed and dead branches after return dropped", async () => {
  const input = `function f(a) {
  try { return a.x; } catch (焦点葡牡) { return 焦点葡牡.message; }
  { return 1; }
  عيادةغايةمنشارريم = 涉及锁孔繁荣昌盛[1];
  var مروءة = 惨无人道虎头蛇尾(1);
}
console.log(f(null), f({ x: 2 }));`;
  const out = await run(input);
  assert.deepEqual(await sandbox.run(out), await sandbox.run(input));
  assert.doesNotMatch(out, /[\u0600-\u06ff\u4e00-\u9fff]/);
});

test("a decoder call that throws is left in place with its machinery", async () => {
  const input = `function _0xa() { const k = ["log"]; _0xa = function () { return k; }; return _0xa(); }
function _0xb(i) { i = i - 0; if (i > 5) throw new Error("x"); return _0xa()[i]; }
console[_0xb(0)]("ok");
try { _0xb(9); } catch (e) { console.log("caught"); }`;
  const out = await run(input);
  assert.deepEqual(await sandbox.run(out), ["ok", "caught"]);
  assert.match(out, /console\.log\("ok"\)/);
});

test("runaway decoder in the sandbox times out instead of hanging", async () => {
  const input = `function _0xa() { const k = ["log"]; _0xa = function () { return k; }; return _0xa(); }
function _0xb(i) { i = i - 0; while (i === 7) {} return _0xa()[i]; }
console[_0xb(0)]("x");
if (typeof window !== "undefined") _0xb(7);`;
  const slow = new Sandbox({ timeout: 200 });
  const out = await deobfuscate(input, { sandbox: slow }).finally(() => slow.close());
  assert.match(out, /console\.log\("x"\)/);
  assert.match(out, /_0xb|func/);
});
