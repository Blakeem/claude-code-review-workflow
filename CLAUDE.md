# review-cycle — operator guide (for Claude)

This repo is a **two-phase Claude Code Workflow** (`review-cycle.mjs` + `gen-manifest.mjs`) that
runs a production-readiness review of a codebase as a planned campaign: phase `review` builds a
verified issue inventory and STOPS; the user triages; phase `resolve` fixes approved issues in
batches with an adversarial critic, staging accepted work.

Your job when a user invokes this: generate the manifest, help them write a correct `args` config,
run phase `review`, **walk them through the triage**, run phase `resolve`, then **verify ground
truth yourself**. Below is what is NOT obvious from the prompts inside the engine.

## How the engine is structured (so you can adapt, not rewrite)

- The engine is **general**. Everything project-specific comes from `args` (hard config boundary
  at the top of `review-cycle.mjs`). Do not hardcode project specifics into the engine.
- It runs under the **Workflow tool runtime** — `agent()`, `pipeline()`, `parallel()`, `phase()`,
  `log()`, `args`, `budget` are harness globals. You can NOT `node review-cycle.mjs` it.
  `gen-manifest.mjs` IS plain Node — run that directly.
- `meta` must stay a pure literal. Top-level `return`/`await` are legal (the harness wraps the body).
- Syntax-check trick (top-level return breaks `node --check`):
  `node -e "const s=require('fs').readFileSync('review-cycle.mjs','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('OK')"`
- Default agent roles use the standard workflow subagent — `agentTypes` is empty by default on
  purpose. Only pass agentTypes that exist in the user's registry; an unknown type fails agent().

## The roles

**Review phase (read-only, units run CONCURRENTLY via pipeline):** Reviewer (finds defects in one
unit) → Verifier (stronger tier; confirms against real code, corrects severity, routes via the
decision matrix, writes the fix_instruction) → unit Scribe (persists `progress/units/<unit>.json`)
→ one Organizer scribe at the end (aggregates VERBATIM into `issues.json` + `ISSUES.md` +
`DECISIONS.md` + `LEDGER.md`).

**Resolve phase (batches run SEQUENTIALLY — gates and staging serialize):** deterministic JS
batcher → Fixer (verify-first, minimal fixes, gates, leaves work UNSTAGED) → Critic (diff-only:
every claimed fix landed? anything new broken?) → Triage/Accept (stages on accept; repair rounds;
final-round failure = surgical ROLLBACK to baseline) → batch Scribe (per-issue
`progress/issues/<id>.json`) → final Sweep.

## The contracts that make it safe — keep them intact

- **Read-only phase 1.** Review/verify agents return data and never write source or shared docs —
  that's what makes the unit fan-out parallel-safe. Only scribes write files, and each writes a
  path it exclusively owns (per-unit / per-issue files); shared docs (ISSUES.md, LEDGER.md) are
  written by exactly one agent at a time.
- **The inventory is CLOSED after phase 1.** Resolve never re-reviews; it only works issues.json.
  This is what makes medium-severity fixing converge (an open review loop finds a fresh batch of
  mediums every pass, forever — that failure mode is designed out, don't reintroduce it by adding
  a re-review step to resolve).
- **Verify-first fixing.** The inventory is a snapshot; code may have moved. The fixer confirms
  each issue still exists before touching it and marks vanished ones STALE. Never let an agent
  "fix" from the issue description alone.
