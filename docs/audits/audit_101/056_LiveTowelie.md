# Audit 056 — LiveActivity / Towelie Assistant Surfaces

**Agent:** 056 / 101 (forensic, AUDIT-ONLY)
**Date:** 2026-04-25
**Scope:** Live activity widget + Towelie assistant + knowledge base

## Files in scope

- `frontend/src/components/LiveActivity.tsx` (60 LOC)
- `frontend/src/components/TowelieAssistant.tsx` (395 LOC)
- `frontend/src/hooks/useTowelie.ts` (101 LOC)
- `frontend/src/lib/towelieKnowledge.ts` (371 LOC)
- `frontend/src/hooks/useToweliePrice.ts` — **DOES NOT EXIST**
  - The equivalent surface is `useTOWELIPrice` exported from `frontend/src/contexts/PriceContext.tsx` (consumed by `LiveActivity` line 3 and many pages).
  - `LiveActivity` also uses `frontend/src/hooks/usePriceHistory.ts` for sparkline data — included in scope as the closest matching artifact.

---

## Threat-model checklist results

| Hunt target | Status | Notes |
|---|---|---|
| WebSocket / EventSource listeners not torn down | **NEGATIVE** | No `WebSocket`, `EventSource`, or socket.io references in any of these files. All listeners are DOM event listeners and properly torn down. |
| Reconnect storms on flaky network | **N/A** | No socket reconnect logic. `usePriceHistory` does HTTP fetch with capped retries (`MAX_RETRIES=2`, exponential backoff `1s → 2s`), bounded — not a storm vector. |
| `JSON.parse` without try/catch (assistant crash) | **NEGATIVE within scope** | `TowelieAssistant.tsx`: every `localStorage.getItem`/`setItem` is wrapped in try/catch (lines 116, 154, 158, 253). `useTowelie.ts`: no JSON.parse. `towelieKnowledge.ts`: no JSON.parse. `usePriceHistory.ts` line 32: `JSON.parse(cached)` IS wrapped in `try {} catch {}` (lines 29-44). Clean. |
| Prompt-injection in `towelieKnowledge.ts` | **NEGATIVE** | This is a static, hard-coded keyword-overlap matcher. **No LLM is invoked.** No user input is fed into any model context. The "answer" is selected from a fixed `KNOWLEDGE_BASE` array and returned verbatim. Prompt-injection is structurally impossible here. |
| API key (OpenAI/Anthropic) referenced client-side | **NEGATIVE** | No `OPENAI_`, `ANTHROPIC_`, `import.meta.env.VITE_*_KEY`, `Bearer`, or `Authorization` references in any of these files. Towelie does not call any LLM provider — it is a deterministic pattern-matcher. |
| Unsanitized markdown rendering of LLM output | **NEGATIVE** | No `dangerouslySetInnerHTML`, no `react-markdown`, no `marked`, no `DOMPurify`. Bubble text is rendered as plain React text node (`TowelieAssistant.tsx` line 318: `{typedText \|\| ' '}`). React auto-escapes — XSS not reachable here. |
| CSP violations from inline event handlers | **NEGATIVE** | All event handlers are JSX prop handlers (`onClick`, `onSubmit`, `onChange`) compiled to `addEventListener`-style bindings by React. No inline `onclick="..."` HTML attribute strings, no `style="..."` injection of user content (style objects are static literals or controlled by React). |
| Message ordering / dedup | **PRESENT, mostly correct** | `useTowelie.ts` implements priority-based queue (`urgent` → unshift, `info`/`flavor` → push, `MAX_QUEUE=5`, dedup by optional `key`). One MEDIUM concern below. |
| WebSocket origin/auth | **N/A** | No WebSocket. `usePriceHistory` fetches from `api.geckoterminal.com` over HTTPS, no auth header (public endpoint), no credentials sent — appropriate for the use case. |

**Net finding:** The advertised threat surface (LLM, websocket, prompt-injection) does not exist in this code. Towelie is a static keyword bot, LiveActivity is a fixed-position presentational widget, and the price hook is a polled REST fetch. Most of the audit-checklist hits are clean by construction.

That said, several real (lower-severity) issues did surface during the read:

---

## FINDINGS

### F-056-01 — MEDIUM — Stale-closure / missing-dep in `TowelieAssistant` queue effect

**File:** `frontend/src/components/TowelieAssistant.tsx`
**Lines:** 167-179

```ts
useEffect(() => {
  if (disabled || queue.length === 0) return;
  const next = queue[0]!;
  const isUrgent = next.priority === 'urgent';
  if (!isUrgent) {
    if (bubble) return;
    if (Date.now() < snoozedUntil.current) return;
    if (Date.now() - lastEventAt.current < EVENT_COOLDOWN_MS) return;
  }
  lastEventAt.current = Date.now();
  currentApiId.current = next.id;
  setBubble({ text: next.text, src: 'api' });
}, [queue, bubble, disabled]);
```

