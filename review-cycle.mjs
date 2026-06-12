export const meta = {
  name: 'review-cycle',
  description: 'Two-phase production-readiness review: "review" finds, verifies and organizes issues into a triaged inventory and stops; "resolve" fixes approved issues in context-sized batches with an adversarial critic, leaving accepted work git-staged',
  whenToUse: 'Run a deep code review of a whole codebase (or subsystem) as a planned campaign. phase:"review" is read-only: it reviews bounded units concurrently, adversarially verifies every finding, scores effort, and writes a triaged issue inventory (issues.json / ISSUES.md / DECISIONS.md) for the user to approve. phase:"resolve" then works through the approved issues in batches grouped by file/area: fix → critique → triage → stage.',
  phases: [
    { title: 'Load', detail: 'Read the unit manifest / issue inventory + prior progress (resume)' },
    { title: 'Review', detail: 'Reviewer finds production defects in one bounded unit (units run concurrently, read-only)' },
    { title: 'Verify', detail: 'Verifier confirms each finding against the real code, scores the decision matrix + effort' },
    { title: 'Record', detail: 'Scribe persists per-unit / per-batch progress durably (drives resume)' },
    { title: 'Organize', detail: 'Scribe aggregates verified issues into issues.json + ISSUES.md + DECISIONS.md + LEDGER.md' },
    { title: 'Fix', detail: 'Fixer re-verifies and fixes one batch of issues, runs gates, leaves work UNSTAGED' },
    { title: 'Critique', detail: 'Adversarial critic reviews the unstaged diff only: every fix landed, nothing new broken' },
    { title: 'Triage', detail: 'Triage routes critic findings, stages on accept, plans repair rounds' },
    { title: 'Sweep', detail: 'Final accounting: full gates, staged-diff spot-check, every issue has a terminal status' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, target, gates }; got typeof=' + (typeof args));
}

const PHASE       = A.phase ?? 'review';                     // 'review' (find + organize, then STOP) | 'resolve' (fix in batches)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                          // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                           // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 2;                        // fix→critique repair rounds per batch
const REVIEW_PASSES = A.reviewPasses ?? 1;                   // independent review passes per unit (2 = more thorough)
const BATCH_LOC   = A.batch?.locCap ?? 3000;                 // max summed LOC of distinct files per batch (~150-250k tokens/agent)
const BATCH_MAX   = A.batch?.maxIssues ?? 10;                // max issues per batch (soft — same-file issues never split)
const MIN_BATCH_BUDGET = A.minBatchBudget ?? 150_000;        // with a token target set, stop cleanly between batches below this

// Severity floors. The review reports >= reviewSeverity; the resolve phase fixes >= fixSeverity.
// Unlike a live review-fix loop, fixing mediums HERE converges: the inventory is CLOSED at the end
// of the review phase, so there is no fresh review to surface a new batch each round.
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
const REVIEW_SEV_NAME = A.reviewSeverity ?? 'medium';
const REVIEW_SEV  = SEV_RANK[REVIEW_SEV_NAME];
const FIX_SEV     = SEV_RANK[A.fixSeverity ?? 'medium'];
const CRITIC_SEV_NAME = A.criticSeverity ?? 'high';          // floor for NEW defects the critic reports in a fix diff

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so
// every role runs as the harness's standard workflow subagent (always available). Only set
// agentTypes that exist in YOUR agent registry — an unknown type fails the agent() call.
const AT = { ...(A.agentTypes ?? {}) };
const M  = { review: 'sonnet', verify: 'opus', fix: 'opus', critic: 'sonnet', scribe: 'sonnet', ...(A.models ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// Resolve ROOT to an ABSOLUTE path so every agent + `git -C` call is cwd-independent. Priority:
// explicit args.root → auto-detect the working directory at runtime.
let ROOT = (A.root ? String(A.root) : '').replace(/\\/g, '/').replace(/\/+$/, '');
if (!ROOT) {
  const loc = await agent(
    'Output ONLY the absolute current working directory: run `pwd` and return its path verbatim, nothing else. Read-only — change nothing.',
    roleOpts('scribe', { label: 'locate-root', phase: 'Load',
      schema: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } }),
  );
  ROOT = String(loc?.cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  log(`root auto-detected: ${ROOT || '(detection failed — falling back to cwd-relative paths)'}`);
}
const abs       = (p) => (ROOT && !/^([a-zA-Z]:)?\//.test(p)) ? `${ROOT}/${p}` : p;
const REPO      = abs(TARGET.repo ?? '.');
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const MANIFEST  = abs(A.manifest ?? `runs/${RUN_ID}/manifest.json`);
const ISSUES_JSON = `${STATE_DIR}/issues.json`;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

// Full-suite gate: a review-fix campaign assumes a green baseline, so every accepted batch must
// keep build AND tests green (no per-task red-baseline semantics like a migration needs).
const gateOk = (dev) => !!dev
  && (!GATES.build || dev.build_passed === true)
  && (!GATES.test || dev.test_outcome === 'passed');

// =============================================================================
// Structured-output schemas
// =============================================================================
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail'],
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line number or range, or "" if N/A' },
          category: {
            type: 'string',
            enum: ['correctness', 'security', 'error-handling', 'resource-leak', 'data-integrity',
              'types', 'api-contract', 'concurrency', 'testing', 'performance', 'maintainability', 'convention'],
          },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'short, specific, stable' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'is_real', 'severity', 'decision', 'matrix', 'rationale'],
        properties: {
          finding_id: { type: 'string' },
          is_real: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'YOUR confirmed severity (reviewers over-rate; correct it)' },
          decision: { type: 'string', enum: ['ACTIONABLE', 'NEEDS_USER', 'DEFER', 'REJECT'] },
          matrix: {
            type: 'object',
            required: ['clarity', 'effort', 'blast_radius', 'scope', 'architectural'],
            properties: {
              clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
              effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
              blast_radius: { type: 'string', enum: ['local', 'cross-cutting'] },
              scope: { type: 'string', enum: ['in-scope', 'scope-creep'] },
              architectural: { type: 'boolean' },
            },
          },
          rationale: { type: 'string' },
          fix_instruction: { type: 'string', description: 'precise minimal instruction for the fixer (ACTIONABLE only)' },
          options: { type: 'string', description: 'NEEDS_USER only: the distinct choices + tradeoffs' },
          recommendation: { type: 'string', description: 'NEEDS_USER only: your suggested direction' },
          theme: { type: 'string', description: 'short grouping keyword (e.g. "pagination", "null-handling") for batching related issues' },
        },
      },
    },
  },
};

