const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const windows = process.platform === "win32";
const printableCharacters = Array.from({ length: 95 }, (_, index) =>
  String.fromCharCode(index + 32),
).filter((character) => (windows ? !'<>:"/\\|?*'.includes(character) : character !== "/"));
const unicodeNames = [
  "zażółć",
  "漢字",
  "😀",
  "e\u0301",
  "non\u00a0breaking",
  "del\u007f",
  ...Array.from({ length: 32 }, (_, index) => `c1${String.fromCharCode(index + 128)}`),
];

function quotedPath(value, quote) {
  if (!windows) value = value.replaceAll("\\", "\\\\");
  value = value.replaceAll(quote, `\\${quote}`);
  return quote === "`" ? value.replaceAll("${", "\\${") : value;
}

describe("path completion filename symbols", () => {
  let editor;
  let provider;
  let rootPath;
  let originalProjectPaths;
  let files;
  let directories;
  let asciiFixtures;
  let unicodeFixtures;

  function createFile(relativePath) {
    const filePath = path.join(rootPath, relativePath);
    fs.writeFileSync(filePath, "");
    files.push(filePath);
    return filePath;
  }

  function createDirectory(name) {
    const directoryPath = path.join(rootPath, name);
    fs.mkdirSync(directoryPath);
    directories.push(directoryPath);
  }

  function symbolFixture(symbol, identifier) {
    const basename = `item${identifier}${symbol}tail.txt`;
    const directory = `folder${identifier}${symbol}tail`;
    createFile(basename);
    createDirectory(directory);
    createFile(path.join(directory, "inside.txt"));
    return { symbol, basename, directory };
  }

  function assertOwnedPath(filePath) {
    const relative = path.relative(rootPath, path.resolve(filePath));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Refusing to remove a path outside the temporary fixture: ${filePath}`);
    }
  }

  beforeEach(async () => {
    originalProjectPaths = lumine.project.getPaths();
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-files-symbols-"));
    files = [];
    directories = [];
    asciiFixtures = printableCharacters.map((symbol) =>
      symbolFixture(symbol, symbol.charCodeAt(0)),
    );
    unicodeFixtures = unicodeNames.map((symbol, index) => symbolFixture(symbol, `unicode${index}`));
    for (const name of [".hidden.txt", "..double.txt", "template${name}tail.txt"]) createFile(name);
    for (const name of ["html&tail.html", "html'tail.html"]) createFile(name);
    if (!windows) {
      for (const name of ['html"tail.html', "html<tail.html"]) createFile(name);
    }
    const editorPath = createFile("current.txt");

    lumine.config.set("core.ignoredNames", []);
    lumine.config.set("core.excludeVcsIgnoredPaths", false);
    lumine.config.set("fuzzy-files.ignoredNames", []);
    lumine.config.set("fuzzy-files.pathCompletion.normalizeSlashes", true);
    lumine.project.setPaths([rootPath]);
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("fuzzy-files");
    provider = pack.mainModule.provideAutocomplete();
    editor = await lumine.workspace.open(editorPath);
    await pack.mainModule.refresh();
    if (lumine.project.isIndexing()) {
      await new Promise((resolve) => {
        let subscription;
        subscription = lumine.project.observeFilePaths(({ indexing }) => {
          if (indexing) return;
          subscription?.dispose();
          resolve();
        });
        if (!lumine.project.isIndexing()) {
          subscription.dispose();
          resolve();
        }
      });
    }
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
    editor?.destroy();
    lumine.project.setPaths(originalProjectPaths);
    const relativeRoot = path.relative(path.resolve(os.tmpdir()), path.resolve(rootPath));
    if (
      !relativeRoot ||
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRoot) ||
      !path.basename(rootPath).startsWith("fuzzy-files-symbols-")
    ) {
      throw new Error(`Refusing to remove an unexpected temporary fixture: ${rootPath}`);
    }
    for (const filePath of files) {
      assertOwnedPath(filePath);
      fs.unlinkSync(filePath);
    }
    for (const directoryPath of directories.reverse()) {
      assertOwnedPath(directoryPath);
      fs.rmdirSync(directoryPath);
    }
    fs.rmdirSync(rootPath);
  });

  async function suggestionsFor(prefix, quote = '"') {
    return suggestionsForLine(`// ${quote}${prefix}`);
  }

  async function suggestionsForLine(line, scopes = ["text.plain"]) {
    editor.setText(line);
    editor.setCursorBufferPosition([0, Infinity]);
    return provider.getSuggestions({
      editor,
      bufferPosition: editor.getCursorBufferPosition(),
      scopeDescriptor: { getScopesArray: () => scopes },
      prefix: "",
    });
  }

  async function expectFileSuggestion(fixture, quote = '"') {
    const prefix = quotedPath(`./${fixture.basename.slice(0, -4)}`, quote);
    const suggestions = await suggestionsFor(prefix, quote);
    expect(
      suggestions.map(({ text, displayText, replacementPrefix }) => ({
        text,
        displayText,
        replacementPrefix,
      })),
    )
      .withContext(`filename ${JSON.stringify(fixture.basename)} in ${quote}`)
      .toEqual([
        {
          text: quotedPath(`./${fixture.basename}`, quote),
          displayText: fixture.basename,
          replacementPrefix: prefix,
        },
      ]);
  }

  async function expectDirectorySuggestion(fixture, quote = '"') {
    const prefix = quotedPath(`./${fixture.directory}/ins`, quote);
    const suggestions = await suggestionsFor(prefix, quote);
    expect(
      suggestions.map(({ text, displayText, replacementPrefix }) => ({
        text,
        displayText,
        replacementPrefix,
      })),
    )
      .withContext(`directory ${JSON.stringify(fixture.directory)} in ${quote}`)
      .toEqual([
        {
          text: quotedPath(`./${fixture.directory}/inside.txt`, quote),
          displayText: "inside.txt",
          replacementPrefix: prefix,
        },
      ]);
  }

  it("indexes real files containing every printable ASCII character allowed by the platform", () => {
    expect(printableCharacters.length).toBe(windows ? 86 : 94);
    const indexedFiles = new Set(lumine.project.getFilePathsForRoot(rootPath));
    for (const filePath of files) {
      expect(indexedFiles.has(filePath)).withContext(JSON.stringify(filePath)).toBe(true);
    }
  });

  it("completes all allowed printable ASCII characters in filenames", async () => {
    for (const fixture of asciiFixtures) {
      await expectFileSuggestion(fixture, fixture.symbol === '"' ? "'" : '"');
    }
  });

  it("resolves directories containing all allowed printable ASCII characters", async () => {
    for (const fixture of asciiFixtures) {
      await expectDirectorySuggestion(fixture, fixture.symbol === '"' ? "'" : '"');
    }
  });

  it("preserves Unicode, combining characters, nonbreaking spaces, DEL and C1", async () => {
    for (const fixture of unicodeFixtures) {
      await expectFileSuggestion(fixture);
      await expectDirectorySuggestion(fixture);
    }
  });

  it("escapes a matching enclosing quote while preserving the displayed filename", async () => {
    for (const quote of ["'", '"', "`"]) {
      const fixture = asciiFixtures.find(({ symbol }) => symbol === quote);
      if (!fixture) continue;
      const prefix = `./item${quote.charCodeAt(0)}`;
      const suggestions = await suggestionsFor(prefix, quote);
      expect(suggestions[0]?.text).toBe(quotedPath(`./${fixture.basename}`, quote));
      expect(suggestions[0]?.displayText).toBe(fixture.basename);
      expect(suggestions[0]?.replacementPrefix).toBe(prefix);
      await expectFileSuggestion(fixture, quote);
      await expectDirectorySuggestion(fixture, quote);
    }
  });

  it("escapes template interpolation in inserted paths and accepts the escaped prefix", async () => {
    const basename = "template${name}tail.txt";
    const prefix = "./template";
    const suggestions = await suggestionsFor(prefix, "`");
    expect(suggestions.map(({ text }) => text)).toEqual(["./template\\${name}tail.txt"]);
    expect(suggestions[0]?.displayText).toBe(basename);
    expect(suggestions[0]?.replacementPrefix).toBe(prefix);
    await expectFileSuggestion({ basename }, "`");
  });

  it("keeps the current-directory marker for dotfiles", async () => {
    for (const basename of [".hidden.txt", "..double.txt"]) {
      await expectFileSuggestion({ basename });
    }
  });

  it("encodes HTML path attributes as entities and matches their decoded filenames", async () => {
    lumine.config.set("fuzzy-files.pathCompletion.enableHtmlSupport", true);
    const cases = [
      {
        quote: '"',
        prefix: "./html&amp;tai",
        basename: "html&tail.html",
        text: "./html&amp;tail.html",
      },
      {
        quote: "'",
        prefix: "./html&#39;tai",
        basename: "html'tail.html",
        text: "./html&#39;tail.html",
      },
    ];
    if (!windows) {
      cases.push(
        {
          quote: '"',
          prefix: "./html&quot;tai",
          basename: 'html"tail.html',
          text: "./html&quot;tail.html",
        },
        {
          quote: '"',
          prefix: "./html&lt;tai",
          basename: "html<tail.html",
          text: "./html&lt;tail.html",
        },
      );
    }
    for (const { quote, prefix, basename, text } of cases) {
      const suggestions = await suggestionsForLine(`<img src=${quote}${prefix}`, [
        "text.html.basic",
      ]);
      expect(suggestions.map(({ text }) => text))
        .withContext(basename)
        .toEqual([text]);
      expect(suggestions[0]?.displayText).toBe(basename);
      expect(suggestions[0]?.replacementPrefix).toBe(prefix);
    }
  });

  if (!windows) {
    it("distinguishes escaped literal filename backslashes from path separators", async () => {
      const fixture = asciiFixtures.find(({ symbol }) => symbol === "\\");
      for (const quote of ["'", '"', "`"]) {
        await expectFileSuggestion(fixture, quote);
        await expectDirectorySuggestion(fixture, quote);
      }
    });
  }
});