**Issue:** This effect depends on `queue` from `useToweliQueueInternal()` and on `bubble` (component state). When a new info-priority message lands while a bubble is already shown, the effect early-returns at `if (bubble) return;`. The next time `queue` changes or `bubble` clears, the effect re-runs and consumes `queue[0]` — **but `consume(id)` is never called** in this effect. Only `dismissBubble` (line 230) calls `consume`. If a `queue[0]` message is rendered as a bubble and the user clicks the avatar / a route changes / another path overrides `bubble` without going through `dismissBubble`, the consumed queue head is **never removed**, so the next render of the effect re-fires with the same `queue[0]` and **re-shows the same message** indefinitely.

Specifically, `submitQuestion` (line 268) and `handleAvatarClick` (line 256) both `setBubble(...)` to a non-API source without calling `consume(currentApiId.current)`, leaking the API message handle.

**Impact:** Towelie can re-pop the same urgent message in a loop after user clicks through, or fail to advance past a stuck head-of-queue message. UX bug bordering on a soft-DoS for the assistant.

**Recommendation:** When `setBubble` is called with `src !== 'api'` while `currentApiId.current` is non-null, consume the previous API id first. Or move the `consume` call into the queue effect itself once the message has been pushed to the bubble state.

---

### F-056-02 — LOW — Potentially unbounded `dismissTimes.current` array growth in pathological case

**File:** `frontend/src/components/TowelieAssistant.tsx`
**Lines:** 242-247

```ts
dismissTimes.current = [...dismissTimes.current, now].filter((t) => now - t < FATIGUE_WINDOW_MS);
if (dismissTimes.current.length >= FATIGUE_THRESHOLD) {
  snoozedUntil.current = now + FATIGUE_SNOOZE_MS;
  dismissTimes.current = [];
}
```

**Issue:** `dismissTimes` is filtered to a 5-minute window on every dismiss, then truncated when threshold is reached, so growth is in practice bounded by `FATIGUE_THRESHOLD = 3`. **Not a real leak.** Listed for completeness — the prior copy of this file in worktrees may have lacked the threshold reset; this one is fine.

**Impact:** None in current implementation.

**Recommendation:** None required.

---

### F-056-03 — LOW — Idle-timer effect re-attaches global listeners on every `disabled`/`canShow` change

**File:** `frontend/src/components/TowelieAssistant.tsx`
**Lines:** 209-226

```ts
useEffect(() => {
  if (disabled) return;
  const reset = () => { /* … */ };
  reset();
  const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'touchstart', 'scroll'];
  events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
  return () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    events.forEach((e) => window.removeEventListener(e, reset));
  };
}, [disabled, canShow]);
```

**Issue:** `canShow` is a `useCallback` on `[disabled]` — stable while `disabled` doesn't change — so the effect only re-runs on `disabled` toggle in practice. **However** the effect closes over `canShow` via the `setBubble({ text: pick(COPY.idle), src: 'idle' })` path inside `setTimeout`, but the dependency on `canShow` *would* re-fire if the dep array were broader. Currently safe, but fragile. Listeners are torn down correctly on unmount and on `disabled` toggle. No leak.

**Impact:** Negligible. Brief listener thrash on disable toggle.

**Recommendation:** Consider depending on `disabled` only and reading `canShow()` via a ref, to avoid future regressions if more state is added to the dep array.

---

### F-056-04 — LOW — `useTypewriter` uses `setInterval` + `cancelled` flag that is redundant with `clearInterval`

**File:** `frontend/src/components/TowelieAssistant.tsx`
**Lines:** 54-69

```ts
function useTypewriter(text: string | undefined, charMs = 18): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!text) { setShown(''); return; }
    let cancelled = false;
    setShown('');
    let i = 0;
    const id = setInterval(() => {
      if (cancelled) { clearInterval(id); return; }
      i++;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, charMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [text, charMs]);
  return shown;
}
```

**Issue:** Cleanup runs `clearInterval(id)` AND sets `cancelled = true`. The `cancelled` flag is defensive against the rare race where the interval callback was already queued by the JS event loop before `clearInterval` took effect — in practice browsers will not fire a cleared interval, but the belt-and-suspenders is fine. **No leak.** Listed because comment claims memory-leak protection, which is technically not the issue the flag protects against (it protects against `setShown` after unmount, not from a leak).

**Impact:** None.

**Recommendation:** None — comment slightly misleading but code is correct.

---

### F-056-05 — INFO — `usePriceHistory.ts` retry loop blocks effect cleanup during backoff

**File:** `frontend/src/hooks/usePriceHistory.ts`
**Lines:** 89-94

```ts
} catch (e) {
  retryCount.current++;
  if (retryCount.current <= MAX_RETRIES) {
    const delay = BASE_DELAY * Math.pow(2, retryCount.current - 1);
    await new Promise((r) => setTimeout(r, delay));
    if (cancelled) return;
  }
}
```

**Issue:** During the `await new Promise((r) => setTimeout(r, delay))` the component may unmount. The `cancelled` flag is checked AFTER the sleep, so the resolve fires, then `cancelled` is true, then `return`. Correct. But the `setTimeout` itself is not cleared via `abortController` — minor (300-2700ms of dangling timer per unmounted component). On a route-thrash scenario this could pile up briefly. Not a real leak; timer self-completes.

