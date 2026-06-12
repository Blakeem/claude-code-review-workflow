# review-cycle

**A two-phase, autonomous code-review workflow for Claude Code: first it builds a verified,
effort-scored issue inventory of your codebase — then, after you triage it, it fixes the approved
issues in context-sized batches, with an adversarial critic checking every batch before it is
git-staged.**

The two phases are the point. You cannot prioritize issues or estimate the work until you have
actually reviewed — so **phase `review`** is read-only: it sweeps the codebase in bounded units
(concurrently — it's fast), adversarially verifies every finding against the real code, scores
each one for effort and blast radius, and writes an organized inventory. Then it **stops**. You
read `ISSUES.md`, answer anything flagged for your decision, drop what you disagree with, and only
then run **phase `resolve`**, which batches the approved issues by file/area (so one agent fixes
related things in the same files), fixes them, has a critic tear the diff apart, and stages each
accepted batch as a checkpoint.

It is **two files** (`review-cycle.mjs` — the engine, `gen-manifest.mjs` — the work divider) plus
a config you write. Everything project-specific (gates, conventions, severity floors) lives in the
config; the engine knows nothing about your language or framework.

---

## What it actually does

### Phase `review` — find, verify, organize (read-only)

1. `gen-manifest.mjs` deterministically splits your source tree into **bounded review units**
   (a directory = a unit, split at ~800 LOC / 6 files; big files stand alone), each with a content
   hash so re-runs skip unchanged units.
2. For every unit, concurrently: a **reviewer** reads the files and reports production defects at
   or above your severity floor; a **verifier** (stronger model) then confirms each finding against
   the actual code — rejecting false positives, correcting inflated severities — and routes the
   real ones through a decision matrix:
   - **ACTIONABLE** — clear, local, bounded fix → gets a precise fix instruction for phase 2
   - **NEEDS_USER** — architectural or genuinely ambiguous → written to `DECISIONS.md` with options
     and a recommendation; never auto-fixed
   - **DEFER** — large or cross-cutting → listed for you to plan separately (the upgrade-workflow
     sibling tool is a good fit for these)
3. Everything lands in `runs/<runId>/`: **`issues.json`** (the canonical inventory),
   **`ISSUES.md`** (the triage document — counts, hottest areas first, effort per issue),
   **`DECISIONS.md`**, **`LEDGER.md`**. Then it stops.

Because phase 1 never touches a file, units run **concurrently** — a codebase that takes hours to
review sequentially finishes in roughly the wall-clock time of its slowest few units.

### You triage

Read `ISSUES.md`. This is where the planning your single-pass review never allowed happens: you
can see how much work exists, where it clusters, and what it costs before anything changes. Answer
`DECISIONS.md`, flip any issue's `decision` in `issues.json` (`SKIP` what you disagree with), and
pick a starting scope.

### Phase `resolve` — batch, fix, critique, stage

1. A deterministic batcher groups the approved issues **by area and file** under a LOC cap, so one
   agent works related issues in the same files on one context (~150–250k tokens) — and issues in
   the same file are never split across batches.
2. Per batch: a **fixer** re-verifies each issue still exists in the current code (stale ones are
   skipped, never "re-fixed"), applies minimal fixes, writes pinning tests where warranted, runs
   your build + test gates, and leaves everything **unstaged**. An **adversarial critic** then
   reads only the diff and answers two questions: *did every claimed fix actually land?* and *did
   this diff break anything new?* Failures trigger bounded repair rounds; acceptance triggers
   `git add`.
3. A **final sweep** runs the full gates, confirms the unstaged tree is clean, and accounts for
   every issue — fixed, stale, demoted to a decision, or needs-attention — in `SWEEP.md`.

### Safety model — why it won't cause regressions

- **Git staging is the boundary.** Staged = accepted baseline; unstaged = the current batch under
  review. A batch that disturbs earlier accepted work shows up immediately in the critic's diff.
- **It never commits.** Everything lands staged; you review `git diff --cached` and commit.
- **A failed batch is rolled back, not left half-done.** If a batch can't pass the critic within
  its round budget, its files are restored to the staged baseline and its issues are marked
  needs-attention for you — the next batch starts from a clean tree.
- **The fix list is closed.** Phase 2 only ever works the inventory you approved — no fresh review
  mid-fix discovering "just one more thing", which is what makes fixing medium-severity issues
  converge instead of spiraling.

---

## Requirements

- **Claude Code** with the Workflow capability (this runs as a Claude Code *workflow* — it is not
  a standalone Node program).
- The target is a **git repository** with a **clean-ish working tree** (pre-existing local changes
  are folded into the staged baseline automatically).
- **Build/test commands** the agents can run locally: `pnpm check:all`, `pytest`,
  `docker exec … phpunit` — whatever your stack uses. Resolve-phase batches are only accepted on
  green gates, so the suite should be green before you start.

---

## Using it in Claude Code

### 1. Point Claude at this tool and include the word **"workflow"**

> "Use the review-cycle **workflow** in `~/tools/claude-code-review-workflow` to review
> `~/work/myapp` for production readiness. Start with the review phase."

### 2. Generate the manifest

```bash
node gen-manifest.mjs --repo /path/to/your/repo --src src \
  --out runs/myrun/manifest.json
```

(`--ext`, `--cap-loc`, `--exclude` etc. — see the header of `gen-manifest.mjs`.) Eyeball the
printed unit list: each unit is one review agent's whole world.

### 3. Write your config

Copy `examples/TEMPLATE.json` and fill it in (`examples/typescript-mcp-server.json` is a worked
example). The fields that matter most:

| field | what it is |
|------|------------|
| `target.repo` | absolute path to the target **git** repo |
| `manifest` | path to the manifest you generated (default `runs/<runId>/manifest.json`) |
| `gates.build` / `gates.test` | the shell commands that lint/compile and run your tests |
| `conventions` | your project's rules — what the reviewer judges against |
| `reviewSeverity` | floor for what gets *reported* (default `medium`) |
| `fixSeverity` | floor for what phase `resolve` *fixes* (default `medium`) |
| `batch.locCap` / `batch.maxIssues` | batch sizing (default 3000 LOC / 10 issues ≈ 150–250k tokens per fixer) |

### 4. Run phase `review`, triage, then phase `resolve`

- **Review.** Run with `phase: "review"`. It writes the inventory and stops.
- **Triage.** Read `runs/<runId>/ISSUES.md` and `DECISIONS.md`. Edit decisions in `issues.json`
  (or just tell Claude — "skip the two logger ones, answer decision #3 with option B").
- **Resolve.** Run with `phase: "resolve"`. Tip: scope the first run with
  `"resolveOnly": ["src/utils/"]` (issue ids or path prefixes) to sanity-check cost and quality on
  one area before letting the rest go.

Both phases **resume**: kill anytime and re-invoke with the same args — reviewed units (by content
hash) and terminally-resolved issues are skipped.

---

## Reviewing the result

```bash
cd /path/to/target-repo
git diff --cached            # everything the workflow staged
git diff --cached --stat     # file-level summary
<your test command>          # confirm green yourself
```

Then under `runs/<runId>/`:

- **`ISSUES.md`** — the inventory (phase 1's deliverable, your planning document)
- **`DECISIONS.md`** — everything awaiting *your* call; answer these, then re-run resolve
- **`LEDGER.md`** — per-unit and per-issue status tables
- **`CHANGELOG.md`** — human-readable summary of what each batch changed
- **`SWEEP.md`** — final accounting: full-suite result + anything unaccounted for

When you're satisfied: commit. Issues marked **needs-attention** were attempted and rolled back —
retry them interactively with Claude, with the batch's CHANGELOG notes as context.

---

## How much does it cost / how long?

Phase `review` is roughly **(reviewer + verifier + scribe) per unit** — expect ~80–150k tokens per
unit, but wall-clock is short because units run concurrently. Phase `resolve` is a full multi-agent
cycle per batch — roughly **200–400k tokens per batch** depending on repair rounds. Use
`resolveOnly` to checkpoint cheaply, and a token budget directive (e.g. "+2m") if you want the run
to stop cleanly between batches at a spend ceiling.

---

## Reference

- **`CLAUDE.md`** — the operator guide Claude follows when driving this (mechanics and gotchas).
- **`examples/`** — `TEMPLATE.json` plus a worked TypeScript config.
- **`review-cycle.mjs`** — the engine. The config section at the top documents every `args` field.

### Config field reference

| field | required | meaning |
|------|:--:|---------|
| `phase` | ✓ | `"review"` (find + organize + stop) or `"resolve"` (fix in batches) |
| `runId` | ✓ | names the state dir `runs/<runId>/` |
| `target` | ✓ | `{ repo, lang, framework }` — `repo` is the target git repo |
| `gates` | ✓ | `{ build, test, testSetup }` — your stack's commands |
| `manifest` |  | path to the unit manifest (default `runs/<runId>/manifest.json`) |
| `conventions` |  | coding rules the reviewer/critic judge against |
| `root` |  | where run-state lives + base for relative paths; auto-detected from cwd if omitted |
| `reviewSeverity` |  | report floor for phase review (default `medium`) |
| `fixSeverity` |  | fix floor for phase resolve (default `medium`) |
| `criticSeverity` |  | floor for *new* defects the critic reports in a fix diff (default `high`) |
| `reviewPasses` |  | independent review passes per unit, deduped (default 1; 2 = more thorough) |
| `maxRounds` |  | fix→critique repair rounds per batch before rollback (default 2) |
| `batch` |  | `{ locCap: 3000, maxIssues: 10 }` — batch sizing |
| `resolveOnly` |  | array of issue ids and/or file-path prefixes — scope a resolve run |
| `baselineNote` |  | expected pre-existing working-tree changes to fold into the baseline |
| `prepBaseline` / `finalSweep` |  | disable baseline prep / the final sweep (default both on) |
| `minBatchBudget` |  | with a token target set, stop cleanly between batches below this remainder (default `150000`) |
| `models` |  | per-role model tier (defaults: review/critic/scribe `sonnet`, verify/fix `opus`) |
| `agentTypes` |  | per-role custom subagent types — **only set ones that exist in your agent registry** |

### Sibling tool

[`claude-code-upgrade-workflow`](https://github.com/Blakeem/claude-code-upgrade-workflow) is the
goal-driven counterpart: it *changes* a codebase toward a stated goal (migrations, upgrades) and
deliberately ignores pre-existing issues — this tool is the review pass it defers to. Items this
tool routes to **DEFER** (large, cross-cutting) make good upgrade-workflow goals.
