// Runs untrusted code. Started by sandbox.js under `node --permission` with read access to
// this file only, so a vm escape still cannot touch the filesystem, network or child processes.
"use strict";
const vm = require("node:vm");
const util = require("node:util");

function handle({ op, setup, calls, code, timeout }) {
  const opts = { timeout };
  if (op === "decode") {
    const ctx = vm.createContext({}, { microtaskMode: "afterEvaluate" });
    vm.runInContext(setup, ctx, opts);
    return {
      results: calls.map((call) => {
        try {
          const value = vm.runInContext(call, ctx, opts);
          return typeof value === "string" ? value : null;
        } catch {
          return null;
        }
      }),
    };
  }
  if (op === "run") {
    const logs = [];
    const log = (...args) => logs.push(util.format(...args));
    const ctx = vm.createContext({ console: { log, info: log, warn: log, error: log } }, { microtaskMode: "afterEvaluate" });
    try {
      vm.runInContext(code, ctx, opts);
    } catch (e) {
      logs.push(`!throw ${e && e.name}`);
    }
    return { logs };
  }
  throw new Error(`unknown op ${op}`);
}

process.on("message", (msg) => {
  let reply;
  try {
    reply = { id: msg.id, ...handle(msg) };
  } catch (e) {
    reply = { id: msg.id, error: String((e && e.message) || e) };
  }
  process.send(reply);
});
