const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

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

    const activation = lumine.packages.activatePackage("fuzzy-files");
    const opening = lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    main = (await activation).mainModule;
    await opening;
    await main.whenIndexed();
    main.materialize();
    main.selectList.hide();
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
    await main.selectList.show();
    return main.selectList;
  }

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
    expect(main.serialize()).toEqual({ recentlyUsed: [beta.aPath] });

    await showList();
    expect(selectList.getDisplayedItems()[0].aPath).toBe(beta.aPath);
    const separator = selectList.getElement().querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");

    // Under a query the rows are ranked by score, so the recent section
    // stands down. The identifier does not change with it — the list decides
    // when the section applies, not the identity of the items in it.
    selectList.getQueryEditor().setText("alpha");
    await lumine.views.getNextUpdatePromise();
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

  it("opens an alt-clicked file through open-external when the service is available", async () => {
    const alpha = itemNamed("alpha.txt");
    const gamma = itemNamed("gamma.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    main.openExternalService = { openExternal: jasmine.createSpy("openExternal") };
    const selectList = await showList();
    await selectList.selectItem(alpha);
    const index = selectList.getDisplayedItems().indexOf(gamma);
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );
    await action;

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith(gamma.aPath);
    expect(open).not.toHaveBeenCalled();
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("keeps the ordinary click action for alt-click when open-external is unavailable", async () => {
    const gamma = itemNamed("gamma.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    const index = selectList.getDisplayedItems().indexOf(gamma);
    const row = selectList.getElement().querySelectorAll("li[role='option']")[index];

    const action = nextAction();
    row.dispatchEvent(
      new MouseEvent("click", { altKey: true, button: 0, bubbles: true, cancelable: true }),
    );
    await action;

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe(gamma.aPath);
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
    expect(selectList.isVisible()).toBe(true);
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

  it("restores recent files from serialized package state", async () => {
    const betaPath = itemNamed("beta.txt").aPath;
    await main.selectList.recordRecentItem(itemNamed("beta.txt"));
    const state = main.serialize();
    main.deactivate();

    main.activate(state);

    expect(main.recentlyUsed).toEqual([betaPath]);
  });
});
