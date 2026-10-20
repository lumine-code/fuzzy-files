const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();

describe("fuzzy-files recent files", () => {
  let dir, main, workspaceElement;

  beforeEach(async () => {
    dir = fs.realpathSync.native(temp.mkdirSync("fuzzy-files-recent-"));
    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      fs.writeFileSync(path.join(dir, name), `${name}\n`);
    }
    lumine.project.setPaths([dir]);
    lumine.config.set("fuzzy-files.recentCount", 10);
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);

    const activation = lumine.packages.startPackage("fuzzy-files");
    const opening = lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    await activation;
    await opening;
    main = lumine.packages.getLoadedPackage("fuzzy-files").mainModule;
    await main.whenIndexed();
    main.materialize();
    main.selectListHost.hide();
    await main.selectList.clearRecentItems();
  });

  afterEach(async () => {
    // The main module is a singleton across the suite, so a service stubbed
    // into it has to be taken back out.
    main.openExternalService = null;
    await lumine.packages.deactivatePackage("fuzzy-files");
  });

  function itemNamed(name) {
    return main.items.find((item) => item.fPath === name);
  }

  async function showList() {
    await main.selectListHost.show();
    return main.selectList;
  }

  it("keeps the query and selected row without loading again when recent history changes", async () => {
    const list = await showList();
    list.setQuery("txt");
    await lumine.views.getNextUpdatePromise();
    const item = itemNamed("beta.txt");
    await list.selectItem(item);
    const reload = spyOn(list, "reload").and.callThrough();
    const load = spyOn(main, "loadListSource").and.callThrough();
    const loading = spyOn(list, "setLoadingState").and.callThrough();

    await main.workspaceState.update("recentlyUsed", [itemNamed("alpha.txt").aPath]);
    await list.recordRecentItem(item);
    await lumine.views.getNextUpdatePromise();

    expect(list.getQuery()).toBe("txt");
    expect(list.getItemId(list.getSelectedItem())).toBe(list.getItemId(item));
    expect(reload).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(loading).not.toHaveBeenCalled();
  });

  function nextAction() {
    return new Promise((resolve) => {
      const disposable = main.selectList.onDidFinishAction((event) => {
        disposable.dispose();
        resolve(event);
      });
    });
  }

  it("remembers opened files and separates them from the ordinary results", async () => {
    const beta = itemNamed("beta.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem(beta);

    await selectList.runAction("fuzzy-files:open");

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe(beta.aPath);
    expect(main.recentlyUsed).toEqual([beta.aPath]);
    expect(main.workspaceState.get("recentlyUsed", [])).toEqual([beta.aPath]);

    await showList();
    expect(selectList.getDisplayedItems()[0].aPath).toBe(beta.aPath);
    const separator = selectList.getElement().querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");

    // Under a query the rows are ranked by score, so the recent section
    // stands down. The identifier does not change with it — the list decides
    // when the section applies, not the identity of the items in it.
    await selectList.setQuery("alpha");
    expect(selectList.getItemId(beta)).toBe(beta.aPath);
    expect(selectList.getElement().querySelector(".select-list-separator")).toBeNull();

    selectList.getQueryEditor().setText("");
    await lumine.views.getNextUpdatePromise();
    await lumine.commands.dispatch(workspaceElement, "fuzzy-files:clear-recent");
    await lumine.views.getNextUpdatePromise();
    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.getElement().querySelector(".select-list-separator")).toBeNull();
  });

  it("records the file for every action over it, not only an open", async () => {
    const gamma = itemNamed("gamma.txt");
    main.openExternalService = {
      openExternal: jasmine.createSpy("openExternal"),
      showInFolder: jasmine.createSpy("showInFolder"),
    };
    const selectList = await showList();
    await selectList.selectItem(gamma);

    await selectList.runAction("fuzzy-files:open-external");

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith(gamma.aPath);
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("opens a Ctrl-Alt-clicked file externally without also opening it in the editor", async () => {
    const alpha = itemNamed("alpha.txt");
    const gamma = itemNamed("gamma.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.openExternalService = { openExternal: jasmine.createSpy("openExternal") };
    const selectList = await showList();
    await selectList.selectItem(alpha);
    const index = selectList.getDisplayedItems().findIndex((item) => item.aPath === gamma.aPath);
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", {
        altKey: true,
        ctrlKey: true,
        button: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    await action;

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith(gamma.aPath);
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("opens the chooser for the Alt-clicked file even without an external service", async () => {
    const gamma = itemNamed("gamma.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const choose = jasmine.createSpy("choose opener");
    const command = lumine.commands.add("lumine-workspace", "launcher:open", choose);
    const selectList = await showList();
    const index = selectList.getDisplayedItems().findIndex((item) => item.aPath === gamma.aPath);
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );
    const result = await action;
    command.dispose();

    expect(result.command).toBe("fuzzy-files:choose-opener");
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.calls.mostRecent().args[0].detail.path).toBe(gamma.aPath);
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual([]);
  });

  it("records a file it trashed, since the trash is where it is put back from", async () => {
    const gamma = itemNamed("gamma.txt");
    spyOn(lumine.shell, "trashItem").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem(gamma);

    await selectList.runAction("fuzzy-files:trash");

    expect(lumine.shell.trashItem).toHaveBeenCalledWith(gamma.aPath);
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("drops one file from the section without closing the list", async () => {
    const beta = itemNamed("beta.txt");
    await main.selectList.recordRecentItem(itemNamed("gamma.txt"));
    await main.selectList.recordRecentItem(beta);
    const selectList = await showList();
    await selectList.selectItem(beta);

    await selectList.runAction("select-list:remove-recent");

    expect(main.recentlyUsed).toEqual([itemNamed("gamma.txt").aPath]);
    expect(main.selectListHost.isVisible()).toBe(true);
    expect(selectList.getSelectedItem().aPath).toBe(beta.aPath);
  });

  it("offers the action only while a recent file is selected", async () => {
    const beta = itemNamed("beta.txt");
    await main.selectList.recordRecentItem(beta);
    const selectList = await showList();

    await selectList.selectItem(beta);
    let actions = selectList.getAvailableActions().map((action) => action.command);
    expect(actions).toContain("select-list:remove-recent");

    await selectList.selectItem(itemNamed("alpha.txt"));
    actions = selectList.getAvailableActions().map((action) => action.command);
    expect(actions).not.toContain("select-list:remove-recent");
    expect(actions).toContain("fuzzy-files:open-external");
  });

  it("caps recent files at the configured count", async () => {
    lumine.config.set("fuzzy-files.recentCount", 2);
    await main.selectList.recordRecentItem(itemNamed("alpha.txt"));
    await main.selectList.recordRecentItem(itemNamed("beta.txt"));
    await main.selectList.recordRecentItem(itemNamed("gamma.txt"));

    expect(main.recentlyUsed).toEqual([itemNamed("gamma.txt").aPath, itemNamed("beta.txt").aPath]);
  });

  it("loads persisted project recents after package reactivation", async () => {
    const betaPath = itemNamed("beta.txt").aPath;
    await main.selectList.recordRecentItem(itemNamed("beta.txt"));
    await lumine.packages.deactivatePackage("fuzzy-files");
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;

    expect(main.recentlyUsed).toEqual([betaPath]);
  });
  it("projects stored history changes into the existing list and persists the next use", async () => {
    const list = main.selectList;
    const restored = itemNamed("beta.txt").aPath;
    await main.workspaceState.update("recentlyUsed", [restored]);
    expect(main.selectList).toBe(list);
    expect(list.getRecentItemIds()).toEqual([restored]);
    await list.recordRecentItem(itemNamed("alpha.txt"));
    expect(main.workspaceState.get("recentlyUsed", [])).toEqual([
      list.getItemId(itemNamed("alpha.txt")),
      restored,
    ]);
  });
  it("keeps concurrent records from two window lists and honours removal and clear", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    try {
      const local = main.selectList;
      const remote = main.ensureFinder(extra).getModel();
      const first = itemNamed("alpha.txt");
      const second = itemNamed("beta.txt");
      const ids = [local.getItemId(second), local.getItemId(first)];
      await Promise.all([local.recordRecentItem(first), remote.recordRecentItem(second)]);
      expect(main.workspaceState.get("recentlyUsed")).toEqual(ids);
      expect(local.getRecentItemIds()).toEqual(ids);
      expect(remote.getRecentItemIds()).toEqual(ids);
      await local.removeRecentItem(ids[1]);
      expect(main.workspaceState.get("recentlyUsed")).toEqual([ids[0]]);
      await remote.clearRecentItems();
      expect(main.workspaceState.get("recentlyUsed")).toEqual([]);
    } finally {
      await lumine.workspace.closeEditorWindow(extra);
    }
  });
});
