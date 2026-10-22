const path = require("node:path");
const FileIndex = require("../lib/file-index");

describe("file metadata worker", () => {
  let index;
  const root = path.resolve("/worker-fixture");
  const file = (name) => path.join(root, name);
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await index?.close();
  });
  function create(patterns = []) {
    const matcher = lumine.project.compileIgnoredNames(patterns, { useCoreIgnoredNames: false });
    index = new FileIndex({
      roots: [{ path: root, paths: [root] }],
      rules: matcher.rules,
      caseInsensitive: matcher.caseInsensitive,
    });
    return matcher;
  }

  it("does not reuse a snapshot from a replaced metadata worker", async () => {
    create();
    await index.apply([file("old.js")], []);
    const previous = await index.snapshot(null);
    await index.close();
    create();
    await index.apply([file("new.js")], []);
    expect(index.revision).toBe(previous.revision);
    expect((await index.snapshot(null, previous)).items.map((item) => item.nPath)).toEqual([
      "new.js",
    ]);
  });

  it("lets repeated close calls await the same process termination", async () => {
    create();
    const first = index.close();
    const second = index.close();
    expect(second).toBe(first);
    await second;
    expect(index.worker.exitCode !== null || index.worker.signalCode !== null).toBe(true);
  });

  it("rejects queued cached snapshots after the helper closes", async () => {
    create();
    await index.apply([file("a.js")], []);
    const snapshot = await index.snapshot(null);
    const pending = index.snapshot(null, snapshot);
    const rejection = expectAsync(pending).toBeRejected();
    await index.close();
    await rejection;
    await expectAsync(index.snapshot(null, snapshot)).toBeRejected();
    await expectAsync(index.apply([], [])).toBeRejected();
  });

  it("retains immutable snapshots and processes removals, reinsertion and slot reuse", async () => {
    create();
    await index.apply([file("c.js"), file("a.js"), file("b.js")], []);
    const first = await index.snapshot(file("current.js"));
    expect(first.items.map((item) => item.nPath)).toEqual(["a.js", "b.js", "c.js"]);
    expect(await index.snapshot(file("other.js"), first)).toBe(first);
    const unchanged = first.items[2];
    await index.apply([file("d.js")], [file("b.js")]);
    const second = await index.snapshot(file("current.js"), first);
    expect(second.items.map((item) => item.nPath)).toEqual(["a.js", "c.js", "d.js"]);
    expect(second.items[1]).toBe(unchanged);
    expect(first.items.map((item) => item.nPath)).toEqual(["a.js", "b.js", "c.js"]);
    expect(index.slots.length).toBe(3);
    await index.apply([file("b.js")], [file("d.js")]);
    expect((await index.snapshot(null, second)).items.map((item) => item.nPath)).toEqual([
      "a.js",
      "b.js",
      "c.js",
    ]);
  });

  it("matches core ignored-name semantics across serialized regex rules", async () => {
    const patterns = [
      "cache",
      "*.log",
      "a/**/b",
      "/root-only",
      "[ab].txt",
      "!literal",
      "brace{one,two}.js",
      "file?.js",
    ];
    const matcher = create(patterns);
    const names = [
      "cache/a.js",
      "nested/cache/b.js",
      "x.log",
      "a/deep/b/file.js",
      "root-only/x",
      "nested/root-only/x",
      "a.txt",
      "c.txt",
      "!literal",
      "braceone.js",
      "file1.js",
      "file12.js",
      ".dev/kept.js",
      "bracetwo.js",
      "nested/UPPER.LOG",
      "bracket[.js",
    ];
    await index.apply(names.map(file), []);
    expect([...index.items.keys()].sort()).toEqual(
      names
        .filter((name) => !matcher.matches(name))
        .map(file)
        .sort(),
    );
  });

  it("applies every removal before additions even when a delta spans batches", async () => {
    create();
    const paths = Array.from({ length: 2050 }, (_, i) => file(`file-${i}.js`));
    await index.apply(paths, []);
    await index.apply([paths.at(-1)], paths);
    expect((await index.snapshot(null)).items.map((item) => item.aPath)).toEqual([paths.at(-1)]);
  });

  it("cancels one snapshot without poisoning later updates and terminates pending work", async () => {
    create();
    await index.apply([file("a.js")], []);
    const controller = new AbortController();
    // DialogSource uses string reasons, not just the default DOMException.
    controller.abort("closed");
    await expectAsync(index.snapshot(null, null, controller.signal)).toBeRejected();
    await index.apply([file("b.js")], []);
    expect((await index.snapshot(null)).items.length).toBe(2);
    const pending = index.snapshot(file("sub/current.js"));
    const rejected = expectAsync(pending).toBeRejected();
    await index.close();
    await rejected;
    expect(index.pending.size).toBe(0);
  });
});
