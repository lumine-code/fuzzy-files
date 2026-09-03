const { CompositeDisposable, Disposable } = require("lumine");
const { shell } = require("electron");
const path = require("path");
const fs = require("fs");

module.exports = {
  openExternalService: null,
  nativeClipService: null,
  treeViewService: null,
  scoreModifiers: [],
  ignoredNamesMatcher: null,
  // Keyed on `aPath`, so a path leaving the index costs a lookup rather than a
  // scan of every item. Materialized into `items` in `syncList()`, which already
  // walks all of them to relativize.
  itemsByPath: new Map(),
  items: [],
  itemsSynced: false,
  viewSynced: false,
  selectList: null,
  disposables: null,
  indexSubscription: null,
  separator: 0,
  projectCount: 0,
  recentlyUsed: [],
  recentCount: 0,

  activate(state) {
    this.itemsByPath = new Map();
    this.items = [];
    this.itemsSynced = false;
    this.projectCount = lumine.project.getPaths().length;
    this.recentCount = lumine.config.get("fuzzy-files.recentCount");
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (aPath) => typeof aPath === "string",
        ),
      ),
    ].slice(0, this.recentCount);

    this.selectList = lumine.workspace.buildSelectList({
      className: "fuzzy-files",
      crumb: "Files",
      emptyMessage: "No matches found",
      getItemId: (item) => item.aPath,
      search: {
        getFilterText: (item) => this.displayPath(item),
        parseQuery: (query) => this.parseQuery(query),
        ignoreDiacritics: true,
        algorithm: "command-t",
        scoreModifier: (score, item) => this.modifyScore(score, item),
      },
      renderItem: (item, options) => this.renderItem(item, options),
      source: {
        mode: "snapshot",
        loadingMessage: "Indexing project…",
        load: ({ signal }) => this.loadListSource(signal),
      },
      commands: this.listCommands(),
      actions: this.listActions(),
      recents: {
        limit: this.recentCount,
        adapter: {
          load: () => this.recentlyUsed,
          save: (ids) => {
            this.recentlyUsed = [...ids];
          },
        },
      },
    });

    this.disposables = new CompositeDisposable(
      lumine.config.observe("fuzzy-files.separator", (value) => {
        this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-files.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        void this.selectList.setRecentLimit(newValue);
      }),
      lumine.commands.add("lumine-workspace", {
        "fuzzy-files:toggle": () => this.selectList.toggle(),
        "fuzzy-files:refresh": {
          description: "Crawl the project again to pick up changes made outside the editor.",
          didDispatch: () => this.refresh(),
        },
        "fuzzy-files:clear-recent": {
          description: "Forget the recently used files kept at the top of the list.",
          didDispatch: () => this.selectList.clearRecentItems(),
        },
      }),
      // The project's file index already follows `onDidChangeFiles` and
      // re-crawls on a `core.*` policy change, so none of that is repeated here.
      // Only the root count and this package's own exclusions are left.
      lumine.project.onDidChangePaths((projectPaths) => {
        // `displayPath` prefixes the root's name once there is more than one,
        // and that string is the list's filter key.
        this.projectCount = projectPaths.length;
        this.viewSynced = false;
      }),
      lumine.config.onDidChange("fuzzy-files.ignoredNames", () => {
        this.compileIgnoredNames();
        // Do not make a settings change the first use of the shared index. If
        // the finder has already subscribed, rebuild only this package's view
        // over the current snapshot; the index's crawl policy did not change.
        if (this.indexSubscription) this.rebuildItems();
      }),
      lumine.workspace.onDidChangeActivePaneItem(() => {
        // Only once there is something to relativize: before the finder has
        // ever been opened this package holds no items and wants no index.
        if (!this.itemsSynced) return;
        this.relativize();
        this.viewSynced = false;
        if (this.selectList.isVisible()) this.syncList();
      }),
    );

    this.compileIgnoredNames();
  },

  listCommands() {
    return {
      "fuzzy-files:open": {
        description: "Open the file, at the line given after a colon in the query.",
        didDispatch: (event) => this.performAction("open", {}, event.detail),
      },
      "fuzzy-files:open-external": {
        description: "Open the file in the default external program.",
        didDispatch: (event) => this.performAction("open-external", {}, event.detail),
      },
      "fuzzy-files:show-in-folder": {
        description: "Show the file in the system file manager.",
        didDispatch: (event) => this.performAction("show-in-folder", {}, event.detail),
      },
      "fuzzy-files:trash": {
        description: "Move the file to the system trash, where it can be restored.",
        didDispatch: (event) => this.performAction("trash", {}, event.detail),
      },
      "fuzzy-files:split-left": {
        description: "Open the file in a pane to the left.",
        didDispatch: (event) => this.performAction("split", { side: "left" }, event.detail),
      },
      "fuzzy-files:split-right": {
        description: "Open the file in a pane to the right.",
        didDispatch: (event) => this.performAction("split", { side: "right" }, event.detail),
      },
      "fuzzy-files:split-up": {
        description: "Open the file in a pane above.",
        didDispatch: (event) => this.performAction("split", { side: "up" }, event.detail),
      },
      "fuzzy-files:split-down": {
        description: "Open the file in a pane below.",
        didDispatch: (event) => this.performAction("split", { side: "down" }, event.detail),
      },
      "fuzzy-files:insert-project-path": {
        description: "Insert the path relative to the project root.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "p" }, event.detail),
      },
      "fuzzy-files:insert-absolute-path": {
        description: "Insert the full path from the filesystem root into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "a" }, event.detail),
      },
      "fuzzy-files:insert-relative-path": {
        description: "Insert the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "r" }, event.detail),
      },
      "fuzzy-files:insert-file-name": {
        description: "Insert the base name, without its directories, into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "n" }, event.detail),
      },
      "fuzzy-files:copy-project-path": {
        description: "Copy the path relative to the project root.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "p" }, event.detail),
      },
      "fuzzy-files:copy-absolute-path": {
        description: "Copy the full path from the filesystem root to the clipboard.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "a" }, event.detail),
      },
      "fuzzy-files:copy-relative-path": {
        description: "Copy the path relative to the active editor.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "r" }, event.detail),
      },
      "fuzzy-files:copy-file-name": {
        description: "Copy the base name, without its directories, to the clipboard.",
        didDispatch: (event) => this.performAction("path", { op: "copy", rel: "n" }, event.detail),
      },
      "fuzzy-files:refresh-index": {
        description: "Crawl the project again to pick up changes made outside the editor.",
        didDispatch: () => this.refresh(),
      },
      "fuzzy-files:use-default-separator": {
        description: "Use the platform path separator.",
        didDispatch: () => {
          lumine.config.set("fuzzy-files.separator", 0);
          lumine.notifications.addHint("Separator has been changed to default");
        },
      },
      "fuzzy-files:use-forward-slashes": {
        description: "Use forward slashes in inserted and copied paths.",
        didDispatch: () => {
          lumine.config.set("fuzzy-files.separator", 1);
          lumine.notifications.addHint("Separator has been changed to forward slash");
        },
      },
      "fuzzy-files:use-backslashes": {
        description: "Use backslashes in inserted and copied paths.",
        didDispatch: () => {
          lumine.config.set("fuzzy-files.separator", 2);
          lumine.notifications.addHint("Separator has been changed to backslash");
        },
      },
      "fuzzy-files:cut-file": {
        description: "Cut the file to the system clipboard.",
        didDispatch: (event) => this.performAction("clip", { effect: "cut" }, event.detail),
      },
      "fuzzy-files:copy-file": {
        description: "Copy the file to the system clipboard.",
        didDispatch: (event) => this.performAction("clip", { effect: "copy" }, event.detail),
      },
      "fuzzy-files:query-selected-path": {
        description: "Continue the query from the selected path.",
        didDispatch: (event) => this.updateQueryFromItem(event.detail.item),
      },
      "fuzzy-files:query-selection": {
        description: "Use the editor selection as the query.",
        didDispatch: () => this.selectList.setQueryFromSelection(),
      },
      "fuzzy-files:reveal-in-tree-view": {
        description: "Expand the tree view to the file and select it there.",
        didDispatch: (event) => this.performAction("reveal-in-tree-view", {}, event.detail),
      },
    };
  },

  listActions() {
    const itemAction = (command, group, options = {}) => ({
      command,
      context: "item",
      group,
      disposition: "close",
      recordsRecent: (_context, _action, result) => result !== false,
      ...options,
    });
    const dialogAction = (command, group, options = {}) => ({
      command,
      context: "dialog",
      group,
      disposition: "stay",
      ...options,
    });
    return [
      itemAction("fuzzy-files:open", "Open", { primary: true }),
      itemAction("fuzzy-files:open-external", "Open"),
      itemAction("fuzzy-files:show-in-folder", "Open"),
      itemAction("fuzzy-files:reveal-in-tree-view", "Open"),
      itemAction("fuzzy-files:split-left", "Split"),
      itemAction("fuzzy-files:split-right", "Split"),
      itemAction("fuzzy-files:split-up", "Split"),
      itemAction("fuzzy-files:split-down", "Split"),
      itemAction("fuzzy-files:insert-project-path", "Insert Path"),
      itemAction("fuzzy-files:insert-absolute-path", "Insert Path"),
      itemAction("fuzzy-files:insert-relative-path", "Insert Path"),
      itemAction("fuzzy-files:insert-file-name", "Insert Path"),
      itemAction("fuzzy-files:copy-project-path", "Copy Path"),
      itemAction("fuzzy-files:copy-absolute-path", "Copy Path"),
      itemAction("fuzzy-files:copy-relative-path", "Copy Path"),
      itemAction("fuzzy-files:copy-file-name", "Copy Path"),
      itemAction("fuzzy-files:cut-file", "Clipboard"),
      itemAction("fuzzy-files:copy-file", "Clipboard"),
      itemAction("fuzzy-files:trash", "Manage", { tone: "danger" }),
      itemAction("fuzzy-files:query-selected-path", "Query", {
        disposition: "stay",
        recordsRecent: false,
      }),
      dialogAction("fuzzy-files:query-selection", "Query"),
      dialogAction("fuzzy-files:refresh-index", "Finder"),
      dialogAction("fuzzy-files:use-default-separator", "Path Separator"),
      dialogAction("fuzzy-files:use-forward-slashes", "Path Separator"),
      dialogAction("fuzzy-files:use-backslashes", "Path Separator"),
    ];
  },

  serialize() {
    return { recentlyUsed: this.recentlyUsed };
  },

  deactivate() {
    this.indexSubscription?.dispose();
    this.indexSubscription = null;
    this.disposables.dispose();
    this.selectList.destroy();
  },

  // Subscribing is what builds the project's file index, so it waits until the
  // finder is first opened rather than running at activation: a window where
  // nobody opens the finder should not crawl for it.
  observeIndex() {
    if (this.indexSubscription) return;
    this.indexSubscription = lumine.project.observeFilePaths(({ added, removed, indexing }) => {
      for (const aPath of removed) this.itemsByPath.delete(aPath);
      for (const aPath of added) this.addItem(aPath);
      this.itemsSynced = false;
      this.viewSynced = false;
      if (this.selectList.isVisible()) this.syncList({ indexing });
    });
  },

  // Resolves once the index has settled, for specs and for anything that needs
  // the full list rather than whatever has arrived so far.
  whenIndexed(signal) {
    this.observeIndex();
    if (!lumine.project.isIndexing()) return Promise.resolve();
    if (signal?.aborted) {
      const error = new Error("File indexing was cancelled.");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let subscription;
      let settled = false;
      const abort = () => {
        settled = true;
        subscription?.dispose();
        const error = new Error("File indexing was cancelled.");
        error.name = "AbortError";
        reject(error);
      };
      subscription = lumine.project.observeFilePaths(({ indexing }) => {
        if (indexing) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        subscription?.dispose();
        resolve();
      });
      if (settled) subscription.dispose();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  },

  async loadListSource(signal) {
    this.observeIndex();
    await this.whenIndexed(signal);
    return this.listSnapshot();
  },

  compileIgnoredNames() {
    // The index has already applied core policy. Asking the shared helper to
    // compile only this package's additions avoids pinning a second snapshot of
    // `core.ignoredNames` in the finder while retaining identical glob rules.
    this.ignoredNamesMatcher = lumine.project.compileIgnoredNames(
      lumine.config.get("fuzzy-files.ignoredNames") || [],
      { useCoreIgnoredNames: false },
    );
  },

  // The index reports absolute paths; everything the list renders is derived
  // from them here. A path this package excludes never becomes an item at all.
  addItem(aPath) {
    const [pPath, fPath] = lumine.project.relativizePath(aPath);
    if (!pPath || !fPath) return;

    const normalizedPath = path.normalize(fPath);
    if (this.ignoredNamesMatcher.matches(normalizedPath)) return;

    this.itemsByPath.set(aPath, {
      pPath,
      fPath: normalizedPath,
      aPath: path.join(pPath, normalizedPath),
      nPath: path.basename(normalizedPath),
    });
  },

  // Only needed when this package's own exclusions change: the index is
  // unaffected by them, so there is nothing to re-crawl.
  rebuildItems() {
    this.itemsByPath.clear();
    for (const aPath of lumine.project.getFilePaths()) this.addItem(aPath);
    this.itemsSynced = false;
    this.viewSynced = false;
    if (this.selectList.isVisible()) this.syncList();
  },

  // Materialize the map into the array the list renders, in path order. The
  // index is deliberately unsorted -- sorting the crawl costs ripgrep its
  // parallel walk for every consumer -- and this is the only place the order is
  // observable: with an empty query the list shows its first page unscored.
  // Byte order, matching what `--sort path` used to give; `localeCompare` over
  // tens of thousands of strings is an order of magnitude slower.
  materialize() {
    if (this.itemsSynced) return;
    this.items = Array.from(this.itemsByPath.values());
    this.items.sort((a, b) => (a.aPath < b.aPath ? -1 : a.aPath > b.aPath ? 1 : 0));
    this.itemsSynced = true;
  },

  relativize(editor) {
    if (!editor) editor = lumine.workspace.getActiveTextEditor();
    let editorPath = editor ? editor.getPath() : undefined;
    if (!editor || !editorPath) {
      for (let item of this.items) {
        item.rPath = item.fPath;
        item.distance = 1;
      }
    } else {
      for (let item of this.items) {
        item.rPath = path.relative(path.dirname(editorPath), item.aPath);
        let match = item.rPath.match(/[\\/\\]/g);
        item.distance = match ? match.length + 1 : 1;
      }
    }
  },

  renderItem(item, { highlight }) {
    return {
      primary: highlight(this.displayPath(item)),
      didRender: (li) => {
        lumine.icons.applyTo(
          li.firstChild,
          { path: item.aPath, context: "fuzzy-files", hints: { directory: false } },
          { name: path.basename(item.aPath) },
        );
        const listener = (event) => this.openExternalOnAltClick(event, item);
        li.addEventListener("click", listener);
        return new Disposable(() => li.removeEventListener("click", listener));
      },
    };
  },

  openExternalOnAltClick(event, item) {
    if (event.button !== 0 || !event.altKey || !this.openExternalService) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.selectList.selectItem(item);
    void this.selectList.runAction("fuzzy-files:open-external");
  },

  displayPath(item) {
    if (this.projectCount > 1) {
      return path.join(path.basename(item.pPath), item.fPath);
    }
    return item.fPath;
  },

  syncList({ indexing = lumine.project.isIndexing(), ...props } = {}) {
    this.viewSynced = true;
    this.materialize();
    this.relativize();
    if (indexing) this.selectList.setLoadingState({ message: "Indexing project…" });
    else this.selectList.clearLoadingState();
    return this.selectList.update({
      items: this.items,
      infoMessage: indexing ? null : this.infoLine(),
      ...props,
    });
  },

  listSnapshot() {
    this.viewSynced = true;
    this.materialize();
    this.relativize();
    return { items: this.items, infoMessage: this.infoLine() };
  },

  parseQuery(query) {
    const colon = query.indexOf(":");
    if (colon !== -1) {
      const initialLineRaw = query.substring(colon + 1);
      const initialLine = initialLineRaw.match(/^\d+$/) ? parseInt(initialLineRaw) - 1 : 0;
      return { text: query.slice(0, colon), data: { initialLine } };
    }
    return { text: query, data: { initialLine: 0 } };
  },

  modifyScore(score, item) {
    const depth = (item.fPath.match(/[\\/]/g) || []).length + 1;
    let modifiedScore = score / (item.distance * Math.sqrt(depth));
    for (const fn of this.scoreModifiers) {
      modifiedScore = fn(modifiedScore, item);
    }
    return modifiedScore;
  },

  // The command table moved to the actions list; the index size is the
  // one thing only this line can say. It counts what the finder lists, which is
  // the shared index minus this package's own exclusions.
  infoLine() {
    return `${this.itemsByPath.size} files in ${this.projectCount} project${
      this.projectCount !== 1 ? "s" : ""
    }`;
  },

  refresh() {
    // The index is shared, so this re-crawls for every consumer of it, not just
    // the finder — which is right, since the index is the thing that is stale.
    const refresh = lumine.project.refreshFilePaths();
    this.viewSynced = false;
    if (this.selectList.isVisible()) void this.selectList.reload();
    return refresh;
  },

  updateQueryFromItem(item = this.selectList.getSelectedItem()) {
    if (!item) return false;
    const text = this.displayPath(item) + path.sep;
    this.selectList.setQuery(text);
    this.selectList.getQueryEditor().moveToEndOfLine();
    return true;
  },

  performAction(mode, params = {}, context = {}) {
    const item = context.item ?? this.selectList.getSelectedItem();
    if (!item) return;

    let editor, aPath, text;

    if (mode === "open") {
      aPath = item.aPath;
      try {
        if (!fs.lstatSync(aPath).isFile()) {
          this.updateQueryFromItem(item);
          return false;
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: aPath,
        });
      }
    }

    if (mode === "open") {
      return lumine.workspace.open(item.aPath, {
        initialLine: context.parsedQuery?.data?.initialLine ?? 0,
        pending: lumine.config.get("core.allowPendingPaneItems"),
      });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        return this.openExternalService.openExternal(item.aPath);
      } else {
        return shell.openPath(item.aPath);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        return this.openExternalService.showInFolder(item.aPath);
      } else {
        return shell.showItemInFolder(item.aPath);
      }
    } else if (mode === "trash") {
      aPath = item.aPath;
      return lumine.shell
        .trashItem(aPath)
        .then(() =>
          lumine.notifications.addSuccess("Item has been trashed", {
            detail: aPath,
          }),
        )
        .catch(() =>
          lumine.notifications.addError("Item cannot be trashed", {
            detail: aPath,
          }),
        );
    } else if (mode === "split") {
      aPath = item.aPath;
      try {
        if (fs.lstatSync(aPath).isFile()) {
          return lumine.workspace.open(aPath, {
            initialLine: context.parsedQuery?.data?.initialLine ?? 0,
            split: params.side,
          });
        } else {
          lumine.notifications.addError(`Cannot open path, because it's a dir`, {
            detail: aPath,
          });
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: aPath,
        });
      }
    } else if (mode === "path") {
      if (params.rel === "p") {
        text = item.fPath;
      } else if (params.rel === "a") {
        text = item.aPath;
      } else if (params.rel === "r") {
        editor = lumine.workspace.getActiveTextEditor();
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor) return false;
        let editorPath = editor.getPath();
        text = editorPath ? path.relative(path.dirname(editorPath), item.aPath) : item.fPath;
      } else if (params.rel === "n") {
        text = path.basename(item.fPath);
      }
      if (this.separator === 1) {
        text = text.replace(/\\/g, "/");
      } else if (this.separator === 2) {
        text = text.replace(/\//g, "\\");
      }
      if (params.op === "insert") {
        if (!editor) editor = lumine.workspace.getActiveTextEditor();
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor) return false;
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        lumine.clipboard.write(text);
      }
      return true;
    } else if (mode === "clip") {
      if (!this.nativeClipService) {
        lumine.notifications.addWarning("System clipboard service not available", {
          detail: "The native-clip package is required for Cut/Copy file operations",
        });
        return false;
      }
      aPath = item.aPath;
      // The service confirms with its own notification.
      if (params.effect === "cut") {
        return this.nativeClipService.cutPaths([aPath]);
      } else if (params.effect === "copy") {
        return this.nativeClipService.copyPaths([aPath]);
      }
    } else if (mode === "reveal-in-tree-view") {
      if (!this.treeViewService) {
        lumine.notifications.addWarning("tree-view service not available", {
          detail: "The tree-view package is required for reveal in tree view",
        });
        return false;
      }
      return this.treeViewService.revealPath(item.aPath, { show: true });
    }
  },

  provideFuzzyFilesScoreModifier() {
    return {
      add: (fn) => {
        this.scoreModifiers.push(fn);
        return new Disposable(() => {
          const i = this.scoreModifiers.indexOf(fn);
          if (i !== -1) this.scoreModifiers.splice(i, 1);
        });
      },
    };
  },

  consumeOpenExternal(service) {
    this.openExternalService = service;
    return {
      dispose: () => {
        this.openExternalService = null;
      },
    };
  },

  consumeNativeClip(service) {
    this.nativeClipService = service;
    return {
      dispose: () => {
        this.nativeClipService = null;
      },
    };
  },

  consumeTreeViewSelection(service) {
    this.treeViewService = service;
    return {
      dispose: () => {
        this.treeViewService = null;
      },
    };
  },
};
