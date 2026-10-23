const { CompositeDisposable, Disposable, Emitter, updateRecentItemIds } = require("lumine");
const { shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathDepth, referenceDirectory } = require("./path-proximity");
const FileIndex = require("./file-index");

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
  // scan of every item. Materialized into `items` only when a list needs it.
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
    this.fileIndex = null;
    this.sourceRevision = 0;
    this.indexUpdate = null;
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
        "fuzzy-files:toggle": (event) => {
          const context = event.context ?? lumine.workspace.resolveCommandContext(event);
          const window = context.window ?? lumine.workspace.getMainWindow();
          const host = this.ensureFinder(window);
          if (!host.isVisible())
            this.finders.get(window).pendingOpening = this.captureOpening(window, context);
          return host.toggle();
        },
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
        if (this.indexSubscription) this.rebuildItems();
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
    for (const record of this.finders.values()) {
      const directory = referenceDirectory(this.referenceItem(record.window)?.getPath?.());
      // Keep the invoking item as the reference even if another pane activates.
      // A rename of that item can still change its directory during the session.
      if (directory === referenceDirectory(record.snapshot?.referencePath)) continue;
      if (record.host.isVisible() && !record.model.isLoading())
        void this.syncList({}, record.window).catch((error) =>
          record.model.setStatus({ type: "error", message: error.message }),
        );
    }
  },

  captureOpening(window, context) {
    const container = window.getEditorContainer();
    return {
      pane:
        context?.documentPane?.getContainer?.() === container
          ? context.documentPane
          : container.getActivePane(),
      item:
        context && Object.prototype.hasOwnProperty.call(context, "item")
          ? context.item
          : container.getActivePaneItem(),
      editor:
        context && Object.prototype.hasOwnProperty.call(context, "embeddedEditor")
          ? context.embeddedEditor
          : container.getActiveEmbeddedTextEditor(),
    };
  },

  referenceItem(window) {
    const record = this.finders.get(window);
    const opening = record?.pendingOpening ?? record?.opening;
    if (opening) return opening.item;
    return window
      ? window.getEditorContainer().getActivePaneItem()
      : lumine.workspace.getActivePaneItem();
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
    const record = {
      window,
      host,
      model,
      opening: null,
      pendingOpening: null,
      snapshot: null,
      subscriptions: new CompositeDisposable(),
    };
    record.subscriptions.add(
      host.onDidOpen(() => {
        record.opening = record.pendingOpening ?? this.captureOpening(window);
        record.pendingOpening = null;
        lumine.commands.invalidateAvailability({ target: model.getElement() });
      }),
      host.onDidHide(() => {
        record.refresh?.abort();
        record.opening = null;
        record.pendingOpening = null;
        lumine.commands.invalidateAvailability({ target: model.getElement() });
      }),
      window.onWillDestroy(() => {
        record.refresh?.abort();
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
    const closingIndex = this.fileIndex?.close();
    this.fileIndex = null;
    this.sourceRevision++;
    this.disposables?.dispose();
    this.disposables = null;
    const records = [...(this.finders?.values() ?? [])];
    this.finders?.clear();
    for (const record of records) {
      record.refresh?.abort();
      record.subscriptions.dispose();
    }
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
    await Promise.all([closingIndex, ...records.map((record) => record.host.destroy())]);
  },

  // Subscribing is what builds the project's file index, so it waits until the
  // finder is opened or a completion request matches a path. Both surfaces
  // share this subscription and the filtered map, independently of their UI.
  ensureFileIndex() {
    if (!this.disposables)
      throw Object.assign(new Error("File finder is inactive"), { name: "AbortError" });
    if (this.fileIndex) return this.fileIndex;
    const roots = lumine.project.getDirectories().map((directory) => ({
      path: directory.getPath(),
      paths: [
        ...new Set([directory.getPath(), directory.getRealPathSync?.() ?? directory.getPath()]),
      ],
    }));
    const { rules, caseInsensitive } = this.ignoredNamesMatcher;
    this.fileIndex = new FileIndex({ roots, rules, caseInsensitive });
    this.itemsByPath = this.fileIndex.items;
    return this.fileIndex;
  },

  observeIndex() {
    if (this.indexSubscription) return;
    this.ensureFileIndex();
    this.indexSubscription = lumine.project.observeFilePaths(({ added, removed, indexing }) => {
      this.queueIndexChanges(added, removed);
      if (indexing) this.showIndexStatus();
      else this.hideIndexStatus();
    });
  },

  queueIndexChanges(added, removed) {
    const index = this.ensureFileIndex();
    const revision = ++this.sourceRevision;
    const work = index.apply(added, removed).then(async (changed) => {
      if (this.fileIndex !== index || revision !== this.sourceRevision) return;
      if (changed) this.itemsSynced = false;
      this.viewSynced = false;
      await Promise.all(
        [...this.finders.values()]
          .filter((record) => record.host.isVisible() && !record.model.isLoading())
          .map((record) => this.syncList({}, record.window)),
      );
    });
    this.indexUpdate = work;
    void work.catch((error) => {
      if (this.fileIndex === index) {
        for (const record of this.finders.values())
          if (record.host.isVisible())
            void record.model.setStatus({ type: "error", message: error.message });
      }
    });
    return work;
  },

  async whenPrepared() {
    let pending;
    do {
      pending = this.indexUpdate;
      try {
        await pending;
      } catch (error) {
        if (pending === this.indexUpdate) throw error;
      }
    } while (pending !== this.indexUpdate);
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
    for (;;) {
      signal?.throwIfAborted();
      const revision = this.sourceRevision;
      const reference = referenceDirectory(this.referenceItem(window)?.getPath?.());
      const snapshot = await this.listSnapshot(window, signal);
      await this.whenPrepared();
      if (
        revision === this.sourceRevision &&
        reference === referenceDirectory(this.referenceItem(window)?.getPath?.())
      )
        return snapshot;
    }
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

  rebuildItems() {
    const previous = this.fileIndex;
    this.fileIndex = null;
    for (const record of this.finders.values()) record.snapshot = null;
    this.itemsSynced = false;
    const work = this.queueIndexChanges(lumine.project.getFilePaths(), []);
    void previous?.close();
    return work;
  },

  async materialize() {
    const snapshot = await this.listSnapshot();
    this.items = snapshot.items;
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

  async syncList(
    { indexing = lumine.project.isIndexing(), ...props } = {},
    window = lumine.workspace.getMainWindow(),
  ) {
    const record = this.finders.get(window);
    if (!record) return;
    record.refresh?.abort();
    const controller = (record.refresh = new AbortController());
    try {
      const snapshot = await this.listSnapshot(window, controller.signal);
      controller.signal.throwIfAborted();
      if (indexing) record.model.setLoadingState({ message: "Indexing project…" });
      else record.model.clearLoadingState();
      return await record.model.update({
        items: snapshot.items,
        infoMessage: indexing ? null : this.infoLine(),
        ...props,
      });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    } finally {
      if (record.refresh === controller) record.refresh = null;
    }
  },

  async listSnapshot(window, signal) {
    signal?.throwIfAborted();
    const index = this.ensureFileIndex();
    const record = this.finders.get(window);
    const referencePath = this.referenceItem(window)?.getPath?.();
    let snapshot;
    try {
      snapshot = await index.snapshot(referencePath, record?.snapshot, signal);
    } catch (error) {
      if (this.fileIndex && this.fileIndex !== index) return this.listSnapshot(window, signal);
      throw error;
    }
    if (this.fileIndex !== index) return this.listSnapshot(window, signal);
    if (record) await record.model.prepareItems(snapshot.items, { signal });
    signal?.throwIfAborted();
    if (this.fileIndex !== index) return this.listSnapshot(window, signal);
    if (record) record.snapshot = snapshot;
    else this.items = snapshot.items;
    this.itemsSynced = true;
    this.viewSynced = true;
    return { items: snapshot.items, infoMessage: this.infoLine() };
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
    if (this.fileIndex?.closed) this.rebuildItems();
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
        void this.refreshScoreModifiers();
        return new Disposable(() => {
          const i = this.scoreModifiers.indexOf(fn);
          if (i !== -1) {
            this.scoreModifiers.splice(i, 1);
            void this.refreshScoreModifiers();
          }
        });
      },
      invalidate: (fn) =>
        this.scoreModifiers.includes(fn) ? this.refreshScoreModifiers() : Promise.resolve(),
    };
  },

  refreshScoreModifiers() {
    const work = Promise.all(
      [...(this.finders?.values() ?? [])].map(async ({ model }) => model.refreshScores()),
    );
    // Each list owns filtering-error presentation. Registration/disposal cannot
    // await, while explicit invalidation still returns the rejecting promise.
    void work.catch(() => {});
    return work;
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

function normalizeRecentIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))];
}

function reportStorageError(error) {
  lumine.notifications.addError("Unable to save recent items", {
    detail: error.message,
    dismissable: true,
  });
}
