const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("window-local file finders", () => {
  let directory;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finder-window-")));
    fs.writeFileSync(path.join(directory, "first.txt"), "first");
    fs.writeFileSync(path.join(directory, "second.txt"), "second");
    lumine.project.setPaths([directory]);
    await lumine.packages.activatePackage("fuzzy-files");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
    await lumine.workspace.discardEditorWindows();
    for (const item of [...lumine.workspace.getPaneItems()])
      await lumine.workspace.paneForItem(item).destroyItem(item, true);
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  it("keeps independent queries and opens splits in the invoking window", async () => {
    const workspace = lumine.workspace;
    const mainWindow = workspace.getMainWindow();
    const first = await workspace.open(path.join(directory, "first.txt"));
    const extra = await workspace.openEditorWindow({ show: false });
    const second = await workspace.open(path.join(directory, "second.txt"), {
      pane: extra.getEditorContainer().getActivePane(),
    });
    await lumine.commands.dispatch(first.getElement(), "fuzzy-files:toggle");
    await lumine.commands.dispatch(second.getElement(), "fuzzy-files:toggle");
    const main = lumine.packages.getActivePackage("fuzzy-files").mainModule;
    const local = main.finders.get(mainWindow),
      remote = main.finders.get(extra);
    expect(local.host.isVisible()).toBe(true);
    expect(remote.host.isVisible()).toBe(true);
    expect(remote.model.getElement().ownerDocument).toBe(extra.getDocument());
    await local.model.setQuery("second");
    await remote.model.setQuery("first");
    expect(local.model.getQuery()).toBe("second");
    expect(remote.model.getQuery()).toBe("first");
    const remoteWorker = remote.model.workerPreparation;
    const syncList = spyOn(main, "syncList").and.callThrough();
    await local.model.selectItem(
      local.model.getItems().find((item) => item.aPath === second.getPath()),
    );
    await local.model.runAction("fuzzy-files:split-right");
    expect(mainWindow.getEditorContainer().getPanes().length).toBe(2);
    expect(extra.getEditorContainer().getPanes().length).toBe(1);
    expect(syncList).not.toHaveBeenCalled();
    expect(remote.model.isFiltering()).toBe(false);
    expect(remote.model.workerPreparation).toBe(remoteWorker);
    await remote.model.selectItem(
      remote.model.getItems().find((item) => item.aPath === first.getPath()),
    );
    await remote.model.runAction("fuzzy-files:open");
    expect(extra.getEditorContainer().getActiveEmbeddedTextEditor().getPath()).toBe(
      first.getPath(),
    );
    expect(local.model.getRecentItemIds()).toEqual(remote.model.getRecentItemIds());

    await local.host.show({ query: "second" });
    await remote.host.show({ query: "first" });
    const unchangedRemote = remote.model.workerPreparation;
    syncList.calls.reset();
    await workspace.open(path.join(directory, "child", "scratch.txt"), {
      pane: mainWindow.getEditorContainer().getActivePane(),
    });
    await local.model.queryWork?.promise;
    expect(syncList).toHaveBeenCalled();
    expect(syncList.calls.allArgs().every(([, window]) => window === mainWindow)).toBe(true);
    expect(local.model.getFilteredItems()[0].rPath).toBe(path.join("..", "second.txt"));
    expect(remote.model.workerPreparation).toBe(unchangedRemote);
    expect(remote.model.getFilteredItems()[0].rPath).toBe("first.txt");
  });
});
