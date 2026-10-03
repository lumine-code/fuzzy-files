const path = require("node:path");

const htmlEntities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
// HTML numeric references retain this legacy Windows-1252 mapping even in UTF-8.
// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
const htmlNumericReplacements = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function decodeHtml(value) {
  return value.replace(
    /&(#(?:x|X)[\da-fA-F]+|#\d+|amp|AMP|quot|QUOT|apos|lt|LT|gt|GT);/g,
    (_entity, name) => {
      if (!name.startsWith("#")) return htmlEntities[name.toLowerCase()];
      const hex = name[1].toLowerCase() === "x";
      const codePoint = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
        return "\ufffd";
      return String.fromCodePoint(htmlNumericReplacements[codePoint] ?? codePoint);
    },
  );
}

function decodePathPrefix(context, encoding = "backslash") {
  const { pathPrefix, quote } = context;
  const raw = encoding === "html" ? decodeHtml(pathPrefix) : pathPrefix;
  // Explicit slash syntax on POSIX leaves backslashes available as filename
  // characters. The .\ and ..\ forms still select Windows separator syntax.
  const slashIndex = raw.indexOf("/");
  const backslashIndex = raw.indexOf("\\");
  const slashStyle = slashIndex >= 0 && (backslashIndex < 0 || slashIndex < backslashIndex);
  const explicitBackslashStyle = /^\.{1,2}\\/.test(raw);
  const backslashSeparators = path.sep === "\\" || !slashStyle;
  let result = "";
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    const next = raw[index + 1];
    if (character !== "\\") {
      result += character;
    } else if (
      quote &&
      encoding !== "html" &&
      (next === quote || (quote === "`" && next === "$" && raw[index + 2] === "{"))
    ) {
      result += next;
      index++;
    } else if (quote && encoding !== "html" && next === "\\") {
      result += path.sep === "\\" || explicitBackslashStyle ? "/" : "\\";
      index++;
    } else {
      result += backslashSeparators ? "/" : "\\";
    }
  }
  return result;
}

function encodePath(value, context, encoding = "backslash") {
  const { quote } = context;
  if (!quote) return value;
  if (encoding === "html") {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll(quote, quote === '"' ? "&quot;" : "&#39;");
  }
  let result = value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
  if (quote === "`") result = result.replaceAll("${", "\\${");
  return result;
}

module.exports = { decodePathPrefix, encodePath };
