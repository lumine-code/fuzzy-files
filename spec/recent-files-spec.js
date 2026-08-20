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
    lumine.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    main = (await activation).mainModule;
    await main.whenIndexed();
    main.materialize();
    main.selectList.hide();
    main.clearRecent();
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
    main.selectList.show();
    await lumine.views.getNextUpdatePromise();
    return main.selectList;
  }

  it("remembers opened files and separates them from the ordinary results", async () => {
    const beta = itemNamed("beta.txt");
    const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem(beta);

    main.performAction("open");

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe(beta.aPath);
    expect(main.recentlyUsed).toEqual([beta.aPath]);
    expect(main.serialize()).toEqual({ recentlyUsed: [beta.aPath] });

    await showList();
    expect(selectList.items[0].aPath).toBe(beta.aPath);
    const separator = selectList.element.querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");

    // Under a query the rows are ranked by score, so the recent section
    // stands down. The identifier does not change with it — the list decides
    // when the section applies, not the identity of the items in it.
    selectList.refs.queryEditor.setText("alpha");
    await lumine.views.getNextUpdatePromise();
    expect(selectList.getIdForItem(beta)).toBe(beta.aPath);
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();

    selectList.refs.queryEditor.setText("");
    await lumine.views.getNextUpdatePromise();
    lumine.commands.dispatch(workspaceElement, "fuzzy-files:clear-recent");
    await lumine.views.getNextUpdatePromise();
    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("records the file for every action over it, not only an open", async () => {
    const gamma = itemNamed("gamma.txt");
    main.openExternalService = {
      openExternal: jasmine.createSpy("openExternal"),
      showInFolder: jasmine.createSpy("showInFolder"),
    };
    const selectList = await showList();
    await selectList.selectItem(gamma);

    main.performAction("open-external");

    expect(main.openExternalService.openExternal).toHaveBeenCalledWith(gamma.aPath);
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("records a file it trashed, since the trash is where it is put back from", async () => {
    const gamma = itemNamed("gamma.txt");
    spyOn(lumine.shell, "trashItem").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem(gamma);

    await main.performAction("trash");

    expect(lumine.shell.trashItem).toHaveBeenCalledWith(gamma.aPath);
    expect(main.recentlyUsed).toEqual([gamma.aPath]);
  });

  it("drops one file from the section without closing the list", async () => {
    const beta = itemNamed("beta.txt");
    main.recordRecent(itemNamed("gamma.txt"));
    main.recordRecent(beta);
    const selectList = await showList();
    await selectList.selectItem(beta);

    lumine.commands.dispatch(selectList.element, "fuzzy-files:remove-from-recent");
    await lumine.views.getNextUpdatePromise();

    expect(main.recentlyUsed).toEqual([itemNamed("gamma.txt").aPath]);
    expect(selectList.isVisible()).toBe(true);
    expect(selectList.getSelectedItem().aPath).toBe(beta.aPath);
  });

  it("offers the action only while a recent file is selected", async () => {
    const beta = itemNamed("beta.txt");
    main.recordRecent(beta);
    const selectList = await showList();

    await selectList.selectItem(beta);
    let actions = selectList.itemActions().map((action) => action.command);
    expect(actions).toContain("fuzzy-files:remove-from-recent");

    await selectList.selectItem(itemNamed("alpha.txt"));
    actions = selectList.itemActions().map((action) => action.command);
    expect(actions).not.toContain("fuzzy-files:remove-from-recent");
    expect(actions).toContain("fuzzy-files:open-external");
  });

  it("caps recent files at the configured count", () => {
    lumine.config.set("fuzzy-files.recentCount", 2);
    main.recordRecent(itemNamed("alpha.txt"));
    main.recordRecent(itemNamed("beta.txt"));
    main.recordRecent(itemNamed("gamma.txt"));

    expect(main.recentlyUsed).toEqual([itemNamed("gamma.txt").aPath, itemNamed("beta.txt").aPath]);
  });

  it("restores recent files from serialized package state", () => {
    const betaPath = itemNamed("beta.txt").aPath;
    main.recordRecent(itemNamed("beta.txt"));
    const state = main.serialize();
    main.deactivate();

    main.activate(state);

    expect(main.recentlyUsed).toEqual([betaPath]);
  });
});
