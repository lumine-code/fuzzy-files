const javascriptPrefixes = [
  "\\bimport\\s+[^;]*?\\bfrom\\s+['\"]", // import foo from './foo'
  "\\bimport\\s+['\"]", // import './foo'
  "\\b(?:require|import)\\s*\\(\\s*['\"`]", // require('./foo') or import('./foo')
  "\\bdefine\\s*\\(\\s*\\[?\\s*['\"]", // define(['./foo']) or define('./foo')
];

// no index replacement
const javascriptReplaceOnInsert = [
  ["\\.jsx?$", ""],
  ["\\.ts$", ""],
  ["\\.coffee$", ""],
];

// with index replacement
const javascriptWithIndexReplaceOnInsert = [
  ["([\\/]?index)?\\.jsx?$", ""],
  ["([\\/]?index)?\\.ts$", ""],
  ["([\\/]?index)?\\.coffee$", ""],
];

const DefaultScopes = [
  {
    scopes: ["*"],
    // Recognize the active path span with its quotes or surrounding delimiters.
    // Language-specific imports take precedence over this general fallback.
    pathSyntax: true,
    relative: true,
    fallback: true,
  },
  {
    scopes: [
      "source.js",
      "source.js.jsx",
      "source.coffee",
      "source.coffee.jsx",
      "source.ts",
      "source.tsx",
      "javascript",
    ],
    prefixes: javascriptPrefixes,
    relative: true,
    replaceOnInsert: javascriptWithIndexReplaceOnInsert,
  },
  {
    scopes: ["text.html.vue"],
    prefixes: javascriptPrefixes,
    relative: true,
    replaceOnInsert: javascriptReplaceOnInsert,
  },
  {
    scopes: ["text.html.vue"],
    prefixes: [
      "@import\\s*(?:\\(\\s*)?['\"]", // @import 'foo' or @import('foo')
    ],
    relative: true,
    replaceOnInsert: [
      ["(/)?_([^/]*?)$", "$1$2"], // dir1/_dir2/_file.sass => dir1/_dir2/file.sass
    ],
  },
  {
    scopes: ["source.coffee", "source.coffee.jsx"],
    prefixes: [
      "\\brequire\\s+['\"]", // require './foo'
      "\\bdefine\\s+\\[?\\s*['\"]", // define ['./foo'] or define './foo'
    ],
    relative: true,
    replaceOnInsert: javascriptReplaceOnInsert,
  },
  {
    scopes: ["source.php"],
    prefixes: ["\\b(?:require(?:_once)?|include(?:_once)?)\\s*(?:\\(\\s*)?['\"]"],
    relative: true,
  },
  {
    scopes: ["source.sass", "source.css.scss", "source.css.less", "source.stylus"],
    prefixes: [
      "@import\\s*(?:\\(\\s*)?['\"]", // @import 'foo' or @import('foo')
    ],
    relative: true,
    replaceOnInsert: [
      ["(/)?_([^/]*?)$", "$1$2"], // dir1/_dir2/_file.sass => dir1/_dir2/file.sass
    ],
  },
  {
    scopes: ["source.css"],
    prefixes: [
      "@import\\s+['\"]?", // @import 'foo.css'
      "@import\\s+url\\(\\s*['\"]?", // @import url('foo.css')
    ],
    relative: true,
  },
  {
    scopes: ["source.css", "source.sass", "source.css.less", "source.css.scss", "source.stylus"],
    prefixes: ["\\burl\\(\\s*['\"]?"],
    relative: true,
  },
  {
    scopes: ["source.c", "source.cpp"],
    prefixes: ['^\\s*#include\\s+["<]'],
    relative: true,
    includeCurrentDirectory: false,
  },
  {
    scopes: ["source.lua"],
    prefixes: ["\\brequire\\s*(?:\\(\\s*)?['\"]"],
    relative: true,
    includeCurrentDirectory: false,
    replaceOnInsert: [
      ["\\/", "."],
      ["\\\\", "."],
      ["\\.lua$", ""],
    ],
  },
  {
    scopes: ["source.ruby"],
    prefixes: ["^\\s*require\\s*(?:\\(\\s*)?['\"]"],
    relative: true,
    includeCurrentDirectory: false,
    replaceOnInsert: [["\\.rb$", ""]],
  },
  {
    scopes: ["source.python"],
    prefixes: ["^\\s*from\\s+", "^\\s*import\\s+"],
    relative: true,
    includeCurrentDirectory: false,
    replaceOnInsert: [
      ["\\/", "."],
      ["\\\\", "."],
      ["\\.py$", ""],
    ],
  },
];

module.exports = { DefaultScopes };
