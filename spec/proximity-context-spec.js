const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("File proximity command context", () => {
  let root, main, items, emit;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-proximity-")));
    lumine.project.setPaths([root]);
    items = [];
    const paths = [path.join(root, "near", "alpha.txt"), path.join(root, "far", "alpha.txt")];
    spyOn(lumine.project, "observeFilePaths").and.callFake((callback) => {
      emit = callback;
      callback({ added: paths, removed: [], indexing: false });
      return { dispose() {} };
    });
    spyOn(lumine.project, "isIndexing").and.returnValue(false);
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
    for (const item of items) await lumine.workspace.paneForItem(item)?.destroyItem(item, true);
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmdirSync(root);
  });
  function addItem(pane, file) {
    const item = document.createElement("div");
    item.tabIndex = 0;
    item.getTitle = () => "Proximity fixture";
    if (file) item.getPath = () => file;
    items.push(item);
    pane.addItem(item);
    pane.activateItem(item);
    return item;
  }
  function distances(model) {
    return Object.fromEntries(model.getItems().map((item) => [item.fPath, item.distance]));
  }

  it("uses the invoking non-text item even when a different pane is active", async () => {
    const left = lumine.workspace.getActivePane();
    const origin = addItem(left, path.join(root, "near", "document.pdf"));
    const right = left.splitRight({ copyActiveItem: false });
    addItem(right, path.join(root, "far", "image.png"));
    right.activate();
    await lumine.commands.dispatch(origin, "fuzzy-files:toggle");
    const record = main.finders.get(lumine.workspace.getMainWindow());
    expect(record.opening.item).toBe(origin);
    expect(record.opening.pane).toBe(left);
    expect(record.opening.editor).toBeFalsy();
    expect(distances(record.model)).toEqual({
      [path.join("near", "alpha.txt")]: 1,
      [path.join("far", "alpha.txt")]: 3,
    });
  });

  it("applies no proximity bonus when the invoking item has no path", async () => {
    const pane = lumine.workspace.getActivePane();
    addItem(pane, path.join(root, "near", "previous.pdf"));
    const origin = addItem(pane);
    await lumine.commands.dispatch(origin, "fuzzy-files:toggle");
    expect(main.selectList.getItems().every((item) => item.distance === 1)).toBe(true);
    expect(main.finders.get(lumine.workspace.getMainWindow()).opening.item).toBe(origin);
  });

  it("refreshes proximity after the invoking item moves and clears caches on index changes", async () => {
    const origin = addItem(
      lumine.workspace.getActivePane(),
      path.join(root, "near", "document.pdf"),
    );
    await lumine.commands.dispatch(origin, "fuzzy-files:toggle");
    const record = main.finders.get(lumine.workspace.getMainWindow());
    const original = record.snapshot;
    expect(original.items.length).toBe(2);
    origin.getPath = () => path.join(root, "far", "document.pdf");
    main.activeItemPathChanged();
    await main.syncList({}, record.window);
    expect(record.snapshot).not.toBe(original);
    expect(distances(record.model)[path.join("far", "alpha.txt")]).toBe(1);
    const current = record.snapshot;
    emit({ added: [], removed: [path.join(root, "near", "alpha.txt")], indexing: false });
    await main.whenPrepared();
    expect(record.snapshot.items.length).toBe(1);
    expect(record.snapshot.items[0]).toBe(
      current.items.find((item) => item.fPath === path.join("far", "alpha.txt")),
    );
  });
});
