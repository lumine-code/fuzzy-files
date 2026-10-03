const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

describe("the shared finder and path-completion source", () => {
  let main, provider, editor, root, callbacks, paths, disposed;

  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-files-source-")));
    callbacks = new Set();
    paths = [path.join(root, "current.js"), path.join(root, "asset.png")];
    disposed = 0;
    lumine.project.setPaths([root]);
    lumine.config.set("fuzzy-files.ignoredNames", []);
    jasmine.attachToDOM(lumine.workspace.getElement());
    spyOn(lumine.project, "observeFilePaths").and.callFake((callback) => {
      callbacks.add(callback);
      callback({ added: paths.slice(), removed: [], indexing: false });
      return {
        dispose() {
          callbacks.delete(callback);
          disposed++;
        },
      };
    });
    spyOn(lumine.project, "getFilePaths").and.callFake(() => paths.slice());
    spyOn(lumine.project, "isIndexing").and.returnValue(false);
    spyOn(lumine.project, "refreshFilePaths").and.returnValue(Promise.resolve());
    const pack = await lumine.packages.startPackage("fuzzy-files");
    main = pack.mainModule;
    provider = main.provideAutocomplete();
    editor = await lumine.workspace.open(paths[0]);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
    editor?.destroy();
    // The fixture is an empty directory created by this suite; no recursive
    // cleanup is needed and no editor saves the virtual files into it.
    fs.rmdirSync(root);
  });

  function request(text, target = editor) {
    target.setText(text);
    target.setCursorBufferPosition([0, Infinity]);
    return provider.getSuggestions({
      editor: target,
      bufferPosition: target.getCursorBufferPosition(),
      scopeDescriptor: { getScopesArray: () => ["source.js"] },
      prefix: "",
    });
  }

  function emit(added, removed = []) {
    paths = paths.filter((file) => !removed.includes(file)).concat(added);
    for (const callback of callbacks) callback({ added, removed, indexing: false });
  }

  it("publishes a provider without constructing the finder or subscribing", () => {
    expect(main.selectListHost).toBeNull();
    expect(lumine.project.observeFilePaths).not.toHaveBeenCalled();
  });

  it("keeps the source lazy outside a path context and while disabled", async () => {
    expect(await request("const value = 1")).toEqual([]);
    lumine.config.set("fuzzy-files.pathCompletion.enabled", false);
    expect(await request("require('./asset")).toEqual([]);
    expect(lumine.project.observeFilePaths).not.toHaveBeenCalled();
    lumine.config.set("fuzzy-files.pathCompletion.enabled", true);
    expect((await request("require('./asset"))[0].text).toBe("./asset.png");
  });

  it("shares one subscription when completion is used before the finder", async () => {
    const suggestions = await request("require('./asset");
    expect(suggestions.map(({ text }) => text)).toEqual(["./asset.png"]);
    expect(main.selectListHost).toBeNull();
    await main.loadListSource();
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(1);
    expect(main.items.map(({ aPath }) => aPath)).toContain(path.join(root, "asset.png"));
  });

  it("shares one subscription when the finder is used before completion", async () => {
    await main.loadListSource();
    await request("// ./asset");
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(1);
  });

  it("applies ignored names to both surfaces without refreshing the index", async () => {
    await request("// ./asset");
    lumine.config.set("fuzzy-files.ignoredNames", ["*.png"]);
    expect(await request("// ./asset")).toEqual([]);
    expect((await main.loadListSource()).items.map(({ nPath }) => nPath)).toEqual(["current.js"]);
    lumine.config.set("fuzzy-files.ignoredNames", []);
    expect((await request("// ./asset"))[0].text).toBe("./asset.png");
    expect(lumine.project.refreshFilePaths).not.toHaveBeenCalled();
  });

  it("updates both surfaces as files are added and removed", async () => {
    await request("// ./asset");
    const added = path.join(root, "new-file.txt");
    emit([added], [path.join(root, "asset.png")]);
    expect(await request("// ./asset")).toEqual([]);
    expect((await request("// ./new-file"))[0].text).toBe("./new-file.txt");
    expect((await main.loadListSource()).items.map(({ aPath }) => aPath)).toContain(added);
  });

  it("resolves paths from the request editor independently of finder context", async () => {
    const nestedEditor = await lumine.workspace.open(path.join(root, "sub", "other.js"));
    await main.loadListSource();
    const asset = main.itemsByPath.get(path.join(root, "asset.png"));
    expect(asset.rPath).toBe(path.join("..", "asset.png"));
    expect((await request("// ./asset", editor))[0].text).toBe("./asset.png");
    expect((await request("// ../asset", nestedEditor))[0].text).toBe("../asset.png");
    nestedEditor.destroy();
  });

  it("preserves the shared source when autocomplete is deactivated and reactivated", async () => {
    await lumine.packages.startPackage("autocomplete");
    await request("// ./asset");
    await lumine.packages.deactivatePackage("autocomplete");
    expect(disposed).toBe(0);
    expect(main.itemsByPath.size).toBe(2);
    await lumine.packages.startPackage("autocomplete");
    expect(main.provideAutocomplete()).toBe(provider);
    expect((await request("// ./asset"))[0].text).toBe("./asset.png");
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(1);
    await lumine.packages.deactivatePackage("autocomplete");
  });

  it("disposes the shared source when its owning package is deactivated", async () => {
    await request("// ./asset");
    const previousProvider = provider;
    await lumine.packages.deactivatePackage("fuzzy-files");
    expect(disposed).toBe(1);
    expect(main.itemsByPath.size).toBe(0);
    const next = await lumine.packages.startPackage("fuzzy-files");
    main = next.mainModule;
    provider = main.provideAutocomplete();
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(1);
    expect((await request("// ./asset"))[0].text).toBe("./asset.png");
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(2);
    expect(
      await previousProvider.getSuggestions({
        editor,
        bufferPosition: editor.getCursorBufferPosition(),
        scopeDescriptor: { getScopesArray: () => ["source.js"] },
        prefix: "",
      }),
    ).toEqual([]);
    expect(lumine.project.observeFilePaths).toHaveBeenCalledTimes(2);
  });
});
