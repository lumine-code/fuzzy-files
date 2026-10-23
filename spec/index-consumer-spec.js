const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

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

  // Package activation is eager; the finder itself is loaded only by an
  // operation that needs it. Which command matters: `toggle` opens the finder,
  // while `clear-recent` initializes the index without showing the list.
  const activate = async (command = "fuzzy-files:toggle") => {
    await lumine.packages.startPackage("fuzzy-files");
    const dispatch = lumine.commands.dispatch(workspaceElement, command);
    await dispatch;
    main = lumine.packages.getLoadedPackage("fuzzy-files").mainModule;
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

    await lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    expect(lumine.project.observeFilePaths).toHaveBeenCalled();
  });

  it("opens the finder when the core has no URI-change event", async () => {
    const subscribe = lumine.workspace.onDidChangePaneItemURI;
    lumine.workspace.onDidChangePaneItemURI = undefined;
    try {
      await activate();
      expect(main.itemsByPath.size).toBe(3);
    } finally {
      lumine.workspace.onDidChangePaneItemURI = subscribe;
    }
  });

  it("does not touch the index when its ignored names change before first open", async () => {
    await activate("fuzzy-files:clear-recent");
    lumine.config.set("fuzzy-files.ignoredNames", ["*.log"]);
    await main?.whenPrepared();
    expect(lumine.project.observeFilePaths).not.toHaveBeenCalled();
    expect(lumine.project.getFilePaths).not.toHaveBeenCalled();
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
    await main.materialize();
    // The index is unsorted, and this is the only place the order shows: the
    // first page of an unqueried list is otherwise arbitrary and reshuffles on
    // every crawl.
    expect(main.items.map((item) => item.fPath)).toEqual([
      "alpha.js",
      "beta.js",
      path.join("sub", "gamma.js"),
    ]);
  });

  it("applies its own ignored names and not core's", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["*.js"]);
    await main?.whenPrepared();
    expect(main.itemsByPath.size).toBe(0);

    lumine.config.set("fuzzy-files.ignoredNames", []);
    await main?.whenPrepared();
    expect(main.itemsByPath.size).toBe(3);

    // `core.ignoredNames` is the index's policy: whatever it excludes never
    // arrives, and re-applying it here with different matcher semantics could
    // hide a path the setting does not name.
    lumine.config.set("core.ignoredNames", ["*.js"]);
    expect(main.itemsByPath.size).toBe(3);
  });

  it("uses ignored-name directory semantics for descendants", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["sub"]);
    await main?.whenPrepared();
    expect(main.itemsByPath.has(path.join(dir, "sub", "gamma.js"))).toBe(false);
    expect(main.itemsByPath.size).toBe(2);
  });

  it("adds and drops items as the index reports them", async () => {
    await activate();
    emit({ added: [path.join(dir, "delta.js")] });
    await main.whenPrepared();
    expect(main.itemsByPath.has(path.join(dir, "delta.js"))).toBe(true);

    emit({ removed: [path.join(dir, "alpha.js")] });
    await main.whenPrepared();
    expect(main.itemsByPath.has(path.join(dir, "alpha.js"))).toBe(false);
  });

  it("filters a path the index adds but this package excludes", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["*.log"]);
    await main?.whenPrepared();
    emit({ added: [path.join(dir, "noisy.log")] });
    await main.whenPrepared();
    expect(main.itemsByPath.has(path.join(dir, "noisy.log"))).toBe(false);
  });

  it("counts what it lists, not what the index holds", async () => {
    await activate();
    lumine.config.set("fuzzy-files.ignoredNames", ["alpha.js"]);
    await main?.whenPrepared();
    expect(main.infoLine()).toBe("2 files in 1 project");
  });

  it("computes proximity to the active pane item without storing relative strings", async () => {
    await activate();
    const editorPath = path.join(dir, "sub", "gamma.js");
    fs.mkdirSync(path.dirname(editorPath), { recursive: true });
    fs.writeFileSync(editorPath, "");
    await lumine.workspace.open(editorPath);

    await main.materialize();
    const alpha = main.items.find((item) => item.aPath === path.join(dir, "alpha.js"));
    expect(alpha.rPath).toBeUndefined();
    expect(alpha.distance).toBe(2);
  });

  it("publishes the initial settled snapshot once", async () => {
    await activate("fuzzy-files:clear-recent");
    const host = main.ensureFinder();
    const build = spyOn(host.getModel().model, "_buildRecords").and.callThrough();
    await host.show();
    expect(build.calls.count()).toBe(1);
    expect(host.getModel().getItemCount()).toBe(3);
    expect(host.getModel().isLoading()).toBe(false);
  });

  it("reopens without reconstructing records or restarting the filtering worker", async () => {
    await activate();
    const host = main.ensureFinder(),
      list = host.getModel();
    await list.workerPreparation?.promise;
    const records = list.model._records,
      preparation = list.workerPreparation;
    const build = spyOn(list.model, "_recordBuilder").and.callThrough();
    host.hide();
    await host.show();
    expect(list.model._records).toBe(records);
    expect(list.workerPreparation).toBe(preparation);
    expect(build).not.toHaveBeenCalled();
  });

  it("includes index changes that arrive while the opening snapshot is being prepared", async () => {
    jasmine.useRealClock();
    await activate("fuzzy-files:clear-recent");
    const host = main.ensureFinder(),
      list = host.getModel();
    const prepare = list.prepareItems.bind(list);
    let release, began;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      began = resolve;
    });
    let first = true;
    spyOn(list, "prepareItems").and.callFake(async (...args) => {
      if (first) {
        first = false;
        began();
        await gate;
      }
      return prepare(...args);
    });
    const opening = host.show();
    await started;
    emit({ added: [path.join(dir, "late.js")] });
    release();
    await opening;
    expect(list.getItems().map((item) => item.nPath)).toContain("late.js");
    expect(list.getItemCount()).toBe(4);
  });

  it("preserves depth weighting and modifier order after path metadata is prepared", async () => {
    await activate();
    const item = main.itemsByPath.get(path.join(dir, "sub", "gamma.js"));
    item.distance = 3;
    const modifier = jasmine.createSpy("modifier").and.callFake((score) => score * 2);
    main.scoreModifiers.push(modifier);
    try {
      const expected = 0.75 / (3 * Math.sqrt(2));
      expect(main.modifyScore(0.75, item)).toBe(expected * 2);
      expect(modifier).toHaveBeenCalledWith(expected, item);
      item.fPath = "one/two/three/file.js";
      expect(main.modifyScore(0.75, item)).toBe((0.75 / (3 * Math.sqrt(4))) * 2);
    } finally {
      main.scoreModifiers.splice(main.scoreModifiers.indexOf(modifier), 1);
    }
  });

  it("invalidates registered modifiers only when their state or registration changes", async () => {
    jasmine.useRealClock();
    await activate();
    const list = main.ensureFinder().getModel();
    await list.setQuery("a");
    const preparation = list.workerPreparation;
    const index = main.fileIndex;
    const service = main.provideFuzzyFilesScoreModifier();
    let wanted = "gamma.js";
    const modifier = jasmine
      .createSpy("modifier")
      .and.callFake((score, item) => (item.nPath === wanted ? score : 0));
    const registration = service.add(modifier);
    try {
      await list.queryWork?.promise;
      expect(list.getFilteredItems().map((item) => item.nPath)).toEqual(["gamma.js"]);
      const calls = modifier.calls.count();
      await list.setQuery("a");
      expect(modifier.calls.count()).toBe(calls);
      wanted = "alpha.js";
      await service.invalidate(modifier);
      expect(list.getFilteredItems().map((item) => item.nPath)).toEqual(["alpha.js"]);
      expect(list.workerPreparation).toBe(preparation);
      expect(main.fileIndex).toBe(index);
      const updatedCalls = modifier.calls.count();
      await service.invalidate(() => 0);
      expect(modifier.calls.count()).toBe(updatedCalls);
    } finally {
      registration.dispose();
      await list.queryWork?.promise;
    }
    expect(list.getMatchCount()).toBe(3);
    expect(main.scoreModifiers).not.toContain(modifier);
  });

  it("does not publish an obsolete snapshot when exclusions replace the worker during preparation", async () => {
    jasmine.useRealClock();
    await activate("fuzzy-files:clear-recent");
    const host = main.ensureFinder(),
      list = host.getModel();
    const prepare = list.prepareItems.bind(list);
    let release, began;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      began = resolve;
    });
    let first = true;
    spyOn(list, "prepareItems").and.callFake(async (...args) => {
      if (first) {
        first = false;
        began();
        await gate;
      }
      return prepare(...args);
    });
    const opening = host.show();
    await started;
    lumine.config.set("fuzzy-files.ignoredNames", ["alpha.js"]);
    await main.whenPrepared();
    release();
    await opening;
    expect(list.getItems().map((item) => item.nPath)).toEqual(["beta.js", "gamma.js"]);
  });

  it("cancels a pending refresh when the package deactivates", async () => {
    jasmine.useRealClock();
    await activate();
    const list = main.ensureFinder().getModel();
    const prepare = list.model.prepareItems.bind(list.model);
    let release, began, signal;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      began = resolve;
    });
    spyOn(list.model, "prepareItems").and.callFake(async (items, options) => {
      signal = options.signal;
      began();
      await gate;
      return prepare(items, options);
    });
    const refresh = main.syncList();
    await started;
    await lumine.packages.deactivatePackage("fuzzy-files");
    release();
    await refresh;
    expect(signal.aborted).toBe(true);
    expect(main.fileIndex).toBeNull();
    expect(main.finders.size).toBe(0);
  });

  it("refreshes the shared index rather than a cache of its own", async () => {
    await activate();
    await main.selectList.runAction("fuzzy-files:refresh-index");
    expect(lumine.project.refreshFilePaths).toHaveBeenCalled();
  });

  it("recreates a failed metadata helper when the user refreshes the finder", async () => {
    jasmine.useRealClock();
    await activate();
    const previous = main.fileIndex;
    await previous.close(new Error("metadata helper failed"));
    await main.refresh();
    await main.selectList.reload();
    expect(main.fileIndex).not.toBe(previous);
    expect(main.selectList.getItemCount()).toBe(3);
    expect(main.selectList.getStatus()?.type).not.toBe("error");
  });
});
