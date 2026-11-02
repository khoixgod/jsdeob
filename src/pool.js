import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

const WORKER = new URL("./worker.js", import.meta.url);

/**
 * Deobfuscates many files in parallel on worker threads. A Babel AST can't be shared across
 * threads, so the unit of parallelism is one file. Each worker owns its own sandbox pool.
 */
export class DeobfuscatorPool {
  #workers = [];
  #idle = [];
  #queue = [];
  #jobs = new Map();
  #nextId = 0;

  constructor({ threads = Math.max(1, availableParallelism() - 1), sandboxSize, stackSizeMb = 64 } = {}) {
    // Sandboxes are processes; split the cores between threads so they don't oversubscribe.
    const perWorker = sandboxSize ?? Math.max(1, Math.floor(availableParallelism() / threads));
    for (let i = 0; i < threads; i++) {
      const worker = new Worker(WORKER, {
        workerData: { sandboxSize: perWorker },
        // Deeply nested minified code recurses deep in Babel; the default 4 MB stack overflows.
        resourceLimits: { stackSizeMb },
      });
      worker.on("message", ({ id, output, error }) => {
        const job = this.#jobs.get(id);
        this.#jobs.delete(id);
        if (error) job.reject(new Error(error));
        else job.resolve(output);
        this.#release(worker);
      });
      worker.on("error", (e) => {
        for (const [id, job] of this.#jobs) {
          if (job.worker !== worker) continue;
          this.#jobs.delete(id);
          job.reject(e);
        }
      });
      this.#workers.push(worker);
      this.#idle.push(worker);
    }
  }

  /** Same contract as `deobfuscate(code, { rename })`. */
  deobfuscate(code, { rename = true } = {}) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextId++, code, rename, resolve, reject });
      this.#dispatch();
    });
  }

  #dispatch() {
    while (this.#idle.length && this.#queue.length) {
      const worker = this.#idle.pop();
      const job = this.#queue.shift();
      job.worker = worker;
      this.#jobs.set(job.id, job);
      worker.postMessage({ id: job.id, code: job.code, rename: job.rename });
    }
  }

  #release(worker) {
    this.#idle.push(worker);
    this.#dispatch();
  }

  async close() {
    // Ask each worker to close its sandbox children, then stop the threads.
    await Promise.all(this.#workers.map((w) => new Promise((resolve) => {
      w.once("exit", resolve);
      w.postMessage({ close: true });
    })));
  }
}
