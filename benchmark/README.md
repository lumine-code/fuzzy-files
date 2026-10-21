# Large-list opening measurements

The [background preparation follow-up](background-opening-2026-10-21.md) supersedes the remaining-cost findings below: it measures snapshot reuse, background metadata preparation and incremental index updates on the same corpora.

Measured on Windows on 2026-10-21, with Electron 44.9.0 and Node 24.22.0. These measurements cover opening the real package list against an already available project index. They do not include the filesystem crawl, package activation, host creation or loading the benchmark input JSON.

## Paired comparison

Four fresh editor processes ran in before/after/after/before order. Each opened both lists once and then reopened each three times. The before variant restores the affected package methods from `ba9ceaacad820f3c87e4258b89ee7d1afbd8e6cb`; the after variant uses the production implementation accompanying this report. The editor, input paths, exclusions and rendering limit stay identical. The invocation reference is the same text editor in both variants; separate integration tests cover non-text pane items.

Elapsed time runs from `host.show()` through its completion and forced layout. It is not a physical screen-paint measurement. Worker preparation and correctness checks finish between samples, outside the opening timer. First opening includes constructing package metadata from the ready index; reopening reuses that metadata and the proximity cache. The first-opening medians have two samples per variant, and reopening medians have six. These are local diagnostic measurements, not a statistical performance guarantee.

| List           | Entries | Opening | Before median | After median |       Before range |        After range |
| -------------- | ------: | ------- | ------------: | -----------: | -----------------: | -----------------: |
| fuzzy-files    | 500,000 | First   |    6,297.8 ms |   4,555.8 ms | 6,092.6–6,503.1 ms | 4,504.5–4,607.1 ms |
| fuzzy-files    | 500,000 | Reopen  |    1,423.3 ms |     432.1 ms | 1,304.1–1,655.0 ms |     411.5–523.9 ms |
| fuzzy-explorer |  30,253 | First   |       59.3 ms |      60.7 ms |       58.9–59.7 ms |       60.3–61.0 ms |
| fuzzy-explorer |  30,253 | Reopen  |       24.9 ms |      27.6 ms |       23.8–28.7 ms |       24.0–46.0 ms |

The fuzzy-files median improved by approximately 28% on first opening and 70% on reopening. The unchanged explorer is a control; its variation is not an improvement. Every opening retained the complete input list and rendered 100 rows. No exclusions or result limits were added to achieve these results.

The project corpus was recaptured from the current editor index after local diagnostics were deleted. It reaches the existing 500,000-entry index cap and is not the same corpus as earlier migration reports. Compare only the paired runs here. The explorer corpus retains its original 30,253 entries. [Sanitized measurements](opening-2026-10-21.json) contain input hashes, source byte hashes, individual timings and verification hashes, without local filenames. Source hashes describe the measured working-copy bytes, including their line endings.

## Changes and correctness

- Capture the invoking pane item before the finder takes focus, including a non-text item with an absolute `getPath()`. An item without a usable path gets neutral distance 1. A different active pane does not change an open finder's origin.
- Calculate directory-relative distance once per target directory, with exact file-level fallbacks for ancestor paths and platform edge cases. Cache the resulting file distances per finder window and reference directory. Index additions/removals and exclusion changes invalidate those caches.
- Stop constructing unused relative-path strings for every item. Selected-file path actions still calculate their required strings when invoked.
- Publish a pending initial snapshot once, after the index settles, instead of rebuilding it both in the index observer and in the source loader.

All 500,000 distances were checked against the previous `path.relative(dirname(reference), candidate)` separator-count calculation on every measured opening. Complete ordered ID hashes match across all four runs. Complete result order for `s`, `se` and `sel` also matches between the first before/after pair, for both packages. The package suite passes 148 specs, including 20,000 seeded Windows/POSIX path comparisons, non-text invocation, no-path neutrality, cache invalidation, window isolation and single initial publication.

## Remaining cost

Opening is still blocking. A 4 ms heartbeat recorded gaps approximately as long as the opening time, including the improved 432 ms median reopening. The filtering worker does not move package index ingestion or SelectList record construction off the renderer thread.

Separate instrumented runs attribute the baseline reopening's main cost to relative-path calculation (about 1.03–1.15 s) and model construction (about 0.19–0.32 s). The production profile measures cached distance assignment at 138–151 ms, model construction at 248–271 ms, eight full-array reads at 50–64 ms combined, and snapshot copying at 30–40 ms. Rendering 100 rows costs 2–3 ms. Initial metadata ingestion is still the largest phase: about 3.2 s in the baseline profile and 4.2 s in the later production profile. These instrumented runs are phase attribution, not the paired timing comparison above.

The next useful targets are initial path metadata ingestion and reuse of unchanged SelectList records and snapshots. Moving filtering to a worker alone does not solve these opening costs. No successful V8 CPU profile was collected: the test renderer has no inspector support, so these phase measurements use high-level synchronous method timing instead.