const UNIT_LOADER_SCHEMA = {
  type: 'object',
  required: ['units', 'done'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'hash', 'loc', 'files'],
        properties: {
          id: { type: 'string' }, hash: { type: 'string' }, loc: { type: 'integer' },
          fileCount: { type: 'integer' },
          files: { type: 'array', items: { type: 'object', required: ['path', 'loc'], properties: { path: { type: 'string' }, loc: { type: 'integer' } } } },
        },
      },
    },
    done: { type: 'array', items: { type: 'object', required: ['id', 'hash', 'status'], properties: { id: { type: 'string' }, hash: { type: 'string' }, status: { type: 'string' } } } },
    manifest_missing: { type: 'boolean' },
  },
};

const ISSUE_LOADER_SCHEMA = {
  type: 'object',
  required: ['issues', 'done'],
  properties: {
    issues: {
      type: 'array',
      description: 'SLIM index of every issue in issues.json (full detail stays in the file)',
      items: {
        type: 'object',
        required: ['id', 'file', 'loc', 'severity', 'category', 'decision', 'title'],
        properties: {
          id: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' },
          loc: { type: 'integer', description: 'LOC of the issue\'s file' },
          severity: { type: 'string' }, category: { type: 'string' },
          decision: { type: 'string' }, title: { type: 'string' },
          effort: { type: 'string' }, theme: { type: 'string' },
        },
      },
    },
    done: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' } } } },
    inventory_missing: { type: 'boolean' },
  },
};

const FIX_SCHEMA = {
  type: 'object',
  required: ['results', 'build_passed', 'test_outcome', 'unstaged_confirmed'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue_id', 'status', 'summary'],
        properties: {
          issue_id: { type: 'string' },
          status: { type: 'string', enum: ['FIXED', 'STALE', 'SKIPPED', 'FAILED'] },
          files_changed: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
    },
    tests_written: { type: 'boolean' },
    build_passed: { type: 'boolean' },
    test_outcome: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
    unstaged_confirmed: { type: 'boolean', description: 'true if changes were left UNSTAGED (git add NOT run, except add -N for new files)' },
    gate_output: { type: 'string', description: 'tail of failing gate output, or "" if green' },
    notes: { type: 'string' },
  },
};

const CRITIC_SCHEMA = {
  type: 'object',
  required: ['fix_checks', 'findings'],
  properties: {
    fix_checks: {
      type: 'array',
      description: 'one entry per issue the fixer claimed FIXED',
      items: {
        type: 'object',
        required: ['issue_id', 'actually_fixed'],
        properties: {
          issue_id: { type: 'string' },
          actually_fixed: { type: 'boolean', description: 'the diff genuinely resolves the issue as described' },
          note: { type: 'string', description: 'when false: what is missing or wrong' },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'NEW problems this diff introduced (not pre-existing code smells)',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail'],
        properties: {
          file: { type: 'string' }, line: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'security', 'error-handling', 'regression', 'data-integrity', 'types', 'api-contract', 'testing', 'performance', 'convention'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' }, detail: { type: 'string' }, suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['accepted', 'staged', 'has_blocker'],
  properties: {
    accepted: { type: 'boolean', description: 'true if the round is accepted (gates green, fixes confirmed) and was staged' },
    staged: { type: 'boolean', description: 'true if you ran `git add` on the batch\'s changed files' },
    reverted: { type: 'boolean', description: 'true if you restored the batch\'s files to the staged baseline (final-round failure path)' },
    regression_found: { type: 'boolean' },
    has_blocker: { type: 'boolean', description: 'true ONLY if no further progress on ANY batch is possible (halts the whole run)' },
    demoted_issues: { type: 'array', items: { type: 'string' }, description: 'issue ids whose fix turned out to need a user decision — logged to DECISIONS.md, not fixed' },
    next_fix_plan: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } },
      description: 'repair plan for the next round (present when accepted=false and not reverted/blocked)',
    },
    wrote_logs: { type: 'boolean' },
    summary: { type: 'string' },
  },
};

const RECORD_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'boolean' }, count: { type: 'integer' } } };

const ORGANIZE_SCHEMA = {
  type: 'object',
  required: ['written', 'total', 'actionable', 'needs_user', 'deferred'],
  properties: {
    written: { type: 'boolean' },
    total: { type: 'integer' }, actionable: { type: 'integer' },
    needs_user: { type: 'integer' }, deferred: { type: 'integer' },
    by_severity: { type: 'object', properties: { critical: { type: 'integer' }, high: { type: 'integer' }, medium: { type: 'integer' }, low: { type: 'integer' } } },
  },
};

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['complete', 'gaps', 'suite_result'],
  properties: {
    complete: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'object', required: ['title', 'evidence'], properties: { title: { type: 'string' }, evidence: { type: 'string' } } } },
    suite_result: { type: 'string' },
  },
};

