# jsdeob

Deobfuscator for [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) (obfuscator.io) output. It recovers the source program: functions, loops and logic stay as written, and the obfuscation layers are removed.

```
npx jsdeob input.js -o output.js
npx jsdeob - < input.js                  # stdin to stdout
npx jsdeob input.js --no-rename          # keep original identifiers
npx jsdeob a.js b.js c.js --out-dir out  # many files, in parallel (-j N threads)
```

```js
import { deobfuscate } from "jsdeob";
const clean = await deobfuscate(code);

import { DeobfuscatorPool } from "jsdeob/src/pool.js";
const pool = new DeobfuscatorPool();            // cores - 1 worker threads
const outputs = await Promise.all(files.map((code) => pool.deobfuscate(code)));
await pool.close();
```

Requires Node 22+.

## Performance

There are two levels of parallelism:

- **Across files**, worker threads each deobfuscate one file. A Babel AST can't be shared between threads, so one file is the unit of work.
- **Within a file**, each string array group is an independent sandbox batch. The groups go out at once to a pool of sandbox processes.

Every pass is linear in file size. Renaming plans all new names and then rewrites them in one traversal. Dead-code removal uses a worklist instead of re-crawling scopes. String decoding scans the program once for all groups.

| workload | before | after |
|---|---|---|
| devirt-corpus, 9,514 files | 102 s | 19 s |
| afterlife.rest, 7 files / 4.6 MB | 175 s | 32 s |
| largest single file (3.2 MB, 155 string groups) | 81 s | 32 s |

## Passes

Each round runs these passes in order, until a round changes nothing:

1. `foldConstants` evaluates literal arithmetic (`0x1*-0x1cc7+0x98c`), string concatenation (`"redu"+"ce"`) and literal `if`/`?:`/`&&`/`||` tests.
2. `mergeObjectAssignments` turns `const o = {}; o["a"] = 1; o["b"] = 2;` back into one object literal.
3. `decodeStringArrays` finds the string array function, its decoders (plain, base64, RC4) and the rotation IIFE. It runs them in the sandbox, resolves every call through aliases and wrapper functions, and replaces each call with its string. The machinery is deleted only when nothing references it anymore.
4. `inlineProxyObjects` inlines lookup objects such as `{ abc: "str", xyz: function (a, b) { return a + b; } }`. A function is inlined only if each parameter appears exactly once and in argument order, so side-effect order is preserved. An object that is ever written to is skipped.
5. `removeUnreachable` and `removeDeadBindings` delete code after `return`/`throw` and unused side-effect-free bindings.

Afterwards it splits sequence expressions and multi-declarations, converts `a["b"]` to `a.b` and hex literals to decimal, and renames obfuscated local names by role (`index`, `acc`, `item`, `arr`, `str`, …). Obfuscated names are `_0x…` names, names of 1–2 characters, and the Arabic/Chinese dictionary names that `identifiersDictionary` produces (`عيادةغايةمنشارريم`, `涉及锁孔繁荣昌盛`).

Unreachable code goes away even when the exit is hidden in a nested block or an `if`/`else` that returns on both branches; the obfuscator puts its junk code behind those. Hoisted `var`s after an exit keep their declaration and lose their initializer, which never runs.

Script top-level names that look human-written are never deleted or renamed, because another script on the page may use them. In ES modules, top-level names are private unless exported.

## Sandbox

Decoders run in `node:vm` inside child processes started with `node --permission`. A child can read only its own file, and it has no network, filesystem write or subprocess access. Each evaluation has a 2 s vm timeout. A watchdog kills and respawns a child if it hangs. When a call fails or times out, that call site is left as it was. The sandbox gets compact code, because javascript-obfuscator's `selfDefending` option makes a decoder loop forever when its own source has been reformatted.

## Corpus results

`node scripts/corpus.js <devirt-corpus checkout>` deobfuscates every sample, then runs input and output in the sandbox and compares their console output. Opaque% uses the dataset card's definition: the share of identifiers that are `_0x…` or 1–2 characters long.

| source | n | equivalent | opaque % (jsdeob) | opaque % (devirt) |
|---|---|---|---|---|
| generated (18 profiles) | 9500 | 9500 | 4.3–10.8 | 4.2–11.7 |
| real/tranco | 14 | 14 | 5.7 | 7.4 |

devirt evaluates whole programs down to their output (`console.log(7714)`). jsdeob keeps the program, so its output is larger on purpose.

## Limits

- No switch-dispatcher control-flow unflattening (`while(true){switch(order[i++]){…}}`). The corpus contains none.
- Proxy functions with repeated or reordered parameters stay as method calls.
- A string group whose array is read by anything other than its decoders, its rotation loop and aliases of the decoder (`const a = D`, or `var a; … (a = D)(…)` with a single assignment) is skipped. Decoding it before an unrecognized rotation would produce garbage.
- `selfDefending` and `disableConsoleOutput` wrappers are kept. They change runtime behavior, so removing them would change what the program does.
- The renamer works from roles, not meaning. Names like `value3` are left where it cannot infer a role.
