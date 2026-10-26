const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DefaultScopes } = require("./path-default-scopes");
const { OptionScopes } = require("./path-option-scopes");
const { relativePathContext, scopePathContext } = require("./path-context");
const { decodePathPrefix, encodePath } = require("./path-encoding");
const pathRequest = require("./path-request");

function withForwardSlashes(value) {
  return value.replaceAll(path.sep, "/");
}

function fuzzyScore(candidate, query) {
  if (!query) return 0;
  const text = candidate.toLowerCase();
  const needle = query.toLowerCase();
  const directIndex = text.indexOf(needle);
  if (directIndex >= 0) return 1000 - directIndex - text.length / 1000;

  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const index = text.indexOf(character, cursor);
    if (index < 0) return Number.NEGATIVE_INFINITY;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return 100 - gaps - text.length / 1000;
}

function lineForRequest({ editor, bufferPosition }) {
  const configured = lumine.config.get("fuzzy-files.pathCompletion.maximumContextLength");
  const limit = Math.min(
    require("node:buffer").constants.MAX_STRING_LENGTH,
    Number.isSafeInteger(configured) && configured > 0 ? configured : 65536,
  );
  if (bufferPosition.column > limit) return null;
  return editor.getTextInRange([[bufferPosition.row, 0], bufferPosition]);
}

function scopeMatch(scope, request, getLine) {
  const sourceScopes = Array.isArray(scope.scopes) ? scope.scopes : [scope.scopes];
  const activeScopes = request.scopeDescriptor.getScopesArray();
  // `*` is every grammar, for a trigger that keys on path syntax rather than on
  // a language's import statement.
  const scoped =
    sourceScopes.includes("*") ||
    sourceScopes.some((scopeName) => activeScopes.includes(scopeName));
  if (!scoped) return null;

  const line = getLine();
  if (line == null) return null;
  if (scope.pathSyntax) return relativePathContext(line);
  const prefixes = Array.isArray(scope.prefixes) ? scope.prefixes : [scope.prefixes];
  return scopePathContext(line, prefixes, { encoding: scope.pathEncoding });
}

