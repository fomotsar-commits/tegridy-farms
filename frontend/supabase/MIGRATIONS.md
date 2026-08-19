# The migration ledger, and why there isn't one

**Nothing here is applied.** This file describes a problem, names the smallest
fix that makes it stop recurring, and gives the SQL. An operator applies it or
does not.

---

## The state today

Every migration in `supabase/migrations/` is pasted into the Supabase SQL
editor by hand. Nothing records that it happened. Three consequences, all of
which have already occurred:

**1. "Has it been applied?" is unanswerable.** The honest answer for most files
is *probably, in some form, possibly partially*. `014`'s header had to
establish that `siwe_nonces` was missing by observing PostgREST return
`PGRST205` in production — a live probe, because the repo could not say.
`015`'s header had to read `pg_policies` out of the live database to discover
that two generations of policy were coexisting. That is forensic work standing
in for a lookup.

**2. Files get re-run, so every file must be idempotent.** This is already the
house rule — `014` and `015` state it in their headers — and it is a good rule,
but it is load-bearing rather than belt-and-braces. `004` is not safely
re-runnable against live, and its header says migrations are append-only while
the runbook says never apply it as a unit. Those are the same file disagreeing
with itself because nobody can tell what state it is in.

**3. Two files can share a number, and one of them silently never lands.**
On **2026-08-19** two independent slices each wrote a `016`; the API one was
renumbered to `017` by hand. The failure mode if it had not been caught: apply
one, note "016 done", and the other is never applied by anyone, ever. An
earlier instance is still visible in the tree — `010_reaction_auth_hardening.sql`
opens with *"renumbered from 005 to resolve a duplicate-005 collision"*. Twice
is a pattern.

---

## The smallest durable fix

Not the Supabase CLI. `supabase db push` applies files in **filename order**,
and filename order here runs `014` before `015`, which by 015's own analysis
publishes every user's favourites, watchlist, profile and votes to anyone
holding the anon key. Adopting a lexical runner would automate the one mistake
the repo has spent three files warning about. It is the right destination
eventually; it is not the next step, and it is not small.

The fix is two pieces, neither of which changes how migrations are applied:

### 1. A ledger table that each file writes itself into

Already committed, as `§0` of `000_base_schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text,
  note        text
);
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.schema_migrations FROM anon, authenticated;
GRANT ALL ON public.schema_migrations TO service_role;
DROP POLICY IF EXISTS "Service role only" ON public.schema_migrations;
CREATE POLICY "Service role only" ON public.schema_migrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

Those nine statements are safe to run standalone against the **live** database:
they create one table and touch nothing else. That is the whole operator step.

Every migration then ends with its own record:

```sql
INSERT INTO public.schema_migrations (filename, note)
VALUES ('016_alert_rules.sql', NULL)
ON CONFLICT (filename) DO NOTHING;
```

The insert lives **inside the file being pasted**, which is the point. An
operator cannot forget to record a migration, because recording it is part of
the thing they pasted. `ON CONFLICT DO NOTHING` keeps re-runs safe and
preserves the first `applied_at`, which is the date you actually want.

Backfilling the ledger for what is already live is a judgement call, not a
lookup, so do not guess: insert only the files you can positively confirm
landed, with `note` saying how you confirmed it. A ledger row that says
"applied" because someone assumed so is worse than a missing row — a missing
row prompts a check, and a wrong row ends one.

**What this deliberately is not:** it does not refuse to run a file twice, does
not order anything, and does not verify that a file's effects are present. It
records. Idempotency stays each file's own job, and the ordering constraints
stay in `RESTORE.md` where they can be explained. A ledger that pretended to
enforce order would have to encode "015 before 014", and a tool that encodes
that is a tool someone will trust to also encode the next one.

### 2. A check that fails on a duplicate number

Already committed, in `scripts/supabase-restore.test.mjs` — it runs in the
normal `npx vitest run` suite:

- every migration filename matches `NNN_name.sql`
- no two files share the `NNN`

That is the piece the 2026-08-19 collision needed. It costs nothing, runs on
every push, and turns a silent never-applied migration into a red test the
author sees before merge.

---

## Allocating a number

Until the ledger has a few rows in it, the collision risk is highest in exactly
the situation that produced it: two authors working the same day. Two habits
remove it without any tooling:

1. **Claim the number by creating the file first**, empty except for its
   header, before writing the body. An empty `019_foo.sql` in the tree is a
   claim another author can see; a number in your head is not.
2. **Renumber the later file, never the earlier one**, and only before either
   has been applied. Once a file is in `schema_migrations` its name is its
   identity and renaming it makes the ledger lie.

If you find two files sharing a number and cannot tell which was applied, treat
**both** as unapplied and check their effects directly against the database —
that is the state the ledger exists to make impossible, and guessing your way
out of it is how it becomes permanent.
