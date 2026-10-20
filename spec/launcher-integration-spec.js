const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("fuzzy-files native Launcher flow", () => {
  let main, chooser, host, scratch, selectedPath, background, pane;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finder-opener-flow-")));
    selectedPath = path.join(scratch, "selected.txt");
    const backgroundPath = path.join(scratch, "background.txt");
    fs.writeFileSync(selectedPath, "first\nsecond\nthird\n");
    fs.writeFileSync(backgroundPath, "background\n");
    background = await lumine.workspace.open(backgroundPath, { opener: "text-editor" });
    pane = lumine.workspace.paneForItem(background);
    chooser = (await lumine.packages.activatePackage("launcher")).mainModule;
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;
    const item = {
      aPath: selectedPath,
      pPath: scratch,
      fPath: "selected.txt",
      rPath: "selected.txt",
      distance: 1,
    };
    spyOn(main, "loadListSource").and.resolveTo({ items: [item] });
    host = main.ensureFinder();
    await host.show();
    await host.getModel().setQuery("selected:2");
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.workspace, "openEditorWindow").and.rejectWith(
      new Error("No native test window requested"),
    );
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("launcher");
    await lumine.packages.deactivatePackage("fuzzy-files");
    await host.destroy();
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(scratch + path.sep)) editor.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Finder flow fixture escaped the private temporary directory");
    await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function openChooser() {
    const result = await host.getModel().runAction("fuzzy-files:choose-opener");
    expect(result.status).toBe("success");
    const record = chooser.pickers.get(lumine.workspace.getMainWindow());
    expect(record.context.path).toBe(selectedPath);
    expect(record.context.initialLine).toBe(1);
    expect(record.context.pane).toBe(pane);
    expect(record.host.isVisible()).toBe(true);
    expect(lumine.workspace.getModalTrail()).toEqual(["Files", "Open"]);
    return record.host;
  }

  it("captures the chosen file and line while suspending the finder, then returns through the modal trail", async () => {
    const child = await openChooser();
    expect(child.getModel().getSelectedItem().id).toBe("text-editor");
    expect(host.isVisible()).toBe(false);
    expect(background.getText()).toBe("background\n");
    expect(lumine.workspace.popModal()).toBe(true);
    await child.destroy();

    expect(lumine.workspace.getModalTrail()).toEqual(["Files"]);
    expect(host.isVisible()).toBe(true);
    expect(host.getModel().getQuery()).toBe("selected:2");
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(lumine.workspace.openEditorWindow).not.toHaveBeenCalled();
  });

  it("opens the explicit file in the original pane at the captured query line", async () => {
    const child = await openChooser();
    const result = await child.getModel().confirmSelection();

    expect(result.status).toBe("success");
    const editor = pane.getItems().find((item) => item.getPath?.() === selectedPath);
    expect(editor.getText()).toBe("first\nsecond\nthird\n");
    expect(editor.getCursorBufferPosition().row).toBe(1);
    expect(background.getText()).toBe("background\n");
    expect(lumine.application.openWindow).not.toHaveBeenCalled();
    expect(lumine.workspace.openEditorWindow).not.toHaveBeenCalled();
    expect(child.isDestroyed()).toBe(true);
  });
});