// Whether a resolved directory is the root or below it. `path.relative` rather
// than a prefix compare: it normalizes separators and, on Windows, ignores case
// the way the filesystem does.
function isInsideRoot(directoryPath, rootPath) {
  const relative = path.relative(rootPath, directoryPath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function projectDirectoryForEditor(editor) {
  const filePath = editor.getPath();
  if (!filePath) return null;
  return lumine.project.getDirectories().find((directory) => directory.contains(filePath)) || null;
}

function imageIcon(filePath) {
  const url = pathToFileURL(filePath).href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<img class="fuzzy-files-path-image" src="${url}" alt="" />`;
}

class PathsProvider {
  // The package owns the file model and its subscription. Constructing a
  // provider and consuming it never initializes the model or the finder UI.
  constructor(source) {
    this.source = source;
    this.activationGeneration = source.activationGeneration;
    this.scopeSelector = "*";
    this.inclusionPriority = 1;
    this.reloadScopes();
  }

  get enabled() {
    return (
      this.source.disposables != null &&
      this.activationGeneration === this.source.activationGeneration &&
      lumine.config.get("fuzzy-files.pathCompletion.enabled") !== false
    );
  }

  reloadScopes() {
    this.scopes = [...(lumine.config.get("fuzzy-files.pathCompletion.scopes") || [])];
    if (!lumine.config.get("fuzzy-files.pathCompletion.ignoreBuiltinScopes")) {
      this.scopes.push(...DefaultScopes);
    }
    for (const [key, scopes] of Object.entries(OptionScopes)) {
      if (lumine.config.get(`fuzzy-files.pathCompletion.${key}`)) this.scopes.push(...scopes);
    }
  }

  async suggestionsForScope(scope, request, context, current = () => true) {
    if (!current()) return [];
    // A path is completed relative to the file holding it, so an editor with no
    // path has nothing to be relative to and nothing to resolve `./` against.
    const editorPath = request.editor.getPath();
    const projectDirectory = projectDirectoryForEditor(request.editor);
    if (!editorPath || !projectDirectory) return [];

    const rootPath = projectDirectory.getPath();
    const currentDirectory = path.dirname(editorPath);

    const { pathPrefix } = context;
    const lookupPrefix = decodePathPrefix(context, scope.pathEncoding);
    const hasTrailingSlash = lookupPrefix.endsWith("/");
    const directoryGiven = /^\.{1,2}\//.test(lookupPrefix);
    const parsedPrefix = path.parse(lookupPrefix);
    if (hasTrailingSlash) {
      parsedPrefix.dir = path.join(parsedPrefix.dir, parsedPrefix.base);
      parsedPrefix.base = "";
    }

    const query = directoryGiven ? parsedPrefix.base : lookupPrefix;
    const normalizeSlashes = lumine.config.get("fuzzy-files.pathCompletion.normalizeSlashes");
    const showImages = lumine.config.get("fuzzy-files.pathCompletion.imagePreview");
    const imagePattern = /\.(?:apng|cur|gif|ico|jpe?g|jfif|pjp|png|svg)$/i;

    const requestedDirectory = path.resolve(currentDirectory, parsedPrefix.dir);
    // Never step outside the project. The index cannot offer a file from outside
    // a root, but a `../../..` prefix still matches every file in the root and
    // would display each one relative to a directory above it.
    if (!isInsideRoot(requestedDirectory, rootPath)) return [];

    const ranked = [];
    for (const { aPath: filePath } of this.source.itemsByPath.values()) {
      if (!current()) return [];
      if (!isInsideRoot(filePath, rootPath)) continue;
      if (directoryGiven && !isInsideRoot(filePath, requestedDirectory)) {
        continue;
      }

      const projectRelativePath = path.relative(rootPath, filePath);
      const relativePath = path.relative(currentDirectory, filePath);
      let displayText = directoryGiven
        ? path.relative(requestedDirectory, filePath)
        : projectRelativePath;
      const matchText = withForwardSlashes(displayText);
      if (normalizeSlashes) displayText = withForwardSlashes(displayText);
      // In an unquoted path a space may also introduce prose. Only a literal
      // filename prefix can extend that span; ordinary basename queries stay fuzzy.
      const rank =
        !context.quoted && /\s/.test(query)
          ? matchText.toLowerCase().startsWith(query.toLowerCase())
            ? 1000 - matchText.length / 1000
            : Number.NEGATIVE_INFINITY
          : fuzzyScore(matchText, query);
      if (!Number.isFinite(rank)) continue;

      let text = scope.relative === false ? filePath : relativePath;
      if (
        scope.relative !== false &&
        scope.includeCurrentDirectory !== false &&
        !text.startsWith(`.${path.sep}`) &&
        !text.startsWith(`..${path.sep}`)
      ) {
        text = `.${path.sep}${text}`;
      }
      if (scope.projectRelativePath) text = projectRelativePath;
      if (normalizeSlashes) text = withForwardSlashes(text);
      for (const replacement of scope.replaceOnInsert || []) {
        try {
          text = text.replace(new RegExp(replacement[0]), replacement[1]);
        } catch (error) {
          console.warn("fuzzy-files: Invalid insertion replacement", replacement, error);
        }
      }
      text = encodePath(text, context, scope.pathEncoding);

      ranked.push({
        suggestion: {
          text,
          replacementPrefix: pathPrefix,
          displayText,
          type: "import",
          iconHTML: showImages && imagePattern.test(filePath) ? imageIcon(filePath) : undefined,
        },
        rank,
        distance: relativePath.split(path.sep).length,
      });
    }

    ranked.sort((left, right) => right.rank - left.rank || left.distance - right.distance);
    return ranked.slice(0, 10).map(({ suggestion }) => suggestion);
  }

  async getSuggestions(request) {
    return pathRequest(this, request, async (current) => {
      let line;
      const getLine = () => (line === undefined ? (line = lineForRequest(request)) : line);
      let matches = this.scopes
        .map((scope) => ({ scope, match: current() ? scopeMatch(scope, request, getLine) : null }))
        .filter(({ match }) => match);
      // After the scope test, not before: this is the first moment the package
      // genuinely needs the project's file paths, and subscribing is what builds
      // the index. A caret that never sits in a path prefix never costs a crawl.
      if (!current() || matches.length === 0 || !projectDirectoryForEditor(request.editor))
        return [];
      this.source.observeIndex();
      try {
        await this.source.whenPrepared();
      } catch (error) {
        if (current()) throw error;
        return [];
      }
      if (!current()) return [];

      // `require('./` satisfies both the JavaScript scope and the generic path
      // trigger, and the results are flattened together — so without this every
      // file would be offered twice, once with the language's `replaceOnInsert`
      // applied and once without. A language that has an opinion keeps it.
      const specific = matches.filter(({ scope }) => !scope.fallback);
      if (specific.length > 0) matches = specific;

      const suggestions = await Promise.all(
        matches.map(({ scope, match }) =>
          current() ? this.suggestionsForScope(scope, request, match, current) : [],
        ),
      );
      return current() ? suggestions.flat() : [];
    });
  }

  get suggestionPriority() {
    return lumine.config.get("fuzzy-files.pathCompletion.suggestionPriority");
  }
}

module.exports = PathsProvider;
