const path = require("node:path");
const { PathProximity, pathDepth, referenceDirectory } = require("./path-proximity");

const items = new Map();
const freeSlots = [];
let roots,
  rules,
  caseInsensitive,
  nextSlot = 0;
let ordered = [],
  dirty = new Set(),
  proximity;
let snapshot;

function ignored(relative) {
  if (rules.length === 0) return false;
  let prefix = "";
  for (const part of relative.replace(/\\/g, "/").split("/").filter(Boolean)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (rules.some(({ anchored, regex }) => regex.test(anchored ? prefix : part))) return true;
  }
  return false;
}

function prepare(aPath) {
  const full = process.platform === "win32" ? aPath.replaceAll("/", "\\") : aPath;
  const comparable = caseInsensitive ? full.toLowerCase() : full;
  let pPath = null,
    fPath = full,
    rootIndex;
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (let prefix of root.paths) {
      if (caseInsensitive) prefix = prefix.toLowerCase();
      const directoryPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
      const relative =
        comparable === prefix
          ? ""
          : comparable.startsWith(directoryPrefix)
            ? comparable.length === full.length
              ? full.slice(directoryPrefix.length)
              : full
                  // Case folding can expand a character (İ → i + combining dot).
                  // Directory boundaries survive it, original character offsets do not.
                  .split(path.sep)
                  .slice(directoryPrefix.split(path.sep).length - 1)
                  .join(path.sep)
            : null;
      if (relative !== null) {
        if (relative.length < fPath.length) {
          pPath = root.path;
          rootIndex = index;
          fPath = relative;
        }
        break;
      }
    }
  }
  if (!pPath || !fPath) return null;
  fPath = path.normalize(fPath);
  if (ignored(fPath)) return null;
  return {
    pPath,
    rootIndex,
    fPath,
    aPath: path.join(pPath, fPath),
    nPath: path.basename(fPath),
    depthPath: fPath,
    depthDivisor: Math.sqrt(pathDepth(fPath)),
    slot: freeSlots.length ? freeSlots.pop() : nextSlot++,
  };
}

function materialize() {
  if (!dirty.size) return;
  const added = [];
  for (const key of dirty) if (items.has(key)) added.push(items.get(key));
  added.sort(compare);
  // Merge the small sorted delta into the unchanged order; never re-sort the corpus.
  const merged = [];
  let cursor = 0;
  for (const item of ordered) {
    if (dirty.has(item.key)) continue;
    while (cursor < added.length && compare(added[cursor], item) < 0) merged.push(added[cursor++]);
    merged.push(item);
  }
  while (cursor < added.length) merged.push(added[cursor++]);
  ordered = merged;
  dirty.clear();
}
function compare(a, b) {
  return a.aPath < b.aPath ? -1 : a.aPath > b.aPath ? 1 : 0;
}

process.on("message", ({ id, type, ...data }) => {
  try {
    let result;
    if (type === "init") {
      ({ roots, rules, caseInsensitive } = data);
    } else if (type === "apply") {
      const added = [],
        removed = [];
      for (const key of data.removed) {
        const item = items.get(key);
        if (item) {
          removed.push({ key, slot: item.slot });
          proximity?.files.delete(item.aPath);
          proximity?.directories.delete(path.dirname(item.aPath));
          freeSlots.push(item.slot);
        }
        items.delete(key);
        dirty.add(key);
      }
      for (const key of data.added) {
        if (items.has(key)) continue;
        const item = prepare(key);
        if (item) {
          item.key = key;
          items.set(key, item);
          dirty.add(key);
          // Compact wire rows avoid repeating property names, roots and identical
          // absolute/relative strings for every file in a large initial batch.
          added.push([
            key,
            item.slot,
            item.rootIndex,
            item.fPath,
            item.aPath === key ? null : item.aPath,
            item.nPath,
            item.depthDivisor,
          ]);
        }
      }
      result = { added, removed };
    } else if (type === "snapshot") {
      materialize();
      if (proximity?.directory !== referenceDirectory(data.referencePath))
        proximity = new PathProximity(data.referencePath);
      snapshot = ordered;
      result = { count: snapshot.length };
    } else if (type === "page") {
      const end = Math.min(snapshot.length, data.offset + 2048);
      const values = new Uint32Array((end - data.offset) * 2);
      for (let i = data.offset; i < end; i++) {
        const item = snapshot[i];
        values[(i - data.offset) * 2] = item.slot;
        values[(i - data.offset) * 2 + 1] = proximity.distanceTo(item.aPath);
      }
      result = values;
    } else throw new Error(`Unknown file-index request: ${type}`);
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
