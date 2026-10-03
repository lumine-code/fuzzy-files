const OptionScopes = {
  enableHtmlSupport: [
    {
      scopes: ["text.html.basic"],
      prefixes: ["\\b(?:src|href)\\s*=\\s*['\"]"],
      relative: true,
      pathEncoding: "html",
    },
  ],
};

module.exports = { OptionScopes };
