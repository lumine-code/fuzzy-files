describe("fuzzy-files item actions", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // The package activates on its commands, so dispatch one to trigger it;
    // activation also loads the package keymap the actions list reads.
    const activation = lumine.packages.activatePackage("fuzzy-files");
    lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "fuzzy-files:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
  });

  it("describes its explicit actions with command metadata and keybindings", async () => {
    await main.selectList.update({
      items: [
        {
          aPath: __filename,
          pPath: __dirname,
          fPath: "item-actions-spec.js",
          distance: 1,
        },
      ],
    });
    const actions = main.selectList.getAvailableActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const openExternal = byCommand.get("fuzzy-files:open-external");
    expect(openExternal.name).toBe("Open External");
    expect(openExternal.description).toBe("Open the file in the default external program.");
    expect(openExternal.keystrokes).toEqual(["alt-f12"]);

    const insertRelative = byCommand.get("fuzzy-files:insert-relative-path");
    // `alt-v` is a chord prefix and nothing else. Binding it as a complete
    // keystroke too made every press sit out the 1000 ms partial-match timeout
    // before the default variant fired.
    expect([...insertRelative.keystrokes].sort()).toEqual(["alt-v alt-r"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }
    expect(byCommand.get("fuzzy-files:copy-absolute-path").description).toBe(
      "Copy the full path from the filesystem root to the clipboard.",
    );
    expect(byCommand.get("fuzzy-files:open").keystrokes).toEqual(["enter"]);
    expect(byCommand.get("fuzzy-files:trash").tone).toBe("danger");

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("fuzzy-files:toggle")).toBe(false);
  });

  it("offers the core recent actions only while recent files exist", async () => {
    main.selectList.selectNone();
    const hasClear = () =>
      main.selectList
        .getAvailableActions()
        .some(({ command }) => command === "select-list:clear-recents");

    expect(hasClear()).toBe(false);
    await main.selectList.setRecentItemIds([__filename]);
    expect(hasClear()).toBe(true);
    expect(
      main.selectList
        .getAvailableActions()
        .find(({ command }) => command === "select-list:clear-recents").context,
    ).toBe("dialog");
  });

  it("separates the actions about the list from the actions about the file", async () => {
    await main.selectList.update({
      items: [
        {
          aPath: __filename,
          pPath: __dirname,
          fPath: "item-actions-spec.js",
          distance: 1,
        },
      ],
    });
    const rows = main.selectList.getAvailableActions();
    const contextOf = (command) => rows.find((row) => row.command === command)?.context;

    expect(contextOf("fuzzy-files:open-external")).toBe("item");
    expect(contextOf("fuzzy-files:refresh-index")).toBe("dialog");
    expect(contextOf("fuzzy-files:use-forward-slashes")).toBe("dialog");
    expect(rows.find((row) => row.command === "fuzzy-files:open-external").group).toBe("Open");
    expect(rows.find((row) => row.command === "fuzzy-files:refresh-index").group).toBe("Finder");
  });

  it("shows the shared action palette as a flow step and runs against the master list", async () => {
    await main.selectList.show();

    expect(await main.selectList.showActions()).toBe(true);

    expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Actions"]);
    lumine.workspace.popModal();

    const spy = spyOn(main, "refresh");
    await main.selectList.runAction("fuzzy-files:refresh-index");

    expect(spy).toHaveBeenCalled();
    expect(main.selectList.isVisible()).toBeTruthy();
  });

  it("trashes the selected item through the shell service", async () => {
    await main.selectList.update({
      items: [
        {
          aPath: __filename,
          pPath: __dirname,
          fPath: "item-actions-spec.js",
          distance: 1,
        },
      ],
    });
    spyOn(lumine.shell, "trashItem").and.returnValue(Promise.resolve());
    spyOn(lumine.notifications, "addSuccess");

    await main.selectList.runAction("fuzzy-files:trash");

    expect(lumine.shell.trashItem).toHaveBeenCalledWith(__filename);
    expect(lumine.notifications.addSuccess).toHaveBeenCalled();
  });

  it("opens with the parsed line captured when the action starts", async () => {
    const item = {
      aPath: __filename,
      pPath: __dirname,
      fPath: "item-actions-spec.js",
      distance: 1,
    };
    await main.selectList.update({ items: [item], query: "item-actions:7" });
    const open = spyOn(lumine.workspace, "open").and.resolveTo();

    await main.selectList.runAction("fuzzy-files:open");

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe(__filename);
    expect(open.calls.mostRecent().args[1].initialLine).toBe(6);
  });
});
