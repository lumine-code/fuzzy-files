describe("lazy path completion imports", () => {
  let main, provider, editor;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;
    provider = main.provideAutocomplete();
    editor = await lumine.workspace.open();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("fuzzy-files");
    editor?.destroy();
  });

  function request(signal) {
    return {
      editor,
      bufferPosition: editor.getCursorBufferPosition(),
      scopeDescriptor: { getScopesArray: () => ["source.js"] },
      prefix: "",
      signal,
    };
  }

  it("publishes metadata synchronously and shares the first native import", async () => {
    expect(provider.scopeSelector).toBe("*");
    expect(provider.suggestionPriority).toBe(3);
    expect(provider.provider).toBeNull();
    spyOn(provider, "importProvider").and.callThrough();
    const [first, second] = await Promise.all([provider.loadProvider(), provider.loadProvider()]);
    expect(first).toBe(second);
    expect(provider.importProvider).toHaveBeenCalledTimes(1);
    const PathsProvider = require("../lib/paths-provider");
    expect(first instanceof PathsProvider).toBe(true);
    expect(main.indexSubscription).toBeNull();
  });

  it("does not import while completion is disabled or the request is aborted", async () => {
    spyOn(provider, "importProvider").and.callThrough();
    lumine.config.set("fuzzy-files.pathCompletion.enabled", false);
    expect(await provider.getSuggestions(request())).toEqual([]);
    lumine.config.set("fuzzy-files.pathCompletion.enabled", true);
    expect(await provider.getSuggestions(request(AbortSignal.abort()))).toEqual([]);
    expect(provider.importProvider).not.toHaveBeenCalled();
  });

  it("drops a pending request when its package generation is retired", async () => {
    const PathsProvider = await provider.importProvider();
    let release;
    spyOn(provider, "importProvider").and.returnValue(
      new Promise((resolve) => (release = () => resolve(PathsProvider))),
    );
    spyOn(main, "observeIndex").and.callThrough();
    const pending = provider.getSuggestions(request());
    await lumine.packages.deactivatePackage("fuzzy-files");
    release();
    expect(await pending).toEqual([]);
    expect(provider.provider).toBeNull();
    expect(main.observeIndex).not.toHaveBeenCalled();
    main = (await lumine.packages.activatePackage("fuzzy-files")).mainModule;
    expect(main.provideAutocomplete()).not.toBe(provider);
  });

  it("does not consult a destroyed editor after a pending import", async () => {
    const PathsProvider = await provider.importProvider();
    let release;
    spyOn(provider, "importProvider").and.returnValue(
      new Promise((resolve) => (release = () => resolve(PathsProvider))),
    );
    const pending = provider.getSuggestions(request());
    editor.destroy();
    release();
    expect(await pending).toEqual([]);
    expect(main.indexSubscription).toBeNull();
  });

  it("does not consult the index when a request is aborted during import", async () => {
    const PathsProvider = await provider.importProvider();
    let release;
    spyOn(provider, "importProvider").and.returnValue(
      new Promise((resolve) => (release = () => resolve(PathsProvider))),
    );
    const controller = new AbortController();
    const pending = provider.getSuggestions(request(controller.signal));
    controller.abort();
    release();
    expect(await pending).toEqual([]);
    expect(main.indexSubscription).toBeNull();
  });

  it("retries a failed import and reads the latest scope configuration", async () => {
    const PathsProvider = await provider.importProvider();
    spyOn(provider, "importProvider").and.rejectWith(new Error("Held import failed"));
    await expectAsync(provider.loadProvider()).toBeRejectedWithError("Held import failed");
    lumine.config.set("fuzzy-files.pathCompletion.ignoreBuiltinScopes", true);
    lumine.config.set("fuzzy-files.pathCompletion.scopes", [{ scopes: "source.test" }]);
    provider.importProvider.and.resolveTo(PathsProvider);
    const loaded = await provider.loadProvider();
    expect(loaded.scopes).toEqual([{ scopes: "source.test" }]);
    expect(provider.importProvider).toHaveBeenCalledTimes(2);
  });
});
