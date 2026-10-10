# harness_imperial: rules for every agent

The owner's rules for choosing models (#168), word for word. `CLAUDE.md` holds the same; for
everything else, read `CLAUDE.md` and `README.md`.

## Choosing models

1. Ask the quota service with the tier the work needs:
   - `tier=heavy`: implementation work, and hard reviews
   - `tier=light`: small tasks, and simple reviews
   e.g. `curl -s "http://localhost:8765/recommend?tier=heavy"`
2. A task that needs an implementer and a reviewer: one call. The implementer is
   `pair.implementer` and the reviewer is `pair.reviewer` (same tier as the call; for a simple
   review of heavy work, add `&review_tier=light`). Run each one's `command`.
3. A review on its own (the implementation was done earlier): add
   `&exclude_family=<the implementer's family>` and use `pick`.
4. Any other single model: use `pick`.
5. If a chosen model can't run, use the next row of `ranking` (in `rank` order). For a
   reviewer chosen in rule 2, skip rows with the same `family` as the implementer.
6. Nothing else decides which model to use: no lists, chains, exclusions, score thresholds
   or percentages of your own. Every row in `ranking` is usable; rows in `skipped` are not.
7. Record the rows you used and their `reasons` with the run.
8. If the service doesn't answer: run `systemctl --user restart quota-tracker` in WSL and
   retry. If it still doesn't answer, tell the owner; don't choose a model yourself.
