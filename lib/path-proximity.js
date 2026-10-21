const path = require("node:path");

// Keep the existing ranking's separator-count definition, including UNC roots.
function pathDepth(value) {
  let depth = 1;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 47 || code === 92) depth++;
  }
  return depth;
}

class PathProximity {
  constructor(referencePath, pathImplementation = path) {
    this.path = pathImplementation;
    this.directory = referenceDirectory(referencePath, this.path);
    this.windows = this.path.sep === "\\";
    this.expandingCase =
      this.windows &&
      this.directory != null &&
      this.directory.toLowerCase().length !== this.directory.length;
    this.directories = new Map();
    this.files = new Map();
  }

  // Candidates already have absolute normalized paths from the project index.
  distanceTo(filePath) {
    if (this.directory == null) return 1;
    const cached = this.files.get(filePath);
    if (cached !== undefined) return cached;
    const parent = this.path.dirname(filePath);
    let prepared = this.directories.get(parent);
    if (prepared === undefined) {
      const relative = this.path.relative(this.directory, parent);
      prepared = {
        distance: pathDepth(this.path.join(relative, "_")),
        // Ancestor candidates and length-changing Windows case folds need the
        // exact file-level operation. The common case is shared by a directory.
        exact:
          /^\.\.(?:[\\/]\.\.)*$/.test(relative) ||
          this.expandingCase ||
          (this.windows && parent.toLowerCase().length !== parent.length),
      };
      this.directories.set(parent, prepared);
    }
    const basename = this.path.basename(filePath);
    let distance = prepared.distance;
    if (
      prepared.exact ||
      filePath.endsWith(this.path.sep) ||
      (this.windows ? basename.toLowerCase().length !== basename.length : basename.includes("\\"))
    ) {
      distance = pathDepth(this.path.relative(this.directory, filePath));
    }
    this.files.set(filePath, distance);
    return distance;
  }

  clear() {
    this.directories.clear();
    this.files.clear();
  }
}

function referenceDirectory(referencePath, pathImplementation = path) {
  return typeof referencePath === "string" && pathImplementation.isAbsolute(referencePath)
    ? pathImplementation.resolve(pathImplementation.dirname(referencePath))
    : null;
}

module.exports = { PathProximity, pathDepth, referenceDirectory };
