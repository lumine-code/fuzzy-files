const path = require("node:path");
const os = require("node:os");
const { CompositeDisposable } = require("lumine");
const PathsProvider = require("../lib/paths-provider");
const LazyPathsProvider = require("../lib/lazy-paths-provider");

describe("path completion document ownership", () => {
  let editor, grammar, source, provider, oldPaths;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    oldPaths = lumine.project.getPaths();
    lumine.project.setPaths([os.tmpdir()]);
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "none-path-current.txt"));
    editor.setText('"./');
    editor.setCursorBufferPosition([0, 3]);
    grammar = editor.getGrammar();
    source = {
      disposables: new CompositeDisposable(),
      activationGeneration: 1,
      itemsByPath: new Map([["fixture", { aPath: path.join(os.tmpdir(), "target.txt") }]]),
      observeIndex: jasmine.createSpy("observeIndex"),
      whenPrepared: jasmine.createSpy("whenPrepared").and.resolveTo(),
    };
    provider = new PathsProvider(source);
    provider.scopes = [{ scopes: "*", pathSyntax: true }];
  });
  afterEach(() => {
    editor.destroy();
    source.disposables.dispose();
    lumine.project.setPaths(oldPaths);
  });
  const request = (signal) => ({
    editor,
    signal,
    bufferPosition: editor.getCursorBufferPosition(),
    scopeDescriptor: { getScopesArray: () => ["text.plain"] },
  });

  it("does not read a None document or initialize its path index", async () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    spyOn(editor, "getTextInRange").and.callThrough();
    expect(await provider.getSuggestions(request())).toEqual([]);
    expect(editor.getTextInRange).not.toHaveBeenCalled();
    expect(source.observeIndex).not.toHaveBeenCalled();
    const lazy = new LazyPathsProvider(source);
    spyOn(lazy, "importProvider").and.resolveTo(PathsProvider);
    expect(await lazy.getSuggestions(request())).toEqual([]);
    expect(lazy.importProvider).not.toHaveBeenCalled();
  });

  it("abandons an old index wait across None and resumes independently", async () => {
    let release;
    source.whenPrepared.and.returnValue(new Promise((resolve) => (release = resolve)));
    const ranked = spyOn(provider, "suggestionsForScope").and.callThrough();
    const pending = provider.getSuggestions(request());
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    source.whenPrepared.and.resolveTo();
    expect((await provider.getSuggestions(request())).length).toBe(1);
    const resumed = ranked.calls.count();
    release();
    expect(await pending).toEqual([]);
    expect(ranked.calls.count()).toBe(resumed);
  });

  it("does not score the index after its caller cancels", async () => {
    let release;
    source.whenPrepared.and.returnValue(new Promise((resolve) => (release = resolve)));
    spyOn(provider, "suggestionsForScope").and.callThrough();
    const controller = new AbortController();
    const pending = provider.getSuggestions(request(controller.signal));
    controller.abort();
    release();
    expect(await pending).toEqual([]);
    expect(provider.suggestionsForScope).not.toHaveBeenCalled();
  });

  it("does not revive a pre-None lazy import after the same grammar returns", async () => {
    const lazy = new LazyPathsProvider(source);
    let release;
    spyOn(lazy, "importProvider").and.returnValue(new Promise((resolve) => (release = resolve)));
    const pending = lazy.getSuggestions(request());
    editor.setGrammar(lumine.grammars.nullGrammar);
    editor.setGrammar(grammar);
    release(PathsProvider);
    expect(await pending).toEqual([]);
    expect(source.observeIndex).not.toHaveBeenCalled();
  });
});
