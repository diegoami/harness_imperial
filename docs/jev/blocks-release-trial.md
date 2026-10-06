# The blocks-release trial's labels (#4)

`blocks-release-labels.jsonl` in this folder is the trial set: 92 issues from
[imperial_conquest_2](https://github.com/diegoami/imperial_conquest_2), each `{"id", "state",
"label"}` with the state an issue carries (`title`, `body`, `labels`) and the answer the owner's
own scheduling gave. The labels are decisions the owner already made, not labels made for the
trial:

- **label true (33)** — a `bug` issue above #465, closed, with no `post-v0.5.0` label: scheduled
  and fixed for v0.5.0, so it blocked the release.
- **label false (59)** — a `bug` issue with `post-v0.5.0`: deferred past v0.5.0 by the owner, so
  it did not block it.

Excluded, deliberately:

- 70 `bug` issues at or below #465, closed, undeferred: scheduled before the playable-build gate
  existed (L1: the gate was adopted at #465), when everything was scheduled regardless — their
  scheduling carries no information about release-blocking.
- 30 open, undeferred bugs: scheduled but never resolved; a decision not yet tested by a release.
- Every non-`bug` issue (tasks, fixes): a different question.

Why `blocks-release` and not `breaks-play` (#4's original title): IC2's history holds no
breaks-play ground truth. The gate of L1 applied only until the first playable build, which
shipped as v0.4.0 at #465; after that, scheduling answered "does this block the next release?" —
a broader line (wrong transactions, broken panels, release-package defects block; wording,
polish, stale comments, tooling do not). The deferral signal measures that question, so that is
the decision the trial measures; `breaks-play` stays untrialled until a project labels it for
real. The confusing case both ways — a missing refusal that lets a wrong transaction through
(blocks) versus one that only adds permissiveness (does not) — is written into
`template/docs/jev/blocks-release.md`.

Re-run the trial (the skill's step 5) when the model pin or the instructions change; rebuild the
labels with the rule above, which is mechanical from IC2's labels.

## The result (2026-10-06): no cutoffs adopted

`jev.mjs trial` asked all 92 ($0.0046, jev-1.13) and adopted nothing: no end reached five items
at 0.95 precision even on the tuning half, so coverage was 0 and both cutoffs stayed null. The
tool reported it plainly, which is the trial working, not failing — the labels do not measure one
predicate. Joined against the answers, both sides are contaminated:

- **The yes side** (scheduled for v0.5.0) carries process and tooling issues IC2 had labelled
  `bug` — implementer chain orders (#551, #554, #573, #575), the OpenCode desktop migration
  (#540), the reviewer's typing rule (#590) — and cosmetic choices the owner scheduled anyway
  (#525, #530). Jev answered these low (p ≤ 0.10), as the instructions told it to.
- **The no side** (deferred past v0.5.0) carries gameplay divergences a player reaches — missing
  refusals (#600, #802), the split-army supply rebalance (#630), elimination fidelity (#368),
  war cascades (#383), the AI's peace rule (#384), multi-human setup (#719) — deferred for scope,
  not because a player cannot feel them. Jev answered these high (p ≥ 0.72).

Jev's answers track "does this change behaviour a player reaches" coherently; the owner's
v0.5.0 scheduling mixed that question with release scoping, effort and process work. A release
decision recorded with cleaner semantics — or a hand-labelled set — is what a re-trial needs;
iterating the instructions against this label set would only overfit the contamination.

`blocks-release` therefore ships with its definition and no cutoffs, like `breaks-play`: routing
refuses it until a trial adopts cutoffs.
