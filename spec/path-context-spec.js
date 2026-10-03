const { relativePathContext, scopePathContext } = require("../lib/path-context");

describe("path completion contexts", () => {
  it("keeps other quote characters inside a quoted path", () => {
    const pathPrefix = "../assets/owner's file ]";
    expect(relativePathContext(`const file = "${pathPrefix}`)?.pathPrefix).toBe(pathPrefix);
  });

  it("does not split an active quoted path at another relative marker", () => {
    const pathPrefix = "../assets/folder ./nested/file";
    expect(relativePathContext(`"${pathPrefix}`)?.pathPrefix).toBe(pathPrefix);
  });

  it("does not interpret an escaped matching quote as the end of the path", () => {
    const pathPrefix = '../assets/escaped\\"name';
    expect(relativePathContext(`"${pathPrefix}`)?.pathPrefix).toBe(pathPrefix);
  });

  it("rejects nonliteral templates and strings whose value is not a path", () => {
    expect(relativePathContext("`../${folder}/file")).toBeNull();
    expect(relativePathContext('"some prose ../assets/file')).toBeNull();
    expect(scopePathContext("\"some prose require('file", ["require\\(['\"]"])).toBeNull();
  });

  it("ignores prose apostrophes before a bare path", () => {
    for (const line of ["// don't forget ../assets/file", "// users' ../assets/file"]) {
      expect(relativePathContext(line)?.pathPrefix).toBe("../assets/file");
    }
  });

  it("closes a bracket wrapper separated from the path by whitespace", () => {
    expect(relativePathContext("// [ ../assets/file]")).toBeNull();
    expect(relativePathContext("// ( ../assets/file(final)")?.pathPrefix).toBe(
      "../assets/file(final)",
    );
  });

  it("ignores quotes inside preceding regular expression literals", () => {
    for (const quote of ["'", '"']) {
      const line = `const pattern = /${quote}/; require(${quote}../assets/file`;
      expect(relativePathContext(line)?.pathPrefix).toBe("../assets/file");
      expect(scopePathContext(line, ["require\\(['\"]"])?.pathPrefix).toBe("../assets/file");
    }
  });

  it("rejects control characters instead of crossing line boundaries", () => {
    expect(relativePathContext("../assets/file\nother")).toBeNull();
    expect(relativePathContext("../assets/file\tother")).toBeNull();
  });
});
