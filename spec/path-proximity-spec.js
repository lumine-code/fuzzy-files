const path = require("node:path");
const { PathProximity } = require("../lib/path-proximity");

describe("File proximity", () => {
  const depth = (value) => value.split(/[\\/]/).length;
  for (const [name, implementation, roots] of [
    ["Windows", path.win32, ["C:\\", "D:\\", "\\\\server\\share\\", "\\\\other\\share\\"]],
    ["POSIX", path.posix, ["/", "/work", "/other"]],
  ]) {
    it(`agrees with relative-path depth for ${name} paths`, () => {
      let seed = 173;
      const random = (limit) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % limit;
      };
      const parts = ["src", "SRC", "src-extra", "alpha", "Żółć", "İ", "I", "with space", "..", "."];
      if (name === "POSIX") parts.push("back\\slash");
      const makePath = () =>
        implementation.resolve(
          roots[random(roots.length)],
          ...Array.from({ length: random(7) }, () => parts[random(parts.length)]),
        );
      const failures = [];
      for (let index = 0; index < 10000; index++) {
        const reference = makePath(),
          target = makePath();
        const proximity = new PathProximity(reference, implementation);
        const expected = depth(implementation.relative(implementation.dirname(reference), target));
        const actual = proximity.distanceTo(target);
        if (actual !== expected) failures.push({ reference, target, expected, actual });
      }
      expect(failures).toEqual([]);
    });

    it(`shares calculations between files in a ${name} directory`, () => {
      const relative = jasmine.createSpy("relative").and.callFake(implementation.relative);
      const api = { ...implementation, relative };
      const root = roots[0];
      const proximity = new PathProximity(implementation.join(root, "src", "current.js"), api);
      for (let index = 0; index < 100; index++) {
        expect(proximity.distanceTo(implementation.join(root, "other", `file-${index}.js`))).toBe(
          3,
        );
      }
      expect(relative.calls.count()).toBe(1);
      proximity.clear();
      expect(proximity.distanceTo(implementation.join(root, "other", "another.js"))).toBe(3);
      expect(relative.calls.count()).toBe(2);
    });
  }

  it("has no proximity bonus without an absolute pane-item path", () => {
    for (const reference of [null, undefined, "", "relative/file", "memory://document"]) {
      expect(new PathProximity(reference, path.posix).distanceTo("/work/file.js")).toBe(1);
    }
  });
});
