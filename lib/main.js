const { CompositeDisposable, Disposable } = require("lumine");
const { shell } = require("electron");
const picomatch = require("picomatch");
const path = require("path");
const fs = require("fs");

module.exports = {
  openExternalService: null,
  windowsClipService: null,
  treeViewService: null,
  scoreModifiers: [],
  ignores: [],
  Ignores: [],
  // Keyed on `aPath`, so a path leaving the index costs a lookup rather than a
  // scan of every item. Materialized into `items` in `update()`, which already
  // walks all of them to relativize.
  itemsByPath: new Map(),
  items: [],
  itemsSynced: false,
  viewSynced: false,
  selectList: null,
  disposables: null,
  indexSubscription: null,
  separator: 0,
  initialLine: 0,
  projectCount: 0,
  recentlyUsed: [],
  recentCount: 0,

  activate(state) {
    this.itemsByPath = new Map();
    this.items = [];
    this.itemsSynced = false;
    this.projectCount = lumine.project.getPaths().length;
    this.recentlyUsed = [
      ...new Set(
        (Array.isArray(state?.recentlyUsed) ? state.recentlyUsed : []).filter(
          (aPath) => typeof aPath === "string",
        ),
      ),
    ];
    this.recentCount = lumine.config.get("fuzzy-files.recentCount");
    this.trimRecent();

    this.selectList = lumine.workspace.buildSelectList({
      className: "fuzzy-files",
      crumb: "Files",
      emptyMessage: "No matches found",
      idForItem: (item) => item.aPath,
      removeDiacritics: true,
      algorithm: "command-t",
      elementForItem: (item, options) => this.elementForItem(item, options),
      didConfirmSelection: () => this.performAction("open"),
      didCancelSelection: () => this.selectList.hide(),
      willShow: () => this.update(),
      filterKeyForItem: (item) => this.displayPath(item),
      filterQuery: (query) => this.parseQuery(query),
      filterScoreModifier: (score, item) => {
        const depth = (item.fPath.match(/[\\/]/g) || []).length + 1;
        score = score / (item.distance * Math.sqrt(depth));
        for (const fn of this.scoreModifiers) {
          score = fn(score, item);
        }
        return score;
      },
    });

    this.disposables = new CompositeDisposable(
      lumine.config.observe("fuzzy-files.separator", (value) => {
        this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-files.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        if (!this.trimRecent()) return;
        this.viewSynced = false;
        if (this.selectList.isVisible()) this.syncList();
      }),
      lumine.commands.add("lumine-workspace", {
        "fuzzy-files:toggle": () => this.selectList.toggle(),
        "fuzzy-files:refresh": {
          description: "Crawl the project again to pick up changes made outside the editor.",
          didDispatch: () => this.refresh(),
        },
        "fuzzy-files:clear-recent": {
          description: "Forget the recently opened files kept at the top of the list.",
          didDispatch: () => this.clearRecent(),
        },
      }),
      // Registered in the package's own namespace: the item-actions list
      // (F12) derives its rows — label, description, keybinding — from these
      // registrations and the keymap, so nothing is documented twice. Every
      // description says something the humanized command name does not.
      lumine.commands.add(this.selectList.element, {
        "fuzzy-files:open": {
          description: "Open the file, at the line given after a colon in the query.",
          didDispatch: () => this.performAction("open"),
        },
        "fuzzy-files:open-external": {
          description: "Open the file in the default external program.",
          didDispatch: () => this.performAction("open-external"),
        },
        "fuzzy-files:show-in-folder": {
          description: "Show the file in the system file manager.",
          didDispatch: () => this.performAction("show-in-folder"),
        },
        "fuzzy-files:trash": {
          description: "Move the file to the system trash, where it can be restored.",
          didDispatch: () => this.performAction("trash"),
        },
        "fuzzy-files:split-left": {
          description: "Open the file in a pane to the left.",
          didDispatch: () => this.performAction("split", { side: "left" }),
        },
        "fuzzy-files:split-right": {
          description: "Open the file in a pane to the right.",
          didDispatch: () => this.performAction("split", { side: "right" }),
        },
        "fuzzy-files:split-up": {
          description: "Open the file in a pane above.",
          didDispatch: () => this.performAction("split", { side: "up" }),
        },
        "fuzzy-files:split-down": {
          description: "Open the file in a pane below.",
          didDispatch: () => this.performAction("split", { side: "down" }),
        },
        "fuzzy-files:insert-project-path": {
          description: "Insert the path relative to the project root.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "p" }),
        },
        "fuzzy-files:insert-absolute-path": {
          description: "Insert the full path from the filesystem root into the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "a" }),
        },
        "fuzzy-files:insert-relative-path": {
          description: "Insert the path relative to the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "r" }),
        },
        "fuzzy-files:insert-file-name": {
          description: "Insert the base name, without its directories, into the active editor.",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "n" }),
        },
        "fuzzy-files:copy-project-path": {
          description: "Copy the path relative to the project root.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "p" }),
        },
        "fuzzy-files:copy-absolute-path": {
          description: "Copy the full path from the filesystem root to the clipboard.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "a" }),
        },
        "fuzzy-files:copy-relative-path": {
          description: "Copy the path relative to the active editor.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "r" }),
        },
        "fuzzy-files:copy-file-name": {
          description: "Copy the base name, without its directories, to the clipboard.",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "n" }),
        },
        "fuzzy-files:refresh-index": {
          description: "Crawl the project again to pick up changes made outside the editor.",
          actionScope: "list",
          didDispatch: () => this.refresh(),
        },
        "fuzzy-files:use-default-separator": {
          description: "Use the platform path separator.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-files.separator", 0);
            lumine.notifications.addHint("Separator has been changed to default");
          },
        },
        "fuzzy-files:use-forward-slashes": {
          description: "Use forward slashes in inserted and copied paths.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-files.separator", 1);
            lumine.notifications.addHint("Separator has been changed to forward slash");
          },
        },
        "fuzzy-files:use-backslashes": {
          description: "Use backslashes in inserted and copied paths.",
          actionScope: "list",
          didDispatch: () => {
            lumine.config.set("fuzzy-files.separator", 2);
            lumine.notifications.addHint("Separator has been changed to backslash");
          },
        },
        "fuzzy-files:cut-file": {
          description: "Cut the file to the system clipboard.",
          didDispatch: () => this.performAction("clip", { effect: "cut" }),
        },
        "fuzzy-files:copy-file": {
          description: "Copy the file to the system clipboard.",
          didDispatch: () => this.performAction("clip", { effect: "copy" }),
        },
        "fuzzy-files:query-selected-path": {
          description: "Continue the query from the selected path.",
          didDispatch: () => this.updateQueryFromItem(),
        },
        "fuzzy-files:query-selection": {
          description: "Use the editor selection as the query.",
          actionScope: "list",
          didDispatch: () => this.selectList.setQueryFromSelection(),
        },
        "fuzzy-files:reveal-in-tree-view": {
          description: "Expand the tree view to the file and select it there.",
          didDispatch: () => this.performAction("reveal-in-tree-view"),
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
        this.parseIgnores();
        this.rebuildItems();
      }),
      lumine.workspace.onDidChangeActivePaneItem(() => {
        // Only once there is something to relativize: before the finder has
        // ever been opened this package holds no items and wants no index.
        if (this.itemsSynced) this.relativize();
      }),
    );

    this.parseIgnores();
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
  whenIndexed() {
    this.observeIndex();
    if (!lumine.project.isIndexing()) return Promise.resolve();
    return new Promise((resolve) => {
      const subscription = lumine.project.observeFilePaths(({ indexing }) => {
        if (indexing) return;
        subscription.dispose();
        resolve();
      });
    });
  },

  parseIgnores() {
    this.ignores = [];
    this.Ignores = [];
    // `core.ignoredNames` is the index's own policy and is already applied to
    // everything it reports. Re-applying it here would not just be wasted work:
    // these matchers are not the gitignore semantics ripgrep uses, so a second
    // pass can hide a path the setting does not actually name.
    for (let ignore of lumine.config.get("fuzzy-files.ignoredNames")) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
    for (let ignore of this.ignores) {
      // `basename` only for a pattern with no slash, matching minimatch's
      // `matchBase`. Unconditionally it would defeat the `**/<name>/**` forms
      // pushed above, since only the basename would ever be compared.
      this.Ignores.push(picomatch(ignore, { basename: !ignore.includes("/"), dot: true }));
    }
  },

  // The index reports absolute paths; everything the list renders is derived
  // from them here. A path this package excludes never becomes an item at all.
  addItem(aPath) {
    const [pPath, fPath] = lumine.project.relativizePath(aPath);
    if (!pPath || !fPath) return;

    const normalizedPath = path.normalize(fPath);
    if (this.isIgnored(normalizedPath)) return;

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

  isIgnored(fPath) {
    for (let isMatch of this.Ignores) {
      if (isMatch(fPath)) return true;
    }
    return false;
  },

  elementForItem(item, { highlight }) {
    return {
      primary: highlight(this.displayPath(item)),
      didRender: (li) =>
        lumine.icons.applyTo(
          li.firstChild,
          { path: item.aPath, context: "fuzzy-files", hints: { directory: false } },
          { name: path.basename(item.aPath) },
        ),
    };
  },

  displayPath(item) {
    if (this.projectCount > 1) {
      return path.join(path.basename(item.pPath), item.fPath);
    }
    return item.fPath;
  },

  trimRecent() {
    const oldLength = this.recentlyUsed.length;
    while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
    return this.recentlyUsed.length !== oldLength;
  },

  recordRecent(item) {
    const index = this.recentlyUsed.indexOf(item.aPath);
    if (index !== -1) this.recentlyUsed.splice(index, 1);
    this.recentlyUsed.unshift(item.aPath);
    this.trimRecent();
    this.viewSynced = false;
  },

  clearRecent() {
    if (this.recentlyUsed.length === 0) return;
    this.recentlyUsed.length = 0;
    this.viewSynced = false;
    if (this.selectList.isVisible()) this.syncList();
  },

  listProps(items = this.items, props = {}) {
    return {
      items,
      recentIds: this.recentlyUsed,
      ...props,
    };
  },

  syncList({ indexing = lumine.project.isIndexing(), ...props } = {}) {
    this.viewSynced = true;
    this.materialize();
    this.relativize();
    return this.selectList.update(
      this.listProps(this.items, {
        loadingMessage: indexing ? "Indexing project…" : null,
        infoMessage: indexing ? null : this.infoLine(),
        ...props,
      }),
    );
  },

  parseQuery(query) {
    if (query.length === 0) {
      this.initialLine = 0;
      return query;
    }
    let colon = query.indexOf(":");
    if (colon !== -1) {
      let initialLineRaw = query.substring(colon + 1);
      this.initialLine = initialLineRaw.match(/^\d+$/) ? parseInt(initialLineRaw) - 1 : 0;
      return query.slice(0, colon);
    }
    this.initialLine = 0;
    return query;
  },

  // The command table moved to the actions list (F12); the index size is the
  // one thing only this line can say. It counts what the finder lists, which is
  // the shared index minus this package's own exclusions.
  infoLine() {
    return `${this.itemsByPath.size} files in ${this.projectCount} project${
      this.projectCount !== 1 ? "s" : ""
    }`;
  },

  update() {
    // The first open is what builds the project's index; until then this
    // package has cost nothing.
    this.observeIndex();
    if (!this.viewSynced) {
      this.syncList();
    } else {
      this.relativize();
    }
  },

  refresh() {
    // The index is shared, so this re-crawls for every consumer of it, not just
    // the finder \u2014 which is right, since the index is the thing that is stale.
    lumine.project.refreshFilePaths();
    this.viewSynced = false;
    this.syncList();
  },

  updateQueryFromItem() {
    let text = this.displayPath(this.selectList.getSelectedItem()) + path.sep;
    this.selectList.refs.queryEditor.setText(text);
    this.selectList.refs.queryEditor.moveToEndOfLine();
  },

  performAction(mode, params) {
    let item = this.selectList.getSelectedItem();
    if (!item) return;

    let editor, aPath, text;

    if (mode === "open") {
      aPath = item.aPath;
      try {
        if (!fs.lstatSync(aPath).isFile()) {
          return this.updateQueryFromItem();
        }
      } catch (error) {
        lumine.notifications.addError(error.message || String(error), {
          detail: aPath,
        });
      }
    }

    this.selectList.hide();

    if (mode === "open") {
      this.recordRecent(item);
      lumine.workspace.open(item.aPath, {
        initialLine: this.initialLine,
        pending: lumine.config.get("core.allowPendingPaneItems"),
      });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        this.openExternalService.openExternal(item.aPath);
      } else {
        shell.openPath(item.aPath);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        this.openExternalService.showInFolder(item.aPath);
      } else {
        shell.showItemInFolder(item.aPath);
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
          this.recordRecent(item);
          lumine.workspace.open(aPath, {
            initialLine: this.initialLine,
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
        if (!editor) return;
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
        if (!editor) return;
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        lumine.clipboard.write(text);
      }
    } else if (mode === "clip") {
      if (!this.windowsClipService) {
        lumine.notifications.addWarning("Windows clipboard service not available", {
          detail: "The windows-clip package is required for Cut/Copy file operations",
        });
        return;
      }
      aPath = item.aPath;
      if (params.effect === "cut") {
        this.windowsClipService.writeFilePaths([aPath], this.windowsClipService.DROP_EFFECT_MOVE);
        lumine.notifications.addSuccess("File cut to clipboard", {
          detail: aPath,
        });
      } else if (params.effect === "copy") {
        this.windowsClipService.writeFilePaths([aPath], this.windowsClipService.DROP_EFFECT_COPY);
        lumine.notifications.addSuccess("File copied to clipboard", {
          detail: aPath,
        });
      }
    } else if (mode === "reveal-in-tree-view") {
      if (!this.treeViewService) {
        lumine.notifications.addWarning("tree-view service not available", {
          detail: "The tree-view package is required for reveal in tree view",
        });
        return;
      }
      this.treeViewService.revealPath(item.aPath, { show: true });
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

  consumeWindowsClip(service) {
    this.windowsClipService = service;
    return {
      dispose: () => {
        this.windowsClipService = null;
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
