# Background preparation and snapshot reuse

Follow-up to the [opening measurements](README.md), using the same private 500,000-file project corpus and 30,253-file explorer corpus on Windows, Electron 44.9.0 / Node 24.22.0. Two fresh editor processes each measured one first opening, three reopenings, and an add/remove pair followed by its inverse. [Individual measurements](background-opening-2026-10-21.json) include source and corpus hashes, complete result hashes, and timer gaps. The reference is the previous report's production variant, not its original unoptimized baseline. These are sequential local measurement series, not a new interleaved before/after experiment.

| Measurement                               |          Previous median | Current median |      Current range |
| ----------------------------------------- | -----------------------: | -------------: | -----------------: |
| fuzzy-files first opening, ready index    |               4,555.8 ms |     4,566.7 ms | 4,530.5–4,602.9 ms |
| fuzzy-files reopening                     |                 432.1 ms |        15.9 ms |       15.2–18.8 ms |
| Largest UI timer gap during first opening | approximately 4,555.8 ms |        32.3 ms |       32.1–32.4 ms |
| fuzzy-explorer first opening              |                  60.7 ms |        56.3 ms |       55.9–56.8 ms |
| fuzzy-explorer reopening                  |                  27.6 ms |        17.7 ms |       14.0–22.3 ms |

First preparation takes approximately the same elapsed time, but the renderer remains available to paint the loading message and handle input. Reopening reuses the completed immutable snapshot and worker preparation. A 4 ms timer measures scheduling gaps, not exact frame time or physical paint; a 32 ms gap can still miss a frame. Filesystem crawling, package activation, host creation and reading the input JSON remain outside the timed interval. Background fuzzy candidate preparation completes between samples and is outside the opening timer.

Replacing one path with another and then restoring it retained 500,000 items in every sample. Publication took 447.9–514.1 ms, with maximum timer gaps of 23.7–24.9 ms. Metadata is prepared only for new paths; removals free their slots, surviving item objects are reused, and the sorted delta is merged with the existing order. Publishing a new flat array and refreshing its positional lookup tables still requires linear traversal, performed in bounded batches. These measurements do not claim constant-time updates or incremental reuse of the filtering matcher's entire candidate set after source changes.

## Implementation

- Core accepts frozen `items` arrays as immutable snapshots. Submitting the same snapshot preserves records, generation and filtering preparation. Mutable arrays still mean replacement, and public item getters return independent copies.
- `SelectList.prepareItems(items, {signal})` prepares identity records in bounded renderer batches before source publication. This preserves renderer-owned callbacks and cancellation without introducing another search backend. Unchanged records at unchanged positions are reused.
- A package-owned Node-mode helper process prepares project-relative metadata, exclusions, directory proximity and sorted deltas. Electron renderers cannot create Node `worker_threads`; the helper uses the runtime's native path implementation and compact, bounded IPC messages. Filtering still uses one Chromium worker per list, with the existing explicit synchronous opt-out.
- Metadata is shared by the finder and path completion. Snapshots are separate per finder window and reference directory. Source loading retries if the index or origin changes during preparation. Closing a panel cancels its preparation; package teardown terminates the shared helper and rejects pending work. Project-root or exclusion changes replace the shared metadata generation.
- The explorer freezes its existing index snapshot when publishing it, enabling the same core reuse on reopening.

Both complete source order and every proximity distance match the earlier oracle on all timed openings. Full ordered results for `s`, `se` and `sel` match the preceding implementation in both packages. The add/remove tests compare the complete expected order and verify restoration of the original hash. No result cap, ignore pattern or list truncation was introduced.

Local validation covers immutable/mutable source semantics, cancellation, duplicate IDs, retained selection, record reuse, serialized exclusion rules, helper teardown, slot reuse, removals spanning multiple batches, opening-time index changes, non-text pane origins, multiple windows and existing package actions. Initial pilots exposed Electron's unsupported Node worker-thread mode and a missing package declaration in the combined test launcher; both were corrected before the accepted measurements. Core CI also caught the required JSDoc tag order for the new method; that documentation error was corrected.

The dependency graph was not changed. Package audits report no vulnerabilities; the editor audit currently reports nine advisories in its existing dependency graph (eight moderate and one high), including build tooling and markdown-it. Dependency remediation is outside this performance change.
