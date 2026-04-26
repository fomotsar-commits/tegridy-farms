# RC9 — Revert Diagnosis

## Smoking Gun
`git reflog` shows **20 `reset: moving to HEAD` events on 2026-04-26 alone**, all snapping working tree back to `0b22479` (the pre-recovery commit). Pattern from earliest:

```
0b22479 HEAD@{2026-04-26 00:14:40}: reset: moving to HEAD
... (18 more) ...
0b22479 HEAD@{2026-04-26 12:57:42}: reset: moving to HEAD
9b59e21 HEAD@{2026-04-26 13:45:35}: commit: 101-agent bulletproofing campaign
```

These are `git reset --hard HEAD` operations — they wipe unstaged + staged tracked-file edits but leave untracked files (which is why `RC2.md` and `.spartan_unpacked/` survive while modified `*.sol` / `*.tsx` revert).

## Source

Not in-repo. Verified clean:
- `.git/hooks/` — only `*.sample` files (inert)
- `.git/config` — no auto-reset hooks; `hooksPath` points to default
- `.github/workflows/` — no `reset --hard` / `restore` references
- `frontend/vite.config.ts` — `art-studio-save` middleware only writes `src/lib/artOverrides.ts`, never resets
- `frontend/scripts/`, `package.json` scripts — clean
- `.husky/` — does not exist
- No in-repo `.mjs/.js/.sh/.ps1` contains `git reset --hard`

The resets correlate with **Claude Code harness worktree lifecycle**: 14 locked worktrees under `.claude/worktrees/agent-*` plus `EnterWorktree`/`ExitWorktree`/`TaskStop` deferred tools. When a sub-agent task is killed/exited mid-flight, the harness `git reset --hard HEAD`s the parent working tree to a clean state. R077's "background watcher silently reverted" matches this exactly — concurrent sub-agent exit fired during the edit window.

## How To Disable

Cannot be disabled from inside the repo — it is harness behavior, not project config. The only mitigation levers:
1. Stop spawning concurrent sub-agents during the recovery window (no `EnterWorktree`, no `TaskStop` on running tasks).
2. Avoid the gap: edit + `git add` + `git commit` in a single uninterrupted tool sequence so resets find nothing to revert.
3. Lock unrelated worktrees (already done — 9 of 14 are `locked`).

## Recommended Mitigation (No Smoking-Gun Fix)

**Apply changes in the same sequence as the commit, no gap.** For each R-fix:
1. `Edit` / `Write` file
2. Immediately `git add <specific paths>` (do not use `-A`)
3. Immediately `git commit -m "..."` (heredoc)
4. Only then move to next fix

Once committed, `reset --hard HEAD` becomes a no-op (HEAD is the new commit). Today's commit `9b59e21` survived because it was committed before the next reset fired.

**Do not** rely on staged-only or working-tree-only state across tool calls during recovery. **Do not** spawn additional concurrent sub-agents until recovery commit lands. If a batch is large, commit in slices (per-file or per-fix) rather than one giant final commit, so partial progress survives any mid-flight reset.

## Pause-ability

No clean pause. Best proxy: serialize the recovery into a single agent thread with edit-then-commit pairs and zero `TaskStop`/worktree churn until the recovery commit is on `main`.
