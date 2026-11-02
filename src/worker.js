import { parentPort, workerData } from "node:worker_threads";
import { deobfuscate } from "./index.js";
import { Sandbox } from "./sandbox.js";

const sandbox = new Sandbox({ size: workerData.sandboxSize });

parentPort.on("message", async (msg) => {
  if (msg.close) {
    // Kill the sandbox children ourselves: they are processes and would outlive the thread.
    sandbox.close();
    parentPort.close();
    return;
  }
  const { id, code, rename } = msg;
  try {
    parentPort.postMessage({ id, output: await deobfuscate(code, { sandbox, rename }) });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});
