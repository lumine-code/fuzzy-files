const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

// What this package owns is the derivation on top of the project's file index:
// which paths become items, what those items look like, and what the list shows.
// Whether the index itself tracks the filesystem is core's spec, and driving a
// real recursive watcher from here would be the flakiest thing in the suite — so
// the index is stubbed and fed by hand.
describe("fuzzy-files as a file-index consumer", () => {
  let dir, main, workspaceElement, emit, indexed;

  const stubIndex = () => {
    indexed = [];
    let callback = null;
    let indexing = false;

    spyOn(lumine.project, "observeFilePaths").and.callFake((fn) => {
      callback = fn;
      fn({ added: indexed.slice(), removed: [], indexing });
      return { dispose: () => (callback = null) };
    });
    spyOn(lumine.project, "getFilePaths").and.callFake(() => indexed.slice());
    spyOn(lumine.project, "isIndexing").and.callFake(() => indexing);
    spyOn(lumine.project, "refreshFilePaths").and.returnValue(Promise.resolve());

    emit = ({ added = [], removed = [], indexing: next = false }) => {
      indexing = next;
      indexed = indexed.filter((p) => !removed.includes(p)).concat(added);
      callback?.({ added, removed, indexing });
    };
    return (paths) => (indexed = paths);
  };

  // The package is `activationCommands`-gated, so activation only completes once
  // one of its commands is dispatched. Which command matters: `toggle` opens the
  // finder, while `clear-recent` activates it without ever showing the list —
  // which is how the laziness case gets an activated but unopened package.
  const activate = async (command = "fuzzy-files:toggle") => {
    const activation = lumine.packages.activatePackage("fuzzy-files");
    lumine.commands.dispatch(workspaceElement, command);
    main = (await activation).mainModule;
    return main;
  };

  beforeEach(() => {
    dir = fs.realpathSync.native(temp.mkdirSync("fuzzy-files-index-"));
    lumine.project.setPaths([dir]);
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);

    const seed = stubIndex();
    seed([
      path.join(dir, "beta.js"),
      path.join(dir, "alpha.js"),
      path.join(dir, "sub", "gamma.js"),
    ]);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
  });

  it("does not touch the index until the finder is first opened", async () => {
    await activate("fuzzy-files:clear-recent");
    // Activation alone must not build the project's index, or every window pays
    // for a crawl whether or not anyone opens the finder.
    expect(lumine.project.observeFilePaths).not.toHaveBeenCalled();

    lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    expect(lumine.project.observeFilePaths).toHaveBeenCalled();
  });

  it("derives an item for every indexed path", async () => {
    await activate();
    const item = main.itemsByPath.get(path.join(dir, "sub", "gamma.js"));
    expect(item.pPath).toBe(dir);
    expect(item.fPath).toBe(path.join("sub", "gamma.js"));
    expect(item.aPath).toBe(path.join(dir, "sub", "gamma.js"));
    expect(item.nPath).toBe("gamma.js");
  });

  it("lists paths in order with an empty query", async () => {
    await activate();
    main.materialize();
    // The index is unsorted, and this is the only place the order shows: the
    // first page of an unqueried list is otherwise arbitrary and reshuffles on
    // every crawl.
    expect(main.items.map((item) => item.fPath)).toEqual([
      "alpha.js",
      "beta.js",
      path.join("sub", "gamma.js"),
    ]);
  });

  it("applies its own ignore patterns and not core's", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["*.js"]);
    expect(main.itemsByPath.size).toBe(0);

    lumine.config.set("fuzzy-files.ignoredNames", []);
    expect(main.itemsByPath.size).toBe(3);

    // `core.ignoredNames` is the index's policy: whatever it excludes never
    // arrives, and re-applying it here with different matcher semantics could
    // hide a path the setting does not name.
    lumine.config.set("core.ignoredNames", ["*.js"]);
    expect(main.itemsByPath.size).toBe(3);
  });

  it("adds and drops items as the index reports them", async () => {
    await activate();
    emit({ added: [path.join(dir, "delta.js")] });
    expect(main.itemsByPath.has(path.join(dir, "delta.js"))).toBe(true);

    emit({ removed: [path.join(dir, "alpha.js")] });
    expect(main.itemsByPath.has(path.join(dir, "alpha.js"))).toBe(false);
  });

  it("filters a path the index adds but this package excludes", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["*.log"]);
    emit({ added: [path.join(dir, "noisy.log")] });
    expect(main.itemsByPath.has(path.join(dir, "noisy.log"))).toBe(false);
  });

  it("counts what it lists, not what the index holds", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["alpha.js"]);
    expect(main.infoLine()).toBe("2 files in 1 project");
  });

  it("relativizes against the active editor", async () => {
    await activate();
    const editorPath = path.join(dir, "sub", "gamma.js");
    fs.mkdirSync(path.dirname(editorPath), { recursive: true });
    fs.writeFileSync(editorPath, "");
    await lumine.workspace.open(editorPath);

    main.materialize();
    main.relativize();
    const alpha = main.itemsByPath.get(path.join(dir, "alpha.js"));
    expect(alpha.rPath).toBe(path.join("..", "alpha.js"));
    expect(alpha.distance).toBe(2);
  });

  it("refreshes the shared index rather than a cache of its own", async () => {
    await activate();
    lumine.commands.dispatch(main.selectList.element, "fuzzy-files:refresh-index");
    expect(lumine.project.refreshFilePaths).toHaveBeenCalled();
  });
});