- **Staging = the batch boundary.** Staged index + HEAD = accepted baseline; unstaged tree = the
  current batch (the critic's entire scope). Fixer never stages (except `git add -N` for new
  files so the critic's diff shows them); Triage stages on accept. **Nothing is ever committed —
  the user commits.**
- **Failed batches roll back.** A batch that can't pass within `maxRounds` is restored to the
  staged baseline (`git checkout -- <files>`) and its issues marked needs-attention. The tree must
  be clean for the next batch — never let a broken batch's leftovers pollute the next diff.
- **Severity floors.** `reviewSeverity` (default medium) keeps low-severity nitpicks out of the
  inventory; the engine also drops below-floor findings in JS, so prompt drift can't leak them.
  Do not lower it to "be thorough" — that's the noise spiral the floor exists to prevent.

## Running it — the playbook

1. **Manifest:** `node gen-manifest.mjs --repo <abs> --src src --out runs/<runId>/manifest.json`.
   Show the user the printed unit list. Tune `--cap-loc/--big-file` if units look lopsided.
2. **Config:** copy `examples/TEMPLATE.json`. Get `target.repo` (absolute), `gates`, and
   `conventions` right — conventions are the reviewer's rubric, so distill the project's CLAUDE.md
   into ~10 lines rather than pasting it wholesale. BEST PRACTICE: pass `root` as this tool's
   directory (you know it from the Workflow result's scriptPath) so run-state lands here,
   gitignored, not inside the target repo.
3. **Phase `review`.** Then PRESENT the inventory to the user: totals by severity/decision, the
   hottest areas, and every NEEDS_USER item with its options + recommendation. This is a planning
   conversation — help them decide scope, don't just relay counts.
4. **Triage edits:** apply the user's calls by editing `runs/<runId>/issues.json` decisions:
   - skip an issue → `"decision": "SKIP"` (anything ≠ ACTIONABLE is skipped by resolve)
   - approve a NEEDS_USER with a chosen option → `"decision": "ACTIONABLE"` and REWRITE its
     `fix_instruction` to encode the user's chosen option precisely
   - a DEFER the user wants done anyway → ACTIONABLE only if genuinely batchable; large
     cross-cutting work belongs in the sibling upgrade-workflow as a goal, not in a batch here.
5. **Phase `resolve`.** First run scoped: `"resolveOnly": ["src/oneArea/"]` to sanity-check cost
   and quality. Then the rest. Gates must be green BEFORE starting — resolve assumes a green
   baseline and will thrash otherwise.
6. **Verify ground truth YOURSELF.** Run the full gates in the real environment, read
   `git diff --cached --stat`, spot-read the riskiest fixes, read SWEEP.md. The ledger is what
   agents reported; you confirm reality before telling the user it's done.
7. **Resume** after any stop: re-invoke the same args (hash-skips reviewed units, status-skips
   terminal issues), or `resumeFromRunId` for same-session cache replay.

## Gotchas burned in from real runs

- **The review WILL re-phrase the same concern across passes.** Dedup is by `file:category`, not
  title — keep it that way or duplicates flood the inventory when `reviewPasses` > 1.
- **Reviewer severity is inflated.** That's why the verifier re-scores it; don't skip verify to
  save tokens — an unverified inventory wastes far more user-triage time than verify costs.
- **`git diff` omits brand-new files.** The engine handles it (`add -N`, critic reads untracked);
  when YOU verify by hand, check `git status --porcelain` too.
- **Stale issues are normal, not a bug** — especially on a resume after the user made manual
  edits, or when an earlier batch's fix rippled into a later batch's file. STALE means
  "verify-first worked".
- **issues.json is the single source of truth for WHAT to fix; progress files for WHAT HAPPENED.**
  User triage edits issues.json; the engine never mutates it after Organize. Don't "helpfully"
  update statuses inside issues.json — resume reads `progress/issues/*.json`.
- **A needs-attention batch left the tree CLEAN** (it was rolled back). The work wasn't lost for
  nothing: read the batch's CHANGELOG entry to see what was attempted and why it failed, and offer
  to retry those issues interactively with that context.
- **Stray `runs/` in an unexpected place** = `root` auto-detected to a cwd you didn't expect. Set
  `root` explicitly to this tool's directory.
- **Token budget:** the user can append a budget directive (e.g. "+2m") — the engine stops cleanly
  between batches under `minBatchBudget`. Resume continues where it left off.

## State files (under `runs/<runId>/`)

`manifest.json` (units; from gen-manifest) · `progress/units/<unit>.json` (review resume) ·
`issues.json` (canonical inventory — user-editable decisions) · `ISSUES.md` (triage doc) ·
`DECISIONS.md` (NEEDS_USER items + later demotions) · `progress/issues/<id>.json` (resolve resume)
· `LEDGER.md` · `CHANGELOG.md` (per-batch summaries) · `SWEEP.md` (final accounting). All gitignored.

## When you're done

Report: issues fixed / stale / needs-attention / awaiting-decision, the full-suite result (run it
yourself), what's staged (`git diff --cached --stat`), and anything in DECISIONS.md. **Never
commit** — tell the user what to review and let them commit.
