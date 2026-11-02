import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./sandbox-child.cjs", import.meta.url));

/**
 * Evaluates untrusted JS in `node --permission` child processes. Holds up to `size` children,
 * spawned on demand: a request goes to an idle child, or to the least busy one when all are
 * busy. A child that crashes or hangs is killed and replaced on the next request.
 */
export class Sandbox {
  #slots = [];
  #pending = new Map();
  #nextId = 0;

  constructor({ timeout = 2000, size = Math.max(1, Math.min(8, availableParallelism() - 1)) } = {}) {
    this.timeout = timeout;
    this.size = size;
  }

  #spawn() {
    const child = fork(CHILD, [], {
      execArgv: ["--permission", `--allow-fs-read=${CHILD}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const slot = { child, busy: 0 };
    child.on("message", (msg) => {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#settle(msg.id, p);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg);
    });
    // EPIPE when sending to a child that just died; the exit handler rejects its requests.
    child.on("error", () => child.kill());
    child.on("exit", () => {
      this.#slots = this.#slots.filter((s) => s !== slot);
      for (const [id, p] of this.#pending) {
        if (p.slot !== slot) continue;
        this.#settle(id, p);
        p.reject(new Error("sandbox exited"));
      }
    });
    this.#slots.push(slot);
    return slot;
  }

  #settle(id, p) {
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.slot.busy--;
  }

  #pick() {
    const idle = this.#slots.find((s) => s.busy === 0);
    if (idle) return idle;
    if (this.#slots.length < this.size) return this.#spawn();
    return this.#slots.reduce((a, b) => (b.busy < a.busy ? b : a));
  }

  #request(msg, units = 1) {
    const slot = this.#pick();
    const id = this.#nextId++;
    slot.busy++;
    return new Promise((resolve, reject) => {
      // The vm timeout bounds each synchronous call; this watchdog catches anything that escapes
      // it. It grows with the batch: a big bundle can send thousands of fast calls at once.
      // ponytail: fixed 25 ms per call, switch to child heartbeats if real decoders get slower.
      const timer = setTimeout(() => slot.child.kill(), this.timeout * 4 + 1000 + units * 25);
      this.#pending.set(id, { resolve, reject, timer, slot });
      slot.child.send({ id, timeout: this.timeout, ...msg }, (err) => {
        if (err) slot.child.kill();
      });
    });
  }

  /** Runs `setup`, then evaluates each expression in `calls`. Returns a string or null per call. */
  async decode(setup, calls) {
    return (await this.#request({ op: "decode", setup, calls }, calls.length)).results;
  }

  /** Runs a script and returns what it printed through console. A thrown error becomes a `!throw Name` line. */
  async run(code) {
    return (await this.#request({ op: "run", code })).logs;
  }

  close() {
    for (const slot of this.#slots) slot.child.kill();
    this.#slots = [];
  }
}
