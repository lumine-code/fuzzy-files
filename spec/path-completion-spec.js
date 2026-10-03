const path = require("node:path");

describe("fuzzy-files", () => {
  let editor;
  let provider;
  let main;
  let projectDirectory;

  beforeEach(async () => {
    lumine.config.set("fuzzy-files.ignoredNames", ["tests"]);
    lumine.config.set("core.excludeVcsIgnoredPaths", false);
    jasmine.attachToDOM(lumine.workspace.getElement());

    await lumine.packages.activatePackage("language-javascript");
    const pack = await lumine.packages.activatePackage("fuzzy-files");
    main = pack.mainModule;
    editor = await lumine.workspace.open(path.join(__dirname, "fixtures", "tests", "test-file.js"));
    provider = pack.mainModule.provideAutocomplete();
    projectDirectory = lumine.project.getDirectories()[0];
    // The provider takes no interest in the file index until a request lands in
    // a path scope, so a spec that asks about candidates has to wake it first.
    await pack.mainModule.refresh();
    await whenIndexed();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
  });

  function whenIndexed() {
    if (!lumine.project.isIndexing()) return Promise.resolve();
    return new Promise((resolve) => {
      const subscription = lumine.project.observeFilePaths(({ indexing }) => {
        if (indexing) return;
        subscription.dispose();
        resolve();
      });
    });
  }

  async function suggestionsFor(text, position = [0, Infinity], scopes = null) {
    editor.setText(text);
    editor.setCursorBufferPosition(position);
    const cursor = editor.getLastCursor();
    return provider.getSuggestions({
      editor,
      bufferPosition: cursor.getBufferPosition(),
      scopeDescriptor: scopes ? { getScopesArray: () => scopes } : cursor.getScopeDescriptor(),
      prefix: cursor.getCurrentWordBufferRange
        ? editor.getTextInBufferRange(cursor.getCurrentWordBufferRange())
        : "",
    });
  }

  it("implements the Lumine autocomplete provider contract", () => {
    expect(provider.scopeSelector).toBe("*");
    expect(provider.selector).toBeUndefined();
  });

  it("reads the same filtered project files as the finder", () => {
    const files = lumine.project.getFilePathsForRoot(projectDirectory);
    expect(files.some((filePath) => filePath.endsWith(path.join("somedir", "testfile.js")))).toBe(
      true,
    );
    // The index holds everything core policy allows, including the `tests`
    // directory this package excludes from both the finder and suggestions.
    expect(files.some((filePath) => filePath.includes(`${path.sep}tests${path.sep}`))).toBe(true);
    expect(lumine.project.isIndexing()).toBe(false);
  });

  it("suggests every matching file type in an import context", async () => {
    const suggestions = await suggestionsFor("require('test");
    expect(suggestions.map(({ displayText }) => displayText)).toEqual([
      "somedir/testfile.js",
      "somedir/testdir/uninteresting.css",
      "somedir/testdir/nested-test-file.js",
    ]);
  });

  it("inserts relative paths without JavaScript extensions", async () => {
    const suggestions = await suggestionsFor("require('testfile");
    expect(suggestions[0].text).toBe("../somedir/testfile");
    expect(suggestions[0].replacementPrefix).toBe("testfile");
  });

  it("narrows suggestions inside an explicitly typed directory", async () => {
    const suggestions = await suggestionsFor("require('../somedir/test");
    expect(suggestions.map(({ displayText }) => displayText)).toContain("testfile.js");
    expect(suggestions.every(({ text }) => text.startsWith("../somedir/"))).toBe(true);
  });

  it("excludes its own ignored names from suggestions", async () => {
    const suggestions = await suggestionsFor("require('test");
    // The fixture lives under `tests/`, which `ignoredNames` names — the file
    // is in the index but must not be offered.
    expect(suggestions.every(({ displayText }) => !displayText.includes("tests/"))).toBe(true);
  });

  it("rebuilds the shared file list when ignored names change", async () => {
    spyOn(lumine.project, "refreshFilePaths").and.callThrough();
    lumine.config.set("fuzzy-files.ignoredNames", []);

    const suggestions = await suggestionsFor("require('test");
    expect(suggestions.map(({ displayText }) => displayText)).toContain("tests/test-file.js");
    expect(lumine.project.refreshFilePaths).not.toHaveBeenCalled();
  });

  describe("the path-syntax trigger", () => {
    // `./` and `../` are a path in any language, so they trigger everywhere
    // rather than only inside a language's import statement.
    it("completes a relative path written in a comment", async () => {
      const suggestions = await suggestionsFor("// see ../somedir/testf");
      expect(suggestions.map(({ text }) => text)).toContain("../somedir/testfile.js");
    });

    it("keeps the extension a language scope would have stripped", async () => {
      // The JavaScript scope's replaceOnInsert drops `.js` because an import
      // does not want it; prose does.
      const inComment = await suggestionsFor("// ../somedir/testf");
      const inImport = await suggestionsFor("require('../somedir/testf");
      expect(inComment[0].text).toBe("../somedir/testfile.js");
      expect(inImport[0].text).toBe("../somedir/testfile");
    });

    it("does not offer a file twice when a language scope also matches", async () => {
      const suggestions = await suggestionsFor("require('../somedir/testf");
      const texts = suggestions.map(({ text }) => text);
      // `require('../` satisfies both the JavaScript scope and the generic
      // trigger, and the results are flattened together.
      expect(new Set(texts).size).toBe(texts.length);
    });

    it("takes the last path on the line, not the first", async () => {
      // An earlier path must not extend the replacement range of the active one.
      const suggestions = await suggestionsFor("// ./a.js and ../somedir/testf");
      expect(suggestions.map(({ text }) => text)).toContain("../somedir/testfile.js");
    });

    it("completes quoted paths containing spaces and closing brackets", async () => {
      const prefix = "../somedir/spaced dir [draft]/report ] f";
      for (const quote of ["'", '"', "`"]) {
        const suggestions = await suggestionsFor(`// ${quote}${prefix}`);
        expect(suggestions.map(({ text }) => text)).toContain(
          "../somedir/spaced dir [draft]/report ] final.js",
        );
        expect(suggestions.every(({ replacementPrefix }) => replacementPrefix === prefix)).toBe(
          true,
        );
      }
    });

    it("keeps language insertion rules for paths containing spaces and brackets", async () => {
      const prefix = "../somedir/spaced dir [draft]/report ] f";
      const suggestions = await suggestionsFor(`require('${prefix}`);
      expect(suggestions.map(({ text }) => text)).toEqual([
        "../somedir/spaced dir [draft]/report ] final",
      ]);
      expect(suggestions[0].replacementPrefix).toBe(prefix);
    });

    it("completes at a caret before an existing closing quote", async () => {
      const prefix = "../somedir/spaced dir [draft]/report ] f";
      const line = `const file = "${prefix}";`;
      const suggestions = await suggestionsFor(line, [0, line.length - 2]);
      expect(suggestions.map(({ text }) => text)).toEqual([
        "../somedir/spaced dir [draft]/report ] final.js",
      ]);
      expect(suggestions[0].replacementPrefix).toBe(prefix);
    });

    it("completes a bare filename containing a closing bracket", async () => {
      const suggestions = await suggestionsFor("// ../somedir/closing]");
      expect(suggestions.map(({ text }) => text)).toContain("../somedir/closing].js");
      expect(suggestions[0].replacementPrefix).toBe("../somedir/closing]");
    });

    it("keeps balanced brackets inside bare filenames", async () => {
      const suggestions = await suggestionsFor("// ../somedir/balanced[final]");
      expect(suggestions.map(({ text }) => text)).toContain("../somedir/balanced[final].js");
    });

    it("completes bare paths with spaces only as literal filename prefixes", async () => {
      const suggestions = await suggestionsFor("// ../somedir/spaced dir [draft]/report ] f");
      expect(suggestions.map(({ text }) => text)).toEqual([
        "../somedir/spaced dir [draft]/report ] final.js",
      ]);
      expect(await suggestionsFor("// ../somedir/spaced dir [draft]/r ] f")).toEqual([]);
      expect(await suggestionsFor("// ../somedir/testfile.js and more text")).toEqual([]);
    });

    it("stays inside the explicitly typed directory even when its name contains spaces", async () => {
      const suggestions = await suggestionsFor("// '../somedir/spaced dir [draft]/");
      expect(suggestions.map(({ text }) => text)).toEqual([
        "../somedir/spaced dir [draft]/report ] final.js",
      ]);
    });

    it("stops after a matching surrounding bracket closes the bare path", async () => {
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
        ["<", ">"],
      ]) {
        expect(await suggestionsFor(`// ${open}../somedir/testf${close}`)).toEqual([]);
      }
    });

    it("stops after a quote or statement closes the path", async () => {
      for (const line of [
        "// '../somedir/testf'",
        '// "../somedir/testf"',
        "// `../somedir/testf`",
        "// ../somedir/testf;",
        "require('../somedir/testf')",
        "require('../somedir/testf');",
      ]) {
        expect(await suggestionsFor(line)).toEqual([]);
      }
    });

    it("takes the latest open path after a closed quoted path", async () => {
      const prefix = "../somedir/spaced dir [draft]/report ] f";
      const suggestions = await suggestionsFor(`// '../somedir/closing].js' and '${prefix}`);
      expect(suggestions.map(({ text }) => text)).toEqual([
        "../somedir/spaced dir [draft]/report ] final.js",
      ]);
      expect(suggestions[0].replacementPrefix).toBe(prefix);
    });

    it("uses the generic extension policy after a closed import", async () => {
      const suggestions = await suggestionsFor("require('../somedir/closing]'); ../somedir/testf");
      expect(suggestions[0].text).toBe("../somedir/testfile.js");
      expect(suggestions.every(({ text }) => text.endsWith(".js"))).toBe(true);
      expect(suggestions[0].replacementPrefix).toBe("../somedir/testf");
    });

    it("takes the latest open import on a line", async () => {
      for (const line of [
        "require('closing]'); require('../somedir/testf",
        "import old from '../somedir/closing]'; require('../somedir/testf",
      ]) {
        const suggestions = await suggestionsFor(line);
        expect(suggestions[0].text).toBe("../somedir/testfile");
        expect(suggestions.every(({ text }) => !text.endsWith(".js"))).toBe(true);
        expect(suggestions[0].replacementPrefix).toBe("../somedir/testf");
      }
    });

    it("recognizes parent-directory backslashes and normalizes the inserted path", async () => {
      const prefix = "..\\somedir\\testf";
      const suggestions = await suggestionsFor(`// ${prefix}`);
      expect(suggestions[0].text).toBe("../somedir/testfile.js");
      expect(suggestions.every(({ text }) => text.startsWith("../somedir/"))).toBe(true);
      expect(suggestions[0].replacementPrefix).toBe(prefix);
    });

    it("recognizes current-directory backslashes on every platform", async () => {
      editor = await lumine.workspace.open(
        path.join(__dirname, "fixtures", "somedir", "testfile.js"),
      );
      const suggestions = await suggestionsFor("// .\\testf");
      expect(suggestions[0].text).toBe("./testfile.js");
      expect(suggestions.every(({ text }) => text.startsWith("./"))).toBe(true);
      expect(suggestions[0].replacementPrefix).toBe(".\\testf");
    });

    it("matches backslash import queries when inserted slashes are not normalized", async () => {
      lumine.config.set("fuzzy-files.pathCompletion.normalizeSlashes", false);
      const prefix = "somedir\\test";
      const suggestions = await suggestionsFor(`require('${prefix}`);
      expect(suggestions[0].displayText).toBe(path.join("somedir", "testfile.js"));
      expect(suggestions[0].text).toBe(
        path.join("..", "somedir", "testfile").replaceAll("\\", "\\\\"),
      );
      expect(suggestions[0].replacementPrefix).toBe(prefix);
    });

    it("offers nothing once the path leaves the project root", async () => {
      const suggestions = await suggestionsFor("// ../../../../../");
      expect(suggestions).toEqual([]);
    });

    it("allows child directories whose names begin with two dots", async () => {
      const filePath = path.join(projectDirectory.getPath(), "..assets", "asset.js");
      spyOn(lumine.project, "getFilePaths").and.returnValue([filePath]);
      main.rebuildItems();
      const suggestions = await suggestionsFor("// ../..assets/as");
      expect(suggestions.map(({ text }) => text)).toEqual(["../..assets/asset.js"]);
    });

    it("stays quiet on text that merely contains a dot or an at-sign", async () => {
      expect(await suggestionsFor("// version 3.5 released")).toEqual([]);
      expect(await suggestionsFor("// mail someone@example.com")).toEqual([]);
      expect(await suggestionsFor(" * @param {String} value")).toEqual([]);
    });

    it("outranks a language server's completions", () => {
      // Providers are ordered by suggestionPriority, and the tiebreak is scope
      // specificity — which a `*` selector always loses. At an equal priority a
      // language server's whole identifier list would therefore be concatenated
      // ahead of the paths and bury them, which is why this sits above the 2 an
      // LSP provider reports. Safe because this provider answers with nothing
      // at all unless a path prefix matched.
      expect(provider.suggestionPriority).toBeGreaterThan(2);
    });
  });

  describe("built-in scope syntax", () => {
    beforeEach(() => {
      const rootPath = projectDirectory.getPath();
      spyOn(lumine.project, "getFilePaths").and.returnValue([
        path.join(rootPath, "somedir", "matching.js"),
        path.join(rootPath, "somedir", "style.css"),
        path.join(rootPath, "somedir", "image.png"),
        path.join(rootPath, "somedir", "header.hpp"),
      ]);
      main.rebuildItems();
    });

    it("accepts whitespace around require and dynamic import parentheses", async () => {
      for (const line of ["require ( 'matching", "import ( 'matching"]) {
        const suggestions = await suggestionsFor(line);
        expect(suggestions.map(({ text }) => text)).toEqual(["../somedir/matching"]);
        expect(suggestions[0].replacementPrefix).toBe("matching");
      }
    });

    it("accepts whitespace around HTML path attribute assignments", async () => {
      lumine.config.set("fuzzy-files.pathCompletion.enableHtmlSupport", true);
      for (const line of ['<img src = "matching', "<a href = 'matching"]) {
        const suggestions = await suggestionsFor(line, [0, Infinity], ["text.html.basic"]);
        expect(suggestions.map(({ text }) => text)).toEqual(["../somedir/matching.js"]);
        expect(suggestions[0].replacementPrefix).toBe("matching");
      }
    });

    it("does not treat an HTML element name as a file path", async () => {
      lumine.config.set("fuzzy-files.pathCompletion.enableHtmlSupport", true);
      const suggestions = await suggestionsFor(
        '<input name = "matching',
        [0, Infinity],
        ["text.html.basic"],
      );
      expect(suggestions).toEqual([]);
    });

    it("accepts whitespace before a quoted CSS URL and keeps its image extension", async () => {
      editor = await lumine.workspace.open(
        path.join(__dirname, "fixtures", "somedir", "testfile.js"),
      );
      const suggestions = await suggestionsFor(
        "background: url( './im",
        [0, Infinity],
        ["source.css"],
      );
      expect(suggestions.map(({ text }) => text)).toEqual(["./image.png"]);
      expect(suggestions[0].replacementPrefix).toBe("./im");
    });

    it("completes angle-bracket includes only while the include remains open", async () => {
      const suggestions = await suggestionsFor("#include <header", [0, Infinity], ["source.cpp"]);
      expect(suggestions.map(({ text }) => text)).toEqual(["../somedir/header.hpp"]);
      expect(suggestions[0].replacementPrefix).toBe("header");
      expect(await suggestionsFor("#include <header>", [0, Infinity], ["source.cpp"])).toEqual([]);
    });
  });

  describe("custom scope boundaries", () => {
    beforeEach(() => {
      lumine.config.set("fuzzy-files.pathCompletion.ignoreBuiltinScopes", true);
      lumine.config.set("fuzzy-files.pathCompletion.scopes", [
        {
          scopes: ["source.js"],
          prefixes: ["asset\\(['\"]"],
          relative: true,
          projectRelativePath: true,
          replaceOnInsert: [["\\.js$", ".asset"]],
        },
      ]);
    });

    it("validates the latest suffix without losing custom insertion settings", async () => {
      const suggestions = await suggestionsFor("asset('closing]'); asset('balanced[fi");
      expect(suggestions.map(({ text }) => text)).toEqual(["somedir/balanced[final].asset"]);
      expect(suggestions[0].replacementPrefix).toBe("balanced[fi");
    });

    it("rejects a closed custom scope", async () => {
      expect(await suggestionsFor("asset('balanced[fi')")).toEqual([]);
    });
  });
});
