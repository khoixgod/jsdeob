import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./sandbox-child.cjs", import.meta.url));

/** Evaluates untrusted JS in a separate `node --permission` process. Respawns after a crash or hang. */
export class Sandbox {
  #child = null;
  #pending = new Map();
  #nextId = 0;

  constructor({ timeout = 2000 } = {}) {
    this.timeout = timeout;
  }

  #spawn() {
    const child = fork(CHILD, [], {
      execArgv: ["--permission", `--allow-fs-read=${CHILD}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.on("message", (msg) => {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg);
    });
    child.on("exit", () => {
      if (this.#child === child) this.#child = null;
      for (const [id, p] of this.#pending) {
        if (p.child !== child) continue;
        this.#pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error("sandbox exited"));
      }
    });
    this.#child = child;
    return child;
  }

  #request(msg) {
    const child = this.#child ?? this.#spawn();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // The vm timeout covers synchronous loops; this one covers everything else.
      const timer = setTimeout(() => child.kill(), this.timeout * 4 + 1000);
      this.#pending.set(id, { resolve, reject, timer, child });
      child.send({ id, timeout: this.timeout, ...msg });
    });
  }

  /** Runs `setup`, then evaluates each expression in `calls`. Returns a string or null per call. */
  async decode(setup, calls) {
    return (await this.#request({ op: "decode", setup, calls })).results;
  }

  /** Runs a script and returns what it printed through console. A thrown error becomes a `!throw Name` line. */
  async run(code) {
    return (await this.#request({ op: "run", code })).logs;
  }

  close() {
    this.#child?.kill();
    this.#child = null;
  }
}
