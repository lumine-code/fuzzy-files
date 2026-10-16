describe("fuzzy-files captured editor availability", () => {
  let main, editor, window;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;
    editor = lumine.workspace.buildTextEditor();
    window = {};
    main.finders.set(window, { opening: { editor } });
  });
  afterEach(() => {
    main.finders.delete(window);
    editor.destroy();
  });
  it("keeps source editor checks cached and distinguishes readonly copy from insertion", () => {
    const ensure = spyOn(main, "ensureFinder").and.throwError("query ensured UI"),
      commands = main.listCommands(window);
    expect(commands["fuzzy-files:insert-absolute-path"].isAvailable({})).toBe(true);
    editor.setReadOnly(true);
    expect(commands["fuzzy-files:insert-absolute-path"].isAvailable({})).toBe(false);
    expect(commands["fuzzy-files:copy-relative-path"].isAvailable({})).toBe(true);
    main.finders.get(window).opening.editor = null;
    expect(commands["fuzzy-files:copy-relative-path"].isAvailable({})).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });
});
