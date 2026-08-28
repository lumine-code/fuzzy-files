# fuzzy-files

Quickly find and take an action over project files.

## Features

- **Fast fuzzy search**: ranks results by match quality, adjusted by distance from the active file and directory depth.
- **Line navigation**: jumps to a specific line using `:` syntax such as `file.js:42`.
- **Recent files**: recently used files stay on top while the query is empty.
- **Multiple projects**: searches across every open project path.
- **Real-time updates**: reads the editor's shared project file index, so the list follows the filesystem as files come and go.
- **Path actions**: copies, inserts, or reveals file paths in several formats.
- **Service integration**: alt-click opens a file externally when `open-external` is available; other optional services reveal it in the tree view and copy it to the clipboard.

## Installation

To install `fuzzy-files` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/fuzzy-files`.

## Commands

Commands available in `lumine-workspace`:

- `fuzzy-files:toggle`: toggle the fuzzy files panel,
- `fuzzy-files:refresh`: refresh the file cache,
- `fuzzy-files:clear-recent`: forget the recently used files.

Commands available in `.fuzzy-files`:

- `fuzzy-files:open`: open the selected file,
- `fuzzy-files:open-external`: open the file in the default external program,
- `fuzzy-files:show-in-folder`: show the file in the system file manager,
- `fuzzy-files:trash`: move the file to the trash,
- `fuzzy-files:split-left/right/up/down`: open the file in a split pane,
- `fuzzy-files:refresh-index`: rebuild the file index,
- `fuzzy-files:copy-relative-path`: copy the path relative to the active editor,
- `fuzzy-files:copy-project-path`: copy the path relative to the project root,
- `fuzzy-files:copy-absolute-path`: copy the absolute path,
- `fuzzy-files:copy-file-name`: copy the file name,
- `fuzzy-files:insert-relative-path`: insert the path relative to the active editor,
- `fuzzy-files:insert-project-path`: insert the path relative to the project root,
- `fuzzy-files:insert-absolute-path`: insert the absolute path,
- `fuzzy-files:insert-file-name`: insert the file name,
- `fuzzy-files:use-default-separator`: use the platform path separator,
- `fuzzy-files:use-forward-slashes`: use forward slashes in inserted and copied paths,
- `fuzzy-files:use-backslashes`: use backslashes in inserted and copied paths,
- `fuzzy-files:query-selected-path`: continue the query from the selected path,
- `fuzzy-files:query-selection`: use the editor selection as the query,
- `fuzzy-files:reveal-in-tree-view`: reveal the file in the tree view,
- `fuzzy-files:cut-file`: cut the file to the system clipboard,
- `fuzzy-files:copy-file`: copy the file to the system clipboard,
- `fuzzy-files:remove-from-recent`: drop the selected file from the recent section, offered only while a recent one is selected.

## Services

- [`fuzzy-files.score-modifier`](docs/fuzzy-files.score-modifier.md): provided to let other packages register functions that boost or penalize the score of search results.
- `open-external`: consumed to open files with the configured external application.
- `native-clip`: consumed to cut and copy files to the system clipboard.
- `tree-view.selection`: consumed to reveal the selected file in the tree view.

## Customization

Resize the results panel by adding CSS to your `styles.css`:

```css
.fuzzy-files {
  font-size: 14px;
  .list-group {
    max-height: 20em;
  }
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
