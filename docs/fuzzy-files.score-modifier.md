# fuzzy-files.score-modifier

Adjusts how the file finder ranks its results, so a package can push the files it knows are relevant to the top.

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Version     | `1.0.0`                                                            |
| Provided by | `provideFuzzyFilesScoreModifier()` returning `{ add, invalidate }` |
| Consumed by | `consumeFuzzyFilesScoreModifier(service)`                          |
| Owner       | `fuzzy-files`                                                      |

Recency, git status, open editors, or a language server's notion of relatedness can influence the ordering without the finder knowing about the provider's domain.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "fuzzy-files.score-modifier": {
      "versions": { "^1.0.0": "consumeFuzzyFilesScoreModifier" }
    }
  }
}
```

## Contract

```ts
type ScoreModifierService = {
  add(modifier: (score: number, item: Item) => number): Disposable;
  invalidate(modifier: (score: number, item: Item) => number): Promise<void>;
};

type Item = {
  fPath: string;
  distance: number;
};
```

`add` registers a modifier and returns a `Disposable` that removes it. The modifier receives the score so far and the item, and returns the new score. **Higher scores rank first.**

Adding or removing a modifier refreshes each existing finder's scores. Call `await service.invalidate(modifier)` when state captured by a registered function changes; an unregistered function is ignored. Invalidation preserves prepared text and the existing matching worker. New source snapshots automatically invalidate scores, including when reference-directory changes replace proximity weights.

`item` carries at least `fPath`, the project-relative path, and `distance`, which `fuzzy-files` has already folded into the base score.

The reference is the pane item from which the finder was invoked, captured before the panel takes focus. Any pane item with an absolute filesystem path participates, including PDFs, images and notebooks; an item without such a path has neutral distance `1`. Activating another pane does not replace this reference. Moving the original item's path refreshes the distances in its window.

Distances preserve the previous relative-path-depth weighting, with cached calculations shared by directories and source paths. A package-owned background process prepares metadata and proximity; each finder retains its own immutable snapshot, while filtering still uses a worker per list. Reopening with unchanged data and reference directory reuses the snapshot. Added and removed paths update metadata incrementally and are merged into the existing order; changed exclusions or project roots rebuild the shared metadata. File actions calculate the selected relative-path string when needed. Score modifiers must treat snapshot items as read-only.

## Minimal example

```js
module.exports = {
  consumeFuzzyFilesScoreModifier(service) {
    const modifier = (score, item) => {
      // Float recently edited files to the top.
      return this.recentPaths.has(item.fPath) ? score * 2 : score;
    };
    // Retain the function to call service.invalidate(modifier) when recentPaths changes.
    return service.add(modifier);
  },
};
```

## Behavior

Modifiers run **after** the built-in ranking, which already divides the fuzzy-match score by the item's distance and the square root of its path depth — so shallow, close files start ahead. Your modifier sees that adjusted number.

They are applied in registration order, each receiving the previous one's output, so several packages compose rather than compete. That also means a modifier returning a constant destroys every ranking decision made before it. Multiply or add a bounded amount; do not replace.

The modifier runs for matching candidates when a query's adjusted scores are first computed or explicitly invalidated. Revisiting a cached query reuses its scores and ordering. The function must be synchronous and cheap. Precompute whatever you need, such as a `Set` of interesting paths, and invalidate the modifier when that state changes.

Returning `NaN` or a non-number silently sinks the item to the bottom, since the comparison fails. Guard your arithmetic.

## Teardown

`add` returns a `Disposable` that removes the modifier; return it directly from your consumer method. Leaving one registered after your package deactivates keeps a stale closure on the ranking hot path.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
