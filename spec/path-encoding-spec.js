const path = require("node:path");
const vm = require("node:vm");
const { decodePathPrefix, encodePath } = require("../lib/path-encoding");
const { relativePathContext, scopePathContext } = require("../lib/path-context");

describe("path text encoding", () => {
  it("inserts filenames as literal JavaScript strings in each quote style", () => {
    const value = './owner\'s "quoted" `tick` ${missingPathVariable}.js';
    for (const quote of ["'", '"', "`"]) {
      const encoded = encodePath(value, { quote });
      expect(vm.runInNewContext(`${quote}${encoded}${quote}`)).toBe(value);
      const context = relativePathContext(quote + encoded);
      expect(context).not.toBeNull();
      expect(decodePathPrefix(context)).toBe(value);
    }
  });

  it("finds filenames after their matching quote has already been escaped", () => {
    expect(decodePathPrefix({ pathPrefix: "../owner\\'s.js", quote: "'" })).toBe("../owner's.js");
    expect(decodePathPrefix({ pathPrefix: '../quoted\\"name.js', quote: '"' })).toBe(
      '../quoted"name.js',
    );
    expect(decodePathPrefix({ pathPrefix: "../tick\\`name.js", quote: "`" })).toBe(
      "../tick`name.js",
    );
  });

  it("keeps escaped template interpolation literal and rejects active interpolation", () => {
    const literal = relativePathContext("`../\\${folder}/file");
    expect(decodePathPrefix(literal)).toBe("../${folder}/file");
    expect(relativePathContext("`../${folder}/file")).toBeNull();
    expect(relativePathContext("`../\\\\${folder}/file")).toBeNull();
  });

  it("preserves native directory boundaries when insertion retains native separators", () => {
    const value = path.join("..", "owner's directory", "file.js");
    const expected = value.split(path.sep).join("/");
    for (const quote of ["'", '"', "`"]) {
      const encoded = encodePath(value, { quote });
      expect(vm.runInNewContext(`${quote}${encoded}${quote}`)).toBe(value);
      expect(decodePathPrefix({ pathPrefix: encoded, quote })).toBe(expected);
    }
  });

  it("uses explicit backslash syntax as directory separators on every platform", () => {
    expect(decodePathPrefix({ pathPrefix: "..\\assets\\file.js" })).toBe("../assets/file.js");
    expect(decodePathPrefix({ pathPrefix: ".\\assets\\file.js" })).toBe("./assets/file.js");
  });

  it("distinguishes POSIX filename backslashes from Windows directory separators", () => {
    const value = "../assets/a\\b.js";
    const expected = path.sep === "\\" ? "../assets/a/b.js" : value;
    expect(decodePathPrefix({ pathPrefix: value })).toBe(expected);
    for (const quote of ["'", '"', "`"]) {
      expect(decodePathPrefix({ pathPrefix: encodePath(value, { quote }), quote })).toBe(expected);
    }
  });

  it("preserves escaped POSIX backslashes in project-relative and absolute paths", () => {
    for (const value of ["a\\b.js", "assets/a\\b.js", "/root/assets/a\\b.js"]) {
      const expected = path.sep === "\\" ? value.replaceAll("\\", "/") : value;
      expect(decodePathPrefix({ pathPrefix: encodePath(value, { quote: '"' }), quote: '"' })).toBe(
        expected,
      );
    }
    expect(decodePathPrefix({ pathPrefix: "assets\\file.js", quote: '"' })).toBe("assets/file.js");
  });

  it("quotes HTML attributes with entities and preserves entity-looking filenames", () => {
    const value = './owner\'s "quoted" &quot; & < >.js';
    for (const quote of ["'", '"']) {
      const encoded = encodePath(value, { quote }, "html");
      expect(encoded.includes(quote)).toBe(false);
      expect(encoded).toContain("&amp;quot;");
      expect(decodePathPrefix({ pathPrefix: encoded, quote }, "html")).toBe(value);
    }
  });

  it("decodes common HTML named and decimal or hexadecimal numeric entities", () => {
    const prefix = "../a&amp;b&quot;c&apos;d&lt;e&gt;f&#32;g&#x1f60a;.js";
    expect(decodePathPrefix({ pathPrefix: prefix, quote: '"' }, "html")).toBe(
      "../a&b\"c'd<e>f g😊.js",
    );
  });

  it("keeps unrecognized HTML entity names literal", () => {
    const prefix = "../&QuOt;&APOS;&unknown;.js";
    expect(decodePathPrefix({ pathPrefix: prefix, quote: '"' }, "html")).toBe(prefix);
  });

  it("applies HTML's legacy numeric mapping without changing literal C1 characters", () => {
    expect(decodePathPrefix({ pathPrefix: "../&#128;&#x85;&#X9F;.js", quote: '"' }, "html")).toBe(
      "../€…Ÿ.js",
    );
    expect(decodePathPrefix({ pathPrefix: "../\u0080&#129;&#x8D;.js", quote: '"' }, "html")).toBe(
      "../\u0080\u0081\u008d.js",
    );
  });

  it("uses HTML's replacement character for null and invalid Unicode numeric references", () => {
    for (const reference of ["&#0;", "&#xD800;", "&#xDFFF;", "&#1114112;", "&#x110000;"]) {
      expect(decodePathPrefix({ pathPrefix: `../${reference}.js`, quote: '"' }, "html")).toBe(
        "../�.js",
      );
    }
    expect(decodePathPrefix({ pathPrefix: "../&#x10FFFF;.js", quote: '"' }, "html")).toBe(
      "../\u{10ffff}.js",
    );
  });

  it("recognizes a later HTML path after an attribute ending with a backslash", () => {
    const line = '<img title="a\\" src="./assets/file';
    const context = scopePathContext(line, ["\\bsrc\\s*=\\s*['\"]"], {
      encoding: "html",
    });
    expect(context).not.toBeNull();
    expect(context.pathPrefix).toBe("./assets/file");
    expect(decodePathPrefix(context, "html")).toBe("./assets/file");
  });
});