**Impact:** Negligible.

**Recommendation:** Wrap the sleep in a cancellable timer (`Promise.race` against the abort signal) for cleanliness. Not required.

---

### F-056-06 — INFO — Public GeckoTerminal endpoint exposes app fingerprint via Referer

**File:** `frontend/src/hooks/usePriceHistory.ts`
**Line:** 56-60

```ts
const url = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${TOWELI_WETH_LP_ADDRESS}/ohlcv/hour?aggregate=1&limit=24`;
const res = await fetch(url, {
  headers: { Accept: 'application/json' },
  signal: abortController.signal,
});
```

**Issue:** Browser sends Origin/Referer to GeckoTerminal, which fingerprints the app + visiting wallet IP. Not a security issue per se, but the endpoint URL contains `TOWELI_WETH_LP_ADDRESS` which deanonymizes that the visitor is on Tegridy Farms specifically.

**Impact:** Privacy / fingerprinting only. Not exploitable.

**Recommendation:** None. Standard for any DEX frontend.

---

### F-056-07 — INFO — `MAX_QUEUE = 5` in `useTowelie.ts` is a soft cap that drops `flavor` messages silently

**File:** `frontend/src/hooks/useTowelie.ts`
**Lines:** 37, 49-55

```ts
const MAX_QUEUE = 5;
// …
if (next.length >= MAX_QUEUE) {
  if (priority === 'flavor') return prev;
  const dropIdx = next.findIndex((m) => m.priority !== 'urgent');
  if (dropIdx !== -1) next.splice(dropIdx, 1);
  else if (priority !== 'urgent') return prev;
}
```

**Issue:** Correct DoS-prevention design — caller cannot push unbounded `say()` messages. Urgent messages always make it in (replacing oldest non-urgent), info messages drop oldest non-urgent, flavor drops self. **This is good.**

**Impact:** None — defensive.

**Recommendation:** None.

---

### F-056-08 — INFO — Static knowledge base is the right architecture decision

**File:** `frontend/src/lib/towelieKnowledge.ts`

The choice to use a hand-curated `KNOWLEDGE_BASE` array with deterministic keyword scoring **eliminates entire classes of vulnerabilities** that an LLM-backed assistant would otherwise introduce:

- No prompt-injection surface (no model context to inject into)
- No API key on client (no provider call)
- No rate-limit / cost-DoS surface
- No hallucination liability for compliance-sensitive answers (yield, lock, liquidation)
- No PII leakage to a third-party model provider
- Deterministic — auditable, testable, reproducible

The only LLM-adjacent risk left would be if an answer string itself were ever rendered as HTML/markdown, but `TowelieAssistant.tsx` line 318 renders it as a plain text node.

**Impact:** Strongly positive design choice.

**Recommendation:** Keep it. Resist any future PR that tries to bolt OpenAI/Anthropic onto this surface — it would invalidate the entire class of guarantees above.

---

### F-056-09 — INFO — `LiveActivity.tsx` is presentation-only, no event listeners

**File:** `frontend/src/components/LiveActivity.tsx`

Single `useEffect` with a `setTimeout` (cleared on unmount). No fetches, no sockets, no external input. Minimal attack surface. Note: this component is `hidden md:block` (mobile hidden), `pointerEvents: none`, `aria-live="polite"`. Clean.

---

### F-056-10 — INFO — `useToweliePrice.ts` does not exist

**Specified target file:** `frontend/src/hooks/useToweliePrice.ts`

Glob search returned no match. The price hook is implemented as a React Context provider:
- `frontend/src/contexts/PriceContext.tsx` exports `useTOWELIPrice` (uppercase TOWELI)

Recommend the audit roster correct the file path. The functional equivalent (`useTOWELIPrice` from `PriceContext`) was reviewed by other agents per the gitStatus of `.audit_findings.md`.

---

## SUMMARY

- **HIGH:** 0
- **MEDIUM:** 1 (F-056-01: stale-closure consume-leak in queue effect)
- **LOW:** 3 (F-056-02, F-056-03, F-056-04 — defensive-only / fragile but correct)
- **INFO:** 6 (F-056-05, -06, -07, -08, -09, -10)

**Top-3 actionable:**
1. **F-056-01 MED** — `TowelieAssistant.tsx:268` and `:256`: when overwriting `bubble` with a non-API src while an API id is held, `consume(currentApiId.current)` is not called. API messages can re-pop or stick at queue head.
2. **F-056-10 INFO** — `useToweliePrice.ts` does not exist; correct the audit roster's file path. The actual hook is `useTOWELIPrice` in `contexts/PriceContext.tsx`.
3. **F-056-08 INFO (positive)** — Towelie's static keyword-bot architecture **eliminates** the entire prompt-injection / API-key / model-cost / PII surface the audit checklist was hunting for. This is the correct architecture; preserve it.

**Threat-checklist results:** 0 confirmed websocket leaks, 0 reconnect-storm vectors, 0 unguarded `JSON.parse`, 0 prompt-injection surfaces, 0 client-side LLM API keys, 0 unsanitized markdown renders, 0 inline-handler CSP violations. The advertised attack surface does not exist in this code.
