// Publishing autocomplete stays synchronous. Its path parsers and scope tables
// are only needed when an editor actually requests suggestions.
const pathRequest = require("./path-request");

module.exports = class LazyPathsProvider {
  constructor(source) {
    this.source = source;
    this.activationGeneration = source.activationGeneration;
    this.scopeSelector = "*";
    this.inclusionPriority = 1;
    this.provider = null;
    this.pendingProvider = null;
  }

  get enabled() {
    return (
      this.source.disposables != null &&
      this.activationGeneration === this.source.activationGeneration &&
      lumine.config.get("fuzzy-files.pathCompletion.enabled") !== false
    );
  }

  get suggestionPriority() {
    return lumine.config.get("fuzzy-files.pathCompletion.suggestionPriority");
  }

  reloadScopes() {
    this.provider?.reloadScopes();
  }

  importProvider() {
    return import("./paths-provider.js").then((module) => module.default ?? module);
  }

  loadProvider() {
    if (this.provider) return Promise.resolve(this.provider);
    if (!this.pendingProvider) {
      this.pendingProvider = this.importProvider()
        .then((PathsProvider) => {
          if (!this.enabled) return null;
          this.provider = new PathsProvider(this.source);
          return this.provider;
        })
        .finally(() => {
          this.pendingProvider = null;
        });
    }
    return this.pendingProvider;
  }

  async getSuggestions(request) {
    return pathRequest(this, request, async (isCurrent) => {
      const provider = await this.loadProvider();
      if (!provider || !isCurrent()) return [];
      return provider.getSuggestions(request);
    });
  }
};
