const { CompositeDisposable, Disposable, Emitter, updateRecentItemIds } = require("lumine");
const { shell } = require("electron");
const path = require("path");
const fs = require("fs");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "fuzzy-files",
      tips: [
        "You can open any file in the project by typing part of its name with {{ 'fuzzy-files:toggle' | keystroke }}",
        "You can send the file you picked in the finder straight into a split pane with {{ 'fuzzy-files:split-right' | keystroke }}",
        "You can complete a project file path while typing ./ or ../ in the editor.",
      ],
    };
  },

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
  selectListHost: null,
  disposables: null,
  indexSubscription: null,
  pathsProvider: null,
  statusBarService: null,
  indexStatusTile: null,
  indexStatusTooltip: null,
  separator: 0,
  projectCount: 0,
  recentlyUsed: [],
  recentCount: 0,

  activate(context) {
    this.workspaceState = context.workspaceState;
    this.activationGeneration = (this.activationGeneration ?? 0) + 1;
    this.finders = new Map();
    this.recentEvents = new Emitter();
    this.itemsByPath = new Map();
    this.items = [];
    this.itemsSynced = false;
    this.pathsProvider = null;
    this.projectCount = lumine.project.getPaths().length;
    this.recentCount = lumine.config.get("fuzzy-files.recentCount");
    this.recentlyUsed = normalizeRecentIds(this.workspaceState.get("recentlyUsed", [])).slice(
      0,
      this.recentCount,
    );

    this.disposables = new CompositeDisposable(
      this.workspaceState.observe("recentlyUsed", (ids) => {
        this.recentlyUsed = normalizeRecentIds(ids).slice(0, this.recentCount);
        this.recentEvents.emit("did-change", this.recentlyUsed);
      }),
      lumine.config.observe("fuzzy-files.separator", (value) => {
        this.separator = value;
      }),
      lumine.config.onDidChange("fuzzy-files.recentCount", ({ newValue }) => {
        this.recentCount = newValue;
        for (const record of this.finders.values())
          void record.model.setRecentLimit(newValue).catch(reportStorageError);
      }),
      lumine.commands.add("lumine-workspace", {
        "fuzzy-files:toggle": (event) => this.ensureFinder(event.context?.window).toggle(),
        "fuzzy-files:clear-recent": {
          description: "Forget the recently used files kept at the top of the list.",
          didDispatch: () => this.ensureFinder().getModel().clearRecentItems(),
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
      lumine.config.onDidChange("fuzzy-files.pathCompletion", () => {
        this.pathsProvider?.reloadScopes();
      }),
      lumine.workspace.onDidChangeActivePaneItem(() => {
        this.activeItemPathChanged();
      }),
      lumine.workspace.onDidChangePaneItemURI?.(({ item }) => {
        if (item) this.activeItemPathChanged();
      }) ?? new Disposable(),
    );

    this.compileIgnoredNames();
  },

  activeItemPathChanged() {
    // Relativization starts only after the finder has subscribed to the index.
    if (!this.itemsSynced) return;
    this.relativize();
    this.viewSynced = false;
    for (const record of this.finders.values())
      if (record.host.isVisible()) this.syncList({}, record.window);
  },

  ensureFinder(window = lumine.workspace.getMainWindow()) {
    const existing = this.finders.get(window);
    if (existing) return existing.host;

    const selectListOptions = {
      emptyMessage: "No matches found",
      getItemId: (item) => item.aPath,
      search: {
        getFilterText: (item) => this.displayPath(item),
        parseQuery: (query) => this.parseQuery(query),
        ignoreDiacritics: true,
        prepareOnIdle: true,
        yieldToInput: true,
        worker: true,
        algorithm: "command-t",
        scoreModifier: (score, item) => this.modifyScore(score, item),
      },
      renderItem: (item, options) => this.renderItem(item, options),
      source: {
        mode: "snapshot",
        loadingMessage: "Indexing project…",
        load: ({ signal }) => this.loadListSource(signal, window),
      },
      commands: this.listCommands(window),
      actions: this.listActions(),
      recents: {
        limit: this.recentCount,
        adapter: {
          serializesWrites: true,
          load: () => this.recentlyUsed,
          save: (ids, change) =>
            this.workspaceState.mutate("recentlyUsed", (current) =>
              updateRecentItemIds(normalizeRecentIds(current), ids, change),
            ),
          onDidChange: (callback) => this.recentEvents.on("did-change", callback),
        },
      },
    };
    const host = lumine.workspace.addSelectList(selectListOptions, {
      window,
      className: "fuzzy-files",
      crumb: "Files",
    });
    const model = host.getModel();
    const record = { window, host, model, opening: null, subscriptions: new CompositeDisposable() };
    record.subscriptions.add(
      host.onDidOpen(() => {
        const container = window.getEditorContainer();
        record.opening = {
          pane: container.getActivePane(),
          editor: container.getActiveEmbeddedTextEditor(),
        };
        lumine.commands.invalidateAvailability({ target: model.getElement() });
      }),
      host.onDidHide(() => {
        record.opening = null;
        lumine.commands.invalidateAvailability({ target: model.getElement() });
      }),
      window.onWillDestroy(() => {
        this.finders.delete(window);
        record.subscriptions.dispose();
        void host.destroy();
      }),
    );
    this.finders.set(window, record);
    if (window.isMain()) {
      this.selectListHost = host;
      this.selectList = model;
    }
    return host;
  },

  hasCapturedEditor(window, writable = false) {
    const editor = this.finders.get(window)?.opening?.editor;
    return Boolean(editor && !editor.isDestroyed() && (!writable || !editor.isReadOnly()));
  },

  listCommands(window = lumine.workspace.getMainWindow()) {
    return {
      "fuzzy-files:open": {
        description: "Open the file, at the line given after a colon in the query.",
        didDispatch: (event) => this.performAction("open", {}, { ...event.detail, window }),
      },
      "fuzzy-files:choose-opener": {
        description: "Choose how and where to open the selected file.",
        didDispatch: (event) =>
          this.performAction("choose-opener", {}, { ...event.detail, window }),
      },
      "fuzzy-files:open-external": {
        description: "Open the file in the default external program.",
        didDispatch: (event) =>
          this.performAction("open-external", {}, { ...event.detail, window }),
      },
      "fuzzy-files:show-in-folder": {
        description: "Show the file in the system file manager.",
        didDispatch: (event) =>
          this.performAction("show-in-folder", {}, { ...event.detail, window }),
      },
      "fuzzy-files:trash": {
        description: "Move the file to the system trash, where it can be restored.",
        didDispatch: (event) => this.performAction("trash", {}, { ...event.detail, window }),
      },
      "fuzzy-files:split-left": {
        description: "Open the file in a pane to the left.",
        didDispatch: (event) =>
          this.performAction("split", { side: "left" }, { ...event.detail, window }),
      },
      "fuzzy-files:split-right": {
        description: "Open the file in a pane to the right.",
        didDispatch: (event) =>
          this.performAction("split", { side: "right" }, { ...event.detail, window }),
      },
      "fuzzy-files:split-up": {
        description: "Open the file in a pane above.",
        didDispatch: (event) =>
          this.performAction("split", { side: "up" }, { ...event.detail, window }),
      },
      "fuzzy-files:split-down": {
        description: "Open the file in a pane below.",
        didDispatch: (event) =>
          this.performAction("split", { side: "down" }, { ...event.detail, window }),
      },
      "fuzzy-files:insert-project-path": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the path relative to the project root.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "p" }, { ...event.detail, window }),
      },
      "fuzzy-files:insert-absolute-path": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the full path from the filesystem root into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "a" }, { ...event.detail, window }),
      },
      "fuzzy-files:insert-relative-path": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "r" }, { ...event.detail, window }),
      },
      "fuzzy-files:insert-file-name": {
        isAvailable: () => this.hasCapturedEditor(window, true),
        description: "Insert the base name, without its directories, into the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "insert", rel: "n" }, { ...event.detail, window }),
      },
      "fuzzy-files:copy-project-path": {
        description: "Copy the path relative to the project root.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "p" }, { ...event.detail, window }),
      },
      "fuzzy-files:copy-absolute-path": {
        description: "Copy the full path from the filesystem root to the clipboard.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "a" }, { ...event.detail, window }),
      },
      "fuzzy-files:copy-relative-path": {
        isAvailable: () => this.hasCapturedEditor(window),
        description: "Copy the path relative to the active editor.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "r" }, { ...event.detail, window }),
      },
      "fuzzy-files:copy-file-name": {
        description: "Copy the base name, without its directories, to the clipboard.",
        didDispatch: (event) =>
          this.performAction("path", { op: "copy", rel: "n" }, { ...event.detail, window }),
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
        didDispatch: (event) =>
          this.performAction("clip", { effect: "cut" }, { ...event.detail, window }),
      },
      "fuzzy-files:copy-file": {
        description: "Copy the file to the system clipboard.",
        didDispatch: (event) =>
          this.performAction("clip", { effect: "copy" }, { ...event.detail, window }),
      },
      "fuzzy-files:query-selected-path": {
        description: "Continue the query from the selected path.",
        didDispatch: (event) => this.updateQueryFromItem(event.detail.item, window),
      },
      "fuzzy-files:query-selection": {
        description: "Use the editor selection as the query.",
        didDispatch: () => this.ensureFinder(window).getModel().setQueryFromSelection(),
      },
      "fuzzy-files:reveal-in-tree-view": {
        description: "Expand the tree view to the file and select it there.",
        didDispatch: (event) =>
          this.performAction("reveal-in-tree-view", {}, { ...event.detail, window }),
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
      itemAction("fuzzy-files:choose-opener", "Open", {
        disposition: "push",
        recordsRecent: false,
      }),
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

  async deactivate() {
    this.indexSubscription?.dispose();
    this.indexSubscription = null;
    this.disposables?.dispose();
    this.disposables = null;
    const records = [...(this.finders?.values() ?? [])];
    this.finders?.clear();
    for (const record of records) record.subscriptions.dispose();
    this.recentEvents?.dispose();
    this.selectListHost = null;
    this.selectList = null;
    this.pathsProvider = null;
    this.hideIndexStatus();
    this.statusBarService = null;
    this.itemsByPath.clear();
    this.items = [];
    this.itemsSynced = false;
    this.viewSynced = false;
    await Promise.all(records.map((record) => record.host.destroy()));
  },

  // Subscribing is what builds the project's file index, so it waits until the
  // finder is opened or a completion request matches a path. Both surfaces
  // share this subscription and the filtered map, independently of their UI.
  observeIndex() {
    if (this.indexSubscription) return;
    this.indexSubscription = lumine.project.observeFilePaths(({ added, removed, indexing }) => {
      for (const aPath of removed) this.itemsByPath.delete(aPath);
      for (const aPath of added) this.addItem(aPath);
      this.itemsSynced = false;
      this.viewSynced = false;
      if (indexing) this.showIndexStatus();
      else this.hideIndexStatus();
      for (const record of this.finders.values())
        if (record.host.isVisible()) this.syncList({ indexing }, record.window);
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

  async loadListSource(signal, window) {
    this.observeIndex();
    await this.whenIndexed(signal);
    return this.listSnapshot(window);
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
      depthPath: normalizedPath,
      depthDivisor: Math.sqrt(pathDepth(normalizedPath)),
    });
  },

  // Only needed when this package's own exclusions change: the index is
  // unaffected by them, so there is nothing to re-crawl.
  rebuildItems() {
    this.itemsByPath.clear();
    for (const aPath of lumine.project.getFilePaths()) this.addItem(aPath);
    this.itemsSynced = false;
    this.viewSynced = false;
    for (const record of this.finders.values())
      if (record.host.isVisible()) this.syncList({}, record.window);
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

  relativize(editor, items = this.items) {
    if (!editor) editor = lumine.workspace.getActiveTextEditor();
    let editorPath = editor ? editor.getPath() : undefined;
    if (!editor || !editorPath) {
      for (let item of items) {
        item.rPath = item.fPath;
        item.distance = 1;
      }
    } else {
      const directory = path.dirname(editorPath);
      for (let item of items) {
        item.rPath = path.relative(directory, item.aPath);
        item.distance = pathDepth(item.rPath);
      }
    }
  },

  renderItem(item, { highlight }) {
    return {
      primary: highlight(this.displayPath(item)),
      didRender: (li) => {
        return lumine.icons.applyTo(
          li.firstChild,
          { path: item.aPath, context: "fuzzy-files", hints: { directory: false } },
          { name: path.basename(item.aPath) },
        );
      },
    };
  },

  displayPath(item) {
    if (this.projectCount > 1) {
      return path.join(path.basename(item.pPath), item.fPath);
    }
    return item.fPath;
  },

  syncList(
    { indexing = lumine.project.isIndexing(), ...props } = {},
    window = lumine.workspace.getMainWindow(),
  ) {
    const selectList = this.ensureFinder(window).getModel();
    this.viewSynced = true;
    const snapshot = this.listSnapshot(window);
    if (indexing) selectList.setLoadingState({ message: "Indexing project…" });
    else selectList.clearLoadingState();
    return selectList.update({
      items: snapshot.items,
      infoMessage: indexing ? null : this.infoLine(),
      ...props,
    });
  },

  listSnapshot(window) {
    this.viewSynced = true;
    this.materialize();
    const items = window ? this.items.map((item) => ({ ...item })) : this.items;
    this.relativize(window?.getEditorContainer().getActiveEmbeddedTextEditor(), items);
    return { items, infoMessage: this.infoLine() };
  },

  parseQuery(query) {
    const colon = query.indexOf(":");
    if (colon !== -1) {
      const initialLineRaw = query.substring(colon + 1);
      const initialLine = initialLineRaw.match(/^\d+$/)
        ? Math.max(0, parseInt(initialLineRaw) - 1)
        : undefined;
      return {
        text: query.slice(0, colon),
        data: initialLine === undefined ? {} : { initialLine },
      };
    }
    return { text: query, data: {} };
  },

  modifyScore(score, item) {
    const depthDivisor =
      item.depthPath === item.fPath ? item.depthDivisor : Math.sqrt(pathDepth(item.fPath));
    let modifiedScore = score / (item.distance * depthDivisor);
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
    this.observeIndex();
    const refresh = lumine.project.refreshFilePaths();
    this.viewSynced = false;
    for (const record of this.finders.values())
      if (record.host.isVisible()) void record.model.reload();
    return refresh;
  },

  updateQueryFromItem(item, window) {
    const selectList = this.ensureFinder(window).getModel();
    item ||= selectList.getSelectedItem();
    if (!item) return false;
    const text = this.displayPath(item) + path.sep;
    selectList.setQuery(text);
    selectList.getQueryEditor().moveToEndOfLine();
    return true;
  },

  async performAction(mode, params = {}, context = {}) {
    const window = context.window ?? lumine.workspace.getMainWindow();
    const selectList = this.ensureFinder(window).getModel();
    const target = this.finders.get(window).opening ?? {
      pane: window.getEditorContainer().getActivePane(),
      editor: window.getEditorContainer().getActiveEmbeddedTextEditor(),
    };
    context.signal?.throwIfAborted();
    const item = context.item ?? selectList.getSelectedItem();
    if (!item) return;

    let editor, aPath, text;

    if (mode === "choose-opener") {
      const opening = lumine.commands.dispatch(window.getElement(), "launcher:open", {
        path: item.aPath,
        pane: target.pane,
        ...context.parsedQuery?.data,
      });
      if (!opening) throw new Error("The Launcher package is not available.");
      return opening;
    }

    if (mode === "open") {
      aPath = item.aPath;
      try {
        if (!fs.statSync(aPath).isFile()) {
          this.updateQueryFromItem(item, window);
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
        ...context.parsedQuery?.data,
        pane: target.pane,
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
        if (fs.statSync(aPath).isFile()) {
          return lumine.workspace.open(aPath, {
            ...context.parsedQuery?.data,
            pane: target.pane,
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
        editor = target.editor;
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor || editor.isDestroyed()) return false;
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
        if (!editor) editor = target.editor;
        // No editor behind the picker is already on screen, and nothing failed.
        if (!editor || editor.isDestroyed()) return false;
        if (editor.isReadOnly()) return false;
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        lumine.clipboard.write(text);
      }
      return true;
    } else if (mode === "clip") {
      if (!this.nativeClipService) {
        await lumine.packages.requestService("native-clip", "^1.0.0");
      }
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

  provideAutocomplete() {
    // No disposable on the provider: autocomplete can disappear while the
    // finder still uses the package-owned model and its index subscription.
    if (!this.pathsProvider) {
      const PathsProvider = require("./lazy-paths-provider");
      this.pathsProvider = new PathsProvider(this);
    }
    return this.pathsProvider;
  },

  consumeStatusBar(service) {
    return service.observeWindows((scopedStatusBar, context) =>
      this.consumeWindowStatusBar(scopedStatusBar, context),
    );
  },

  consumeWindowStatusBar(service, _context) {
    this.statusBarService = service;
    if (this.indexSubscription && lumine.project.isIndexing()) this.showIndexStatus();
    return new Disposable(() => {
      if (this.statusBarService !== service) return;
      this.hideIndexStatus();
      this.statusBarService = null;
    });
  },

  showIndexStatus() {
    if (!this.statusBarService || this.indexStatusTile) return;
    const element = document.createElement("status-bar-tile");
    element.className = "fuzzy-files-index-status is-read-only";
    element.textContent = "Indexing project files…";
    this.indexStatusTooltip = lumine.tooltips.add(element, {
      title: "Indexing project files for the finder and path suggestions",
    });
    this.indexStatusTile = this.statusBarService.addRightTile({ item: element, priority: 100 });
  },

  hideIndexStatus() {
    this.indexStatusTooltip?.dispose();
    this.indexStatusTooltip = null;
    this.indexStatusTile?.destroy();
    this.indexStatusTile = null;
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

function pathDepth(value) {
  let depth = 1;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 47 || c === 92) depth++;
  }
  return depth;
}

function normalizeRecentIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))];
}

function reportStorageError(error) {
  lumine.notifications.addError("Unable to save recent items", {
    detail: error.message,
    dismissable: true,
  });
}
