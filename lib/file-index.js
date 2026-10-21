const { fork } = require("node:child_process");
const path = require("node:path");
const { referenceDirectory } = require("./path-proximity");

function checkSignal(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("File snapshot cancelled", { cause: signal.reason }), {
      name: "AbortError",
    });
}

// One metadata worker owns the package's shared index. Filtering remains per list.
module.exports = class FileIndex {
  constructor(options) {
    this.pending = new Map();
    this.nextId = 0;
    this.items = new Map();
    this.slots = [];
    this.revision = 0;
    this.roots = options.roots;
    // Electron renderers cannot create Node worker_threads. A Node-mode helper
    // keeps the native path semantics without enabling Node in browser workers.
    this.worker = fork(path.join(__dirname, "file-index-worker.js"), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: [],
      windowsHide: true,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.worker.on("message", ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    this.worker.on("error", (error) => this.close(error));
    this.worker.on("exit", (code) => {
      if (!this.closed) this.close(new Error(`File index worker exited (${code})`));
    });
    this.tail = this.request("init", options);
    void this.tail.catch(() => {});
  }

  request(type, data = {}) {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.send({ ...data, id, type }, (error) => {
          if (error) this.close(error);
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  enqueue(callback) {
    const operation = this.tail.then(callback);
    this.tail = operation.catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
    void this.tail.catch(() => {});
    void operation.catch(() => {});
    return operation;
  }

  apply(added, removed) {
    return this.enqueue(async () => {
      let changed = false;
      for (const [kind, paths] of [
        ["removed", removed],
        ["added", added],
      ]) {
        for (let offset = 0; offset < paths.length; offset += 2048) {
          const result = await this.request("apply", {
            added: kind === "added" ? paths.slice(offset, offset + 2048) : [],
            removed: kind === "removed" ? paths.slice(offset, offset + 2048) : [],
          });
          for (const { key, slot } of result.removed) {
            this.items.delete(key);
            this.slots[slot] = null;
            changed = true;
          }
          for (const [key, slot, root, fPath, aPath, nPath, depthDivisor] of result.added) {
            const item = {
              key,
              slot,
              pPath: this.roots[root].path,
              fPath,
              aPath: aPath ?? key,
              nPath,
              depthPath: fPath,
              depthDivisor,
            };
            this.items.set(item.key, item);
            this.slots[item.slot] = item;
            changed = true;
          }
        }
      }
      if (changed) this.revision++;
      return changed;
    });
  }

  snapshot(referencePath, previous, signal) {
    return this.enqueue(async () => {
      checkSignal(signal);
      if (
        previous?.revision === this.revision &&
        referenceDirectory(previous.referencePath) === referenceDirectory(referencePath)
      )
        return previous;
      const { count } = await this.request("snapshot", { referencePath });
      const items = [],
        bySlot = [];
      for (let offset = 0; offset < count; offset += 2048) {
        checkSignal(signal);
        const values = await this.request("page", { offset });
        for (let index = 0; index < values.length; index += 2) {
          const slot = values[index],
            distance = values[index + 1];
          const old = previous?.bySlot[slot];
          const item =
            old?.distance === distance && old.aPath === this.slots[slot].aPath
              ? old
              : Object.freeze({ ...this.slots[slot], distance });
          items.push(item);
          bySlot[slot] = item;
        }
      }
      checkSignal(signal);
      return { revision: this.revision, referencePath, items: Object.freeze(items), bySlot };
    });
  }

  close(error = Object.assign(new Error("File index closed"), { name: "AbortError" })) {
    if (this.closed) return;
    this.closed = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    return new Promise((resolve) => {
      if (this.worker.exitCode !== null || this.worker.signalCode !== null) return resolve();
      this.worker.once("exit", resolve);
      this.worker.kill();
    });
  }
};