const BASELINE_SCHEMA = {
  type: 'object',
  required: ['clean'],
  properties: {
    clean: { type: 'boolean' },
    staged_files: { type: 'array', items: { type: 'string' } },
    ignored_untracked: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

// =============================================================================
// Shared prompt fragments
// =============================================================================
const CONTEXT = `
TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
All source paths below are RELATIVE TO THIS REPO. Use \`git -C ${REPO} …\` for any git operation.

CONVENTIONS (judge against these; deviations are 'convention' findings):
${CONVENTIONS}

GATES (the build/test commands that define "it works"; run them from the repo root):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}
  ${GATES.testSetup ? `test setup note: ${GATES.testSetup}` : ''}

BE TOKEN-ECONOMICAL (target ~150k tokens for your whole turn): read ONLY the files your task
names. Prefer targeted grep over broad reads. Don't restate large files back; act on them.
`;

const STAGING = `
STAGING CONTRACT (the batch boundary is git itself):
  • staged index + HEAD  = ACCEPTED baseline (prior blessed work). Treat as known-good.
  • unstaged working tree = THIS batch's work — the only thing under review.
  • The Fixer NEVER stages content. Triage stages (git add, NEVER commit) only on acceptance.
  • Nothing is EVER committed — the user reviews \`git diff --cached\` and commits.
`;

// =============================================================================
// Review-phase prompts
// =============================================================================
const reviewPrompt = (unit, handled) => `
You are the REVIEWER examining ONE bounded unit of a codebase for PRODUCTION READINESS. This is a
FIND-ONLY pass: you report defects; a separate verified+planned phase fixes them later. Do NOT
modify any file.
${CONTEXT}
UNIT: ${unit.id}
FILES TO REVIEW (read them fully; review ONLY these files):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}

Assess against these criteria and report concrete, located issues:
  correctness, security, error-handling, resource-leak (unclosed handles/timers/sockets),
  data-integrity, types, api-contract, concurrency (races, shared state), testing (missing
  coverage of risky paths), performance, maintainability, convention adherence.

RULES:
- SEVERITY FLOOR: report ONLY ${REVIEW_SEV_NAME}+ production DEFECTS. Do NOT report below-floor,
  stylistic, or speculative "could be more defensive" suggestions — they are dropped downstream
  and only waste the verify stage. If in doubt it's below the floor, omit it.
- READ THE CURRENT FILE CONTENTS before reporting. Do NOT report anything already handled in the
  code as it exists now${handled.length ? ', and do NOT re-report anything in the ALREADY FOUND list below (even rephrased)' : ''}.
- Stay INSIDE this unit's files. Cross-file concerns: mention as context in detail, do not chase.
- Report DEFECTS, not redesigns. No speculative rewrites, no gold-plating, no scope creep.
- Each finding: specific file + line, the right category/severity, what's wrong and why it
  matters in production, and a minimal suggested_fix direction.
${handled.length ? `\nALREADY FOUND in a prior pass (do NOT re-report):\n${handled.map((t) => `  - ${t}`).join('\n')}` : ''}

Return findings via the structured schema. An empty findings array means this unit is clean —
that is a normal, good outcome.`;

const verifyPrompt = (unit, items) => `
You are the VERIFIER (read-only — do NOT modify or write any file; return data only). For each
candidate finding below, inspect the ACTUAL code in the repo to confirm it is real, correct its
severity, then route it with the decision matrix. Reject false positives and gold-plating
ruthlessly — a noisy inventory wastes the user's triage time and the fixer's context.
${CONTEXT}
UNIT: ${unit.id}
CANDIDATE FINDINGS (finding_id :: file :: category/severity :: title):
${items.map((i) => `  - ${i.id} :: ${i.f.file}${i.f.line ? ':' + i.f.line : ''} :: ${i.f.category}/${i.f.severity} :: ${i.f.title}\n      ${i.f.detail}\n      suggested: ${i.f.suggested_fix || '(none)'}`).join('\n')}

DECISION MATRIX — score each real finding on:
  clarity      : clear (one obvious correct fix) | ambiguous (multiple valid fixes / unclear intent)
  effort       : trivial (one-liner) | small (localized, <~30 lines) | medium (<~150 lines, this unit) | large
  blast_radius : local (this unit) | cross-cutting (touches shared contracts / many files)
  scope        : in-scope (a real defect in current behavior) | scope-creep (nice-to-have / new feature)
  architectural: true if it questions a design/structural decision

ROUTING (apply in order; first match wins):
  - is_real == false                       -> REJECT
  - scope == scope-creep                   -> REJECT (note why; do not pursue)
  - architectural == true                  -> NEEDS_USER (the user must decide design direction; fill options + recommendation)
  - clarity == ambiguous with materially different valid fixes -> NEEDS_USER (fill options + recommendation)
  - effort == large OR blast_radius == cross-cutting -> DEFER (too big for an autonomous batch; the user plans it)
  - otherwise                              -> ACTIONABLE (write a precise, minimal fix_instruction)
Also set a short \`theme\` keyword per verdict so related issues can be batched together.
Return all verdicts via the structured schema. Do NOT write any files.`;

const unitRecordPrompt = (unit, record) => `
You are the SCRIBE. Persist this unit's review result durably so a re-run resumes without redoing
it. Do NOT modify source code or alter any finding text.
1. Ensure ${STATE_DIR}/progress/units/ exists (mkdir -p).
2. Write this EXACT JSON verbatim to ${STATE_DIR}/progress/units/${fileSafe(unit.id)}.json:
${JSON.stringify(record)}
Return written=true.`;

const organizePrompt = (totalUnits) => `
You are the ORGANIZER scribe. Aggregate every per-unit review record into the canonical issue
inventory the user will triage. Do NOT modify source code. Do NOT rephrase, merge, drop, or
re-judge any issue — copy issue objects VERBATIM.
1. Read EVERY ${STATE_DIR}/progress/units/*.json. Each holds { id, hash, loc, status, counts, issues:[…] }.
2. Write ${ISSUES_JSON}: { "runId": "${RUN_ID}", "units": <number of unit records>, "issues": [ …all issue objects from all units, verbatim, sorted by file then id… ] }.
3. Write ${STATE_DIR}/ISSUES.md — the human triage document, organized for PLANNING:
   - Header: total counts by decision and severity.
   - "# Needs your decision" — every NEEDS_USER issue, full detail: id, [severity/category], file:line,
     what, options, recommendation. These BLOCK nothing but are never auto-fixed.
   - "# Deferred (large / cross-cutting)" — every DEFER issue with id, matrix, and what a plan would involve.
   - "# Actionable" — grouped by top-level area (directory), one table per area:
     | id | sev | effort | category | file:line | title |
     Order areas by (max severity, then issue count) so the hottest areas lead.
   - Footer: "Edit decisions in issues.json (set decision to ACTIONABLE / SKIP / NEEDS_USER), then run phase:resolve."
4. Write ${STATE_DIR}/DECISIONS.md — ONLY the NEEDS_USER issues, one section each (id, where, what,
   options, recommendation) with an empty "**Your decision:**" line the user can fill in.
5. Rebuild ${STATE_DIR}/LEDGER.md: "# Review ledger — N / ${totalUnits} units reviewed" + a table
   (unit | status | found | actionable | needs-you | deferred | rejected), one row per unit record, sorted by id.
Return the counts via the schema.`;

// =============================================================================
// Resolve-phase prompts
// =============================================================================
const issueLoaderPrompt = () => `
You are the PROGRESS LOADER (read-only). Prepare a resolve-phase resume.
1. Read ${ISSUES_JSON}. Return a SLIM index of EVERY issue as "issues": for each, copy
   id, file, line, loc, severity, category, decision, title, effort, theme EXACTLY as stored
   (do not re-judge anything). If the file is missing return issues=[] and inventory_missing=true.
2. Read every ${STATE_DIR}/progress/issues/*.json (if the dir exists) → return one {id, status}
   per file as "done". Return [] if none.
Do NOT modify anything. Return via the schema.`;

const baselinePrompt = () => `
You are establishing the git BASELINE for this run in ${REPO}.
${STAGING}
Right now the tree may carry PRE-EXISTING local changes that belong to NO batch and must not
pollute batch review diffs.
1. Run \`git -C ${REPO} status --porcelain\`.
2. For every MODIFIED or otherwise-tracked-changed file, run \`git -C ${REPO} add\` on it to fold
   it into the accepted baseline. Do NOT commit. Afterwards \`git -C ${REPO} diff\` must be EMPTY.
3. Leave UNTRACKED files untouched — just list them in ignored_untracked.
${A.baselineNote ? `Expected pre-existing changes (normal — stage as baseline, do not revert): ${A.baselineNote}` : ''}
Do NOT modify any source code. Return the lists + clean=true via the schema.`;

const fixPrompt = (batch, round, repairPlan) => `
You are the FIXER. Resolve the verified issues below — exactly as instructed, minimally and
surgically. NO opportunistic refactors, NO scope creep beyond what each fix requires.
${CONTEXT}${STAGING}
BATCH ${batch.id} (round ${round} of max ${MAX_ROUNDS}) — ${batch.issues.length} issue(s), files: ${[...new Set(batch.issues.map((i) => i.file))].join(', ')}
${repairPlan ? `THIS IS A REPAIR ROUND. The critic rejected the previous round. Address ONLY:\n${(repairPlan.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\nYour prior round's work is still in the unstaged tree — build ON it, do not revert it.\n` : `ISSUES (read each one's FULL entry — detail, rationale, fix_instruction — from ${ISSUES_JSON}, keyed by id):\n${batch.issues.map((i) => `  - ${i.id} [${i.severity}/${i.category}] ${i.file}${i.line ? ':' + i.line : ''} — ${i.title}`).join('\n')}`}

PROCEDURE:
0. BASELINE: the accepted baseline is already STAGED, so \`git -C ${REPO} diff\` shows only this
   batch's work. Do not stage anything yourself.
1. VERIFY-FIRST: the inventory was written from a past snapshot — for EACH issue, read the current
   code and confirm it still exists. If it was already fixed or no longer applies, mark it STALE
   and move on. Never "fix" what isn't there.
2. Apply each confirmed fix per its fix_instruction. Match surrounding style and the CONVENTIONS.
   Where a fix warrants a pinning test (regressions, tricky edge cases, 'testing' category issues),
   write it. Never weaken or delete existing tests to make gates pass; never disable lint rules.
3. Run the GATES from the repo root and record honest results (build_passed, test_outcome).
   If a fix breaks a gate and you cannot resolve it within the fix's own scope: revert THAT change
   (surgically), mark the issue FAILED with the reason, and keep the rest.
4. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content, do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add) so the critic's \`git diff\`
   shows it. Set unstaged_confirmed=true.
5. SELF-REVIEW your own diff before returning and fix anything obviously wrong — catching it here
   saves a whole critique→repair round.
Report per-issue status + gate results via the schema.`;

const criticPrompt = (batch, claimedFixed, handled) => `
You are the ADVERSARIAL CRITIC. Review ONLY this batch's work — the UNSTAGED diff — with two jobs:
(1) confirm every claimed fix actually landed, (2) catch anything NEW this diff broke. The staged
baseline is known-good context; do NOT review it or hunt for pre-existing problems.
${CONTEXT}${STAGING}
BATCH ${batch.id}. Get the exact scope first:
  \`git -C ${REPO} diff\`                  (unstaged tracked changes = this batch — review this)
  \`git -C ${REPO} status --porcelain\`    then READ every new/untracked file belonging to this batch
  \`git -C ${REPO} diff --staged --stat\`  (accepted baseline — context only)

JOB 1 — FIX VERIFICATION. The fixer claims these issues are FIXED. For each, read its full entry
in ${ISSUES_JSON} and check the diff GENUINELY resolves it (not partially, not just nearby):
${claimedFixed.map((i) => `  - ${i.id} :: ${i.file} — ${i.title}`).join('\n') || '  (none claimed fixed)'}
Return one fix_check per issue. actually_fixed=false needs a concrete note on what is missing.

JOB 2 — INTRODUCED DEFECTS. Report ONLY:
  • ${CRITIC_SEV_NAME}+ defects THIS diff introduced (correctness/security/regression/data-integrity/api-contract),
  • anything that blocks the build/tests,
  • a REGRESSION of previously-staged baseline behavior.
Drop silently: pre-existing issues, below-floor severity, style, "could be more defensive",
redesigns. An empty findings list is the NORMAL, GOOD outcome.
${handled.length ? `Do NOT re-report ALREADY HANDLED items:\n${handled.map((t) => `  - ${t}`).join('\n')}` : ''}
Do NOT modify any file. Return via the schema.`;

const acceptPrompt = (batch, round) => `
You are finalizing an ACCEPT for one batch: the critic confirmed all fixes and found nothing new,
and the gates are green. Two jobs only — regression spot-check, then stage.
${CONTEXT}${STAGING}
BATCH ${batch.id} (round ${round}).
1. REGRESSION SPOT-CHECK: \`git -C ${REPO} diff --stat\` (this batch) vs
   \`git -C ${REPO} diff --staged --stat\` (baseline). Confirm the unstaged changes plausibly
   belong to THIS batch's files and did not clobber previously-staged work. If something looks
   regressed, return accepted=false, regression_found=true, and a tight next_fix_plan instead.
2. STAGE: \`git -C ${REPO} add <the batch's changed AND newly-created files>\` (NEVER commit),
   then confirm \`git -C ${REPO} diff\` is empty for those files.
Return accepted=true, staged=true, has_blocker=false via the schema.`;

const triagePrompt = (batch, fixResults, badChecks, findings, round, gateMet, gateOutput, isLastRound) => `
You are TRIAGE — the orchestrator-of-record for the git baseline. The batch is NOT cleanly
acceptable as-is. Decide: repair, accept-with-exclusions, or (final round only) revert.
${CONTEXT}${STAGING}
BATCH ${batch.id} (round ${round} of max ${MAX_ROUNDS}; FINAL ALLOWED ROUND: ${isLastRound ? 'YES' : 'no'})
GATES: ${gateMet ? 'GREEN' : `NOT GREEN — output tail:\n${gateOutput || '(none captured)'}`}
FIXER RESULTS: ${fixResults.map((r) => `${r.issue_id}=${r.status}`).join(', ') || '(none)'}
CRITIC — fixes that did NOT land: ${badChecks.map((c) => `${c.issue_id} (${c.note || 'no note'})`).join('; ') || '(none)'}
CRITIC — introduced defects:
${findings.length ? findings.map((f, i) => `  ${i + 1}. [${f.severity}/${f.category}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}\n     ${f.detail}\n     suggested: ${f.suggested_fix || '(none)'}`).join('\n') : '  (none)'}

PROCEDURE:
1. Verify the critic's claims against the actual unstaged diff (\`git -C ${REPO} diff\`) — reject
   any false positive yourself; do not bounce noise into a repair round.
2. If a fix turns out to genuinely need a user decision (ambiguous intent, behavior change):
   append it to ${STATE_DIR}/DECISIONS.md (id, where, what, options, recommendation), revert THAT
   issue's changes surgically, and list its id in demoted_issues. Set wrote_logs=true.
3. DECIDE:
   • If the remaining diff is sound and gates are green (re-run them if you changed anything):
     ACCEPT — \`git -C ${REPO} add\` the batch's changed + new files (NEVER commit);
     accepted=true, staged=true.
   • Else if NOT the final round: accepted=false, and return a tight next_fix_plan (steps + files)
     covering ONLY the real unresolved items: gate failures, fixes that didn't land, real
     introduced defects. Leave the tree unstaged for the repair round.
   • Else (FINAL round, still unacceptable): RESTORE the batch's files to the staged baseline
     (\`git -C ${REPO} checkout -- <files>\`; delete files this batch created), set reverted=true,
     accepted=false. The issues will be recorded needs-attention with your summary — the user
     retries them with more context. Confirm gates are green again after the revert.
4. has_blocker=true ONLY if the repo is in a state where NO further batch can safely proceed
   (e.g. gates broken even after revert). That halts the entire run.
Return via the schema with a clear summary.`;

const batchRecordPrompt = (batch, perIssue, batchSummary) => `
You are the SCRIBE. Persist this batch's outcome durably (drives resume). Do NOT modify source code.
1. Ensure ${STATE_DIR}/progress/issues/ exists (mkdir -p).
2. For EACH issue below, write the EXACT JSON shown to ${STATE_DIR}/progress/issues/<issue_id>.json
   (filename = the issue id verbatim + ".json"):
${perIssue.map((p) => `   ${p.id}.json: ${JSON.stringify(p)}`).join('\n')}
3. Append one entry to ${STATE_DIR}/CHANGELOG.md for batch ${batch.id}: files touched, issues fixed
   /stale/failed, tests added, rounds used. One short paragraph: ${batchSummary}
4. Rebuild ${STATE_DIR}/LEDGER.md "# Resolve ledger" section (keep/refresh the review section header
   if present): a table (issue | sev | file | status | batch | rounds) from ALL
   ${STATE_DIR}/progress/issues/*.json, sorted by status then file. Above it put one line:
   "N of M actionable issues terminal".
Return written=true and count=<number of issue files written>.`;

const sweepPrompt = (counts) => `
You are the FINAL SWEEP. Every batch has been processed. Verify the campaign's end state honestly.
${CONTEXT}${STAGING}
EXPECTED ACCOUNTING: ${JSON.stringify(counts)}
PROCEDURE (read-only except step 4):
1. Run the FULL gates once and record the real outcome (suite_result).
2. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): plausible for what was fixed?
   Confirm the unstaged tree is CLEAN (nothing half-done left behind).
3. Cross-check ${STATE_DIR}/progress/issues/*.json against ${ISSUES_JSON}: every ACTIONABLE issue
   at-or-above the fix floor has a terminal status (fixed / stale / needs-attention / demoted).
   Anything unaccounted-for is a gap.
4. Write ${STATE_DIR}/SWEEP.md: suite result, staged-diff summary, accounting table, each gap with
   evidence — or "No gaps found." Do NOT modify source code, stage, or commit.
Return via the schema.`;

// =============================================================================
// PHASE: review — find + verify + organize, then STOP for user triage
// =============================================================================
if (PHASE === 'review') {
  phase('Load');
  const loaded = await agent(`
You are the PROGRESS LOADER (read-only). Prepare a review-phase resume.
1. Read ${MANIFEST} → return its "units" array verbatim (id, hash, loc, fileCount, files).
   If missing, return units=[] and manifest_missing=true.
2. Read every ${STATE_DIR}/progress/units/*.json (if the dir exists) → return one
   {id, hash, status} per file as "done". Return [] if none.
Do NOT modify anything. Return via the schema.`,
    roleOpts('scribe', { schema: UNIT_LOADER_SCHEMA, phase: 'Load', label: 'load-manifest' }));

  if (loaded?.manifest_missing || !(loaded?.units || []).length) {
    throw new Error(`No unit manifest at ${MANIFEST} — generate one first: node gen-manifest.mjs --repo ${REPO} --src <srcdir> --out ${MANIFEST}`);
  }

  const units = loaded.units;
  const doneById = new Map((loaded.done || []).map((d) => [d.id, d]));
  const pending = units.filter((u) => {
    const d = doneById.get(u.id);
    return !d || d.hash !== u.hash; // never reviewed, or files changed since → (re)review
  });
  log(`resume: ${units.length - pending.length}/${units.length} unit(s) already reviewed; ${pending.length} to review`);

  // Read-only fan-out: each unit flows review → verify → record independently and concurrently.
  const results = await pipeline(
    pending,
    // -- Review (1..REVIEW_PASSES, deduped by file:category across passes) ----
    async (unit) => {
      const found = [];
      const sigs = new Set();
      const handled = [];
      for (let p = 1; p <= REVIEW_PASSES; p++) {
        const r = await agent(reviewPrompt(unit, handled), roleOpts('review', {
          schema: REVIEW_SCHEMA, phase: 'Review',
          label: `review:${unit.id}${REVIEW_PASSES > 1 ? ` p${p}` : ''}`,
        }));
        const passSigs = [];
        for (const f of (r?.findings || [])) {
          if ((SEV_RANK[f.severity] ?? 1) < REVIEW_SEV) continue;
          // Dedup across passes on file+category: re-reviews re-phrase the same concern, so
          // title-based dedup leaks duplicates into the inventory.
          const s = `${f.file}:${f.category}`;
          if (sigs.has(s)) continue;
          passSigs.push(s);
          handled.push(f.title);
          found.push(f);
        }
        passSigs.forEach((s) => sigs.add(s));
      }
      return { unit, findings: found };
    },
    // -- Verify (skipped when the review came back clean) ----------------------
    async (r) => {
      const { unit, findings } = r;
      if (!findings.length) return { unit, issues: [], counts: { found: 0, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 } };
      const items = findings.map((f, i) => ({ id: `${slug(unit.id)}-${i + 1}`, f }));
      const verify = await agent(verifyPrompt(unit, items), roleOpts('verify', {
        schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${unit.id}`,
      }));
      const byId = new Map(items.map((x) => [x.id, x]));
      const locOf = new Map((unit.files || []).map((f) => [f.path, f.loc]));
      const issues = [];
      const counts = { found: findings.length, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 };
      for (const v of (verify?.verdicts || [])) {
        const item = byId.get(v.finding_id);
        if (!item) continue;
        if (!v.is_real || v.decision === 'REJECT') { counts.rejected++; continue; }
        if (v.decision === 'ACTIONABLE') counts.actionable++;
        else if (v.decision === 'NEEDS_USER') counts.needs_user++;
        else counts.deferred++;
        issues.push({
          id: item.id, unit: unit.id,
          file: item.f.file, line: item.f.line || '', loc: locOf.get(item.f.file) ?? 0,
          category: item.f.category, severity: v.severity || item.f.severity,
          title: item.f.title, detail: item.f.detail,
          decision: v.decision, matrix: v.matrix, effort: v.matrix?.effort || 'small',
          rationale: v.rationale,
          fix_instruction: v.fix_instruction || item.f.suggested_fix || '',
          options: v.options || '', recommendation: v.recommendation || '',
          theme: v.theme || '', status: 'open',
        });
      }
      return { unit, issues, counts };
    },
    // -- Record (per-unit file; parallel-safe because each unit owns its path) --
    async (r) => {
      const { unit, issues, counts } = r;
      const record = { id: unit.id, hash: unit.hash, loc: unit.loc, status: 'reviewed', counts, issues };
      await agent(unitRecordPrompt(unit, record), roleOpts('scribe', {
        schema: RECORD_SCHEMA, phase: 'Record', label: `record:${unit.id}`,
      }));
      log(`  ✓ ${unit.id}: ${counts.found} found → ${counts.actionable} actionable, ${counts.needs_user} needs-you, ${counts.deferred} deferred, ${counts.rejected} rejected`);
      return { id: unit.id, counts };
    },
  );

  const processed = results.filter(Boolean);

  phase('Organize');
  const org = await agent(organizePrompt(units.length), roleOpts('scribe', {
    schema: ORGANIZE_SCHEMA, phase: 'Organize', label: 'organize:issues',
  }));

  return {
    phase: 'review',
    runId: RUN_ID,
    unitsReviewed: processed.length,
    unitsTotal: units.length,
    inventory: {
      total: org?.total ?? 0,
      actionable: org?.actionable ?? 0,
      needsUser: org?.needs_user ?? 0,
      deferred: org?.deferred ?? 0,
      bySeverity: org?.by_severity ?? {},
    },
    files: { issues: ISSUES_JSON, triage: `${STATE_DIR}/ISSUES.md`, decisions: `${STATE_DIR}/DECISIONS.md`, ledger: `${STATE_DIR}/LEDGER.md` },
    nextStep: `Triage ${STATE_DIR}/ISSUES.md (answer DECISIONS.md, flip any decision in issues.json to SKIP/ACTIONABLE), then re-invoke with phase:"resolve". Use resolveOnly to start with one area.`,
  };
}

// =============================================================================
// PHASE: resolve — batch the approved issues, fix → critique → triage → stage
// =============================================================================
if (PHASE !== 'resolve') throw new Error(`Unknown phase "${PHASE}" — use "review" or "resolve".`);

phase('Load');
const loaded = await agent(issueLoaderPrompt(), roleOpts('scribe', {
  schema: ISSUE_LOADER_SCHEMA, phase: 'Load', label: 'load-inventory',
}));
if (loaded?.inventory_missing || !(loaded?.issues || []).length) {
  throw new Error(`No issue inventory at ${ISSUES_JSON} — run phase:"review" first, then triage ISSUES.md.`);
}

const TERMINAL = (s) => ['fixed', 'stale', 'needs-attention', 'demoted', 'skipped'].includes(String(s));
const doneById = new Map((loaded.done || []).map((d) => [d.id, d.status]));
const resolveOnly = Array.isArray(A.resolveOnly) && A.resolveOnly.length ? A.resolveOnly : null;
const inScope = (i) => !resolveOnly || resolveOnly.some((s) => s === i.id || i.file.startsWith(s));

const allIssues = loaded.issues;
const open = allIssues.filter((i) =>
  i.decision === 'ACTIONABLE'
  && (SEV_RANK[i.severity] ?? 1) >= FIX_SEV
  && !TERMINAL(doneById.get(i.id))
  && inScope(i));
const skippedFloor = allIssues.filter((i) => i.decision === 'ACTIONABLE' && (SEV_RANK[i.severity] ?? 1) < FIX_SEV).length;
log(`inventory: ${allIssues.length} issues — ${open.length} open actionable to resolve`
  + ` (${allIssues.filter((i) => TERMINAL(doneById.get(i.id))).length} already terminal,`
  + ` ${allIssues.filter((i) => i.decision === 'NEEDS_USER').length} need your decision,`
  + ` ${allIssues.filter((i) => i.decision === 'DEFER').length} deferred,`
  + ` ${skippedFloor} below the ${A.fixSeverity ?? 'medium'} fix floor${resolveOnly ? `, scoped by resolveOnly` : ''})`);

// ---- Deterministic batcher: same file always together; group by area; cap by LOC + count -------
function buildBatches(issues) {
  const area = (f) => (f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)');
  const sorted = [...issues].sort((a, b) =>
    area(a.file).localeCompare(area(b.file))
    || a.file.localeCompare(b.file)
    || String(a.theme || '').localeCompare(String(b.theme || ''))
    || String(a.id).localeCompare(String(b.id)));
  const batches = [];
  let cur = [], curFiles = new Set(), curLoc = 0;
  const flush = () => { if (cur.length) { batches.push(cur); cur = []; curFiles = new Set(); curLoc = 0; } };
  for (const it of sorted) {
    const newFile = !curFiles.has(it.file);
    const addLoc = newFile ? (it.loc || 200) : 0;
    // Only ever split at a file boundary, so all of one file's issues land in one batch.
    if (cur.length && newFile && (curLoc + addLoc > BATCH_LOC || cur.length >= BATCH_MAX)) flush();
    cur.push(it);
    curFiles.add(it.file);
    curLoc += addLoc;
  }
  flush();
  return batches.map((issues_, i) => ({
    id: `batch-${String(i + 1).padStart(2, '0')}-${slug(area(issues_[0].file))}`,
    issues: issues_,
    loc: [...new Set(issues_.map((x) => x.file))].reduce((s, f) => s + (issues_.find((x) => x.file === f)?.loc || 0), 0),
  }));
}

const batches = buildBatches(open);
log(`batched ${open.length} issue(s) into ${batches.length} batch(es): ${batches.map((b) => `${b.id} (${b.issues.length} issues, ~${b.loc} LOC)`).join('; ')}`);

// One-time baseline prep: fold pre-existing modified tracked files into the staged baseline so each
// batch's UNSTAGED diff is purely that batch's work.
if (A.prepBaseline !== false && batches.length) {
  const base = await agent(baselinePrompt(), roleOpts('scribe', {
    schema: BASELINE_SCHEMA, phase: 'Load', label: 'baseline-prep',
  }));
  log(`baseline: staged ${(base?.staged_files || []).length} pre-existing file(s); ignoring ${(base?.ignored_untracked || []).length} untracked`);
}

const ledger = [];
let halted = false;
let blockerReason = '';

for (const batch of batches) {
  if (halted) break;
  if (budget.total && budget.remaining() < MIN_BATCH_BUDGET) {
    log(`⏸ stopping before ${batch.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minBatchBudget) — resume with the same args to continue`);
    break;
  }

  log(`▶ ${batch.id}: ${batch.issues.length} issue(s) in ${[...new Set(batch.issues.map((i) => i.file))].length} file(s)`);
  const record = { id: batch.id, issues: batch.issues.length, rounds: 0, fixed: 0, stale: 0, failed: 0, demoted: 0, status: 'pending', gates: null, staged: false };
  const handled = [];                 // critic-finding titles already triaged (don't re-report)
  let statusById = new Map(batch.issues.map((i) => [i.id, { status: 'needs-attention', summary: 'not reached' }]));

  let round = 0;
  let repairPlan = null;
  let lastTriage = null;
  while (round < MAX_ROUNDS) {
    round++;
    record.rounds = round;

    phase('Fix');
    const fix = await agent(fixPrompt(batch, round, repairPlan), roleOpts('fix', {
      schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${batch.id} r${round}`,
    }));
    const gateMet = gateOk(fix);
    record.gates = { build: fix?.build_passed ?? null, tests: fix?.test_outcome ?? null };
    for (const r of (fix?.results || [])) {
      if (statusById.has(r.issue_id)) statusById.set(r.issue_id, { status: r.status.toLowerCase() === 'stale' ? 'stale' : r.status.toLowerCase() === 'fixed' ? 'fixed' : 'needs-attention', summary: r.summary || '' });
    }
    const claimedFixed = (fix?.results || []).filter((r) => r.status === 'FIXED')
      .map((r) => batch.issues.find((i) => i.id === r.issue_id)).filter(Boolean);
    const produced = (fix?.results || []).some((r) => r.status === 'FIXED' || r.status === 'FAILED');

    // All-stale batch: nothing changed, nothing to critique or stage.
    if (!produced && gateMet) {
      record.status = 'all-stale';
      log(`  ${batch.id} r${round}: every issue stale (already resolved in current code)`);
      break;
    }

    phase('Critique');
    const critic = await agent(criticPrompt(batch, claimedFixed, handled), roleOpts('critic', {
      schema: CRITIC_SCHEMA, phase: 'Critique', label: `critic:${batch.id} r${round}`,
    }));
    const badChecks = (critic?.fix_checks || []).filter((c) => c.actually_fixed === false);
    const findings = (critic?.findings || []).filter((f) => (SEV_RANK[f.severity] ?? 1) >= SEV_RANK[CRITIC_SEV_NAME]);

    phase('Triage');
    const isLastRound = round >= MAX_ROUNDS;
    const clean = gateMet && badChecks.length === 0 && findings.length === 0;
    const triage = clean
      ? await agent(acceptPrompt(batch, round), roleOpts('critic', {
          schema: TRIAGE_SCHEMA, phase: 'Triage', label: `accept:${batch.id} r${round}`,
        }))
      : await agent(triagePrompt(batch, fix?.results || [], badChecks, findings, round, gateMet, fix?.gate_output || '', isLastRound), roleOpts('fix', {
          schema: TRIAGE_SCHEMA, phase: 'Triage', label: `triage:${batch.id} r${round}`,
        }));
    lastTriage = triage;
    findings.forEach((f) => handled.push(f.title));
    if (triage?.regression_found) record.regression = true;
    for (const id of (triage?.demoted_issues || [])) {
      if (statusById.has(id)) { statusById.set(id, { status: 'demoted', summary: 'needs a user decision — see DECISIONS.md' }); record.demoted++; }
    }

    if (triage?.has_blocker) {
      halted = true;
      blockerReason = triage?.summary || `Blocker raised during ${batch.id} round ${round}.`;
      record.status = 'BLOCKED';
      log(`  ✋ BLOCKER during ${batch.id} r${round} → halting run: ${blockerReason}`);
      break;
    }

    if (triage?.accepted === true) {
      record.status = 'accepted';
      record.staged = triage?.staged === true;
      log(`  ✓ ${batch.id} accepted after ${round} round(s) (staged=${record.staged})`);
      break;
    }

    if (triage?.reverted === true || isLastRound) {
      // Final-round failure: triage restored the baseline; everything non-stale is needs-attention.
      for (const [id, st] of statusById) {
        if (st.status === 'fixed') statusById.set(id, { status: 'needs-attention', summary: `batch reverted on final round: ${triage?.summary || 'unresolved critic findings / gate failure'}` });
      }
      record.status = 'needs-attention (reverted)';
      log(`  ⚠ ${batch.id}: round budget exhausted — batch reverted to baseline, issues marked needs-attention`);
      break;
    }

    repairPlan = (triage?.next_fix_plan && (triage.next_fix_plan.steps || []).length)
      ? triage.next_fix_plan
      : { steps: [...badChecks.map((c) => `Complete the fix for ${c.issue_id}: ${c.note || 'see issues.json'}`), ...findings.map((f) => `Address introduced defect: ${f.title} (${f.file}${f.line ? ':' + f.line : ''}) — ${f.suggested_fix || f.detail}`)] };
    log(`  ↻ ${batch.id} r${round}: gates ${gateMet ? 'green' : 'RED'}, ${badChecks.length} incomplete fix(es), ${findings.length} introduced defect(s) → repair round`);
  }
  if (record.status === 'pending') record.status = 'needs-attention (loop end)';

  // Tally + persist per-issue outcomes (durable; drives resume).
  const perIssue = batch.issues.map((i) => {
    const st = statusById.get(i.id) || { status: 'needs-attention', summary: '' };
    // An issue only counts as fixed if its batch was actually accepted+staged (or all-stale for stale).
    const final = record.status === 'accepted' || record.status === 'all-stale' || st.status === 'demoted'
      ? st.status
      : (st.status === 'stale' ? 'stale' : 'needs-attention');
    return { id: i.id, status: final, batch: batch.id, rounds: record.rounds, summary: st.summary, gates: record.gates };
  });
  record.fixed = perIssue.filter((p) => p.status === 'fixed').length;
  record.stale = perIssue.filter((p) => p.status === 'stale').length;
  record.failed = perIssue.filter((p) => p.status === 'needs-attention').length;

  phase('Record');
  const rec = await agent(batchRecordPrompt(batch, perIssue, lastTriage?.summary || record.status), roleOpts('scribe', {
    schema: RECORD_SCHEMA, phase: 'Record', label: `record:${batch.id}`,
  }));
  record.recorded = rec?.written === true;
  perIssue.forEach((p) => doneById.set(p.id, p.status));
  ledger.push(record);
  log(`  → ${batch.id}: ${record.status} (fixed ${record.fixed}, stale ${record.stale}, needs-attention ${record.failed}, demoted ${record.demoted})`);
}

// ---- Final sweep: only when every in-scope open issue reached a terminal status ----------------
let sweep = null;
const allTerminal = open.every((i) => TERMINAL(doneById.get(i.id)));
if (A.finalSweep !== false && !halted && ledger.length && allTerminal) {
  phase('Sweep');
  const counts = {
    actionable_in_scope: open.length,
    fixed: [...doneById.values()].filter((s) => s === 'fixed').length,
    stale: [...doneById.values()].filter((s) => s === 'stale').length,
    needs_attention: [...doneById.values()].filter((s) => s === 'needs-attention').length,
    demoted: [...doneById.values()].filter((s) => s === 'demoted').length,
  };
  sweep = await agent(sweepPrompt(counts), roleOpts('critic', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  log(sweep?.complete
    ? `sweep: accounting clean (suite: ${sweep?.suite_result || 'n/a'})`
    : `sweep: ${(sweep?.gaps || []).length} gap(s) — see ${STATE_DIR}/SWEEP.md`);
}

return {
  phase: 'resolve',
  runId: RUN_ID,
  halted,
  blockerReason: halted ? blockerReason : '',
  stateDir: STATE_DIR,
  sweep: sweep ? { complete: sweep.complete === true, gaps: (sweep.gaps || []).length, suite: sweep.suite_result || '' } : null,
  summary: {
    batchesProcessed: ledger.length,
    batchesAccepted: ledger.filter((r) => r.status === 'accepted' || r.status === 'all-stale').length,
    issuesFixed: ledger.reduce((s, r) => s + r.fixed, 0),
    issuesStale: ledger.reduce((s, r) => s + r.stale, 0),
    issuesNeedsAttention: ledger.reduce((s, r) => s + r.failed, 0),
    issuesDemoted: ledger.reduce((s, r) => s + r.demoted, 0),
    needsUserOpen: allIssues.filter((i) => i.decision === 'NEEDS_USER').length,
    deferredOpen: allIssues.filter((i) => i.decision === 'DEFER').length,
  },
  ledger,
  followups: halted
    ? `Run halted — ${blockerReason} Fix the cause, then re-invoke with the same args (done issues are skipped).`
    : `Review the staged diff in ${REPO} (git diff --cached), ${STATE_DIR}/LEDGER.md, ${STATE_DIR}/DECISIONS.md${sweep && sweep.complete !== true ? `, and ${STATE_DIR}/SWEEP.md (gaps!)` : ''}. Nothing was committed.`,
};
