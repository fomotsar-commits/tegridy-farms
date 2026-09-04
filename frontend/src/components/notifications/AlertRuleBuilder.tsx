import { useMemo, useState } from 'react';
import {
  ALERT_RULE_KINDS,
  RULE_KIND_LABELS,
  RULE_KIND_MEANING,
  SUBJECT_LABEL,
  SUBJECT_SHAPE,
  THRESHOLD_LABEL,
  describeRule,
  usesThreshold,
  type AlertRule,
  type AlertRuleKind,
} from '../../lib/alerts/rules';
import { ALERT_SOURCES, RULE_SOURCE, evaluableRuleKinds, readinessForRule } from '../../lib/alerts/sources';
import { residentLabelForSubject, residentPools } from '../../lib/alerts/residentPools';
import { ArtCard } from '../ui/ArtCard';

// The rules builder.
//
// It shows the SOURCE of a rule before the rule is created, and whether that
// source is readable on this deployment. A builder that let a user create a rule
// whose source is dark, and only revealed it afterwards as silence, would be
// selling protection it knows it cannot provide. Creation is still allowed — the
// rule is real and will start evaluating the moment the source is wired — but the
// warning is attached to the choice, not to the aftermath.
//
// THE FORM IS NEVER DISABLED. It used to grey itself out whenever the store had a
// problem, which for every visitor meant always. The browser store is always
// writable-or-honest: a write that does not land leaves the rule in the list for
// the session with an amber line above it, which is a state the user can act on,
// unlike a dead form.

interface Props {
  rules: readonly AlertRule[];
  /** How many rules this browser holds. A quota number, not a tier. */
  limit: number;
  writeError: string | null;
  /** Non-null when the last write did not reach storage. Warns; never disables. */
  storeWarning: string | null;
  onAdd: (draft: { kind: AlertRuleKind; subject: string; threshold: string }) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}

/** 44px minimum on every control — the same touch target the rest of the app holds to. */
const CONTROL = 'min-h-11 w-full px-3 py-2 rounded-lg text-white text-[12px]';
const CONTROL_STYLE = { background: '#111', border: '1px solid var(--color-purple-75)' } as const;
const TEXT_BUTTON = 'min-h-11 min-w-11 px-2 text-white/70 text-[11px] underline';

export function AlertRuleBuilder({ rules, limit, writeError, storeWarning, onAdd, onRemove, onToggle }: Props) {
  const [kind, setKind] = useState<AlertRuleKind>('heat-tier');
  const [subject, setSubject] = useState('');
  const [threshold, setThreshold] = useState('');

  const readiness = readinessForRule(kind);
  const source = ALERT_SOURCES[RULE_SOURCE[kind]];

  // Split rather than shortened: a dark kind stays offerable — the rule is real
  // and starts working the moment its source is wired — but it is grouped and
  // labelled as unreadable at the moment of CHOOSING, which is the only moment
  // the user can act on it.
  const { evaluable, dark } = useMemo(() => {
    const readable = new Set(evaluableRuleKinds());
    return {
      evaluable: ALERT_RULE_KINDS.filter((k) => readable.has(k)),
      dark: ALERT_RULE_KINDS.filter((k) => !readable.has(k)),
    };
  }, []);

  const residents = useMemo(() => residentPools(), []);

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: 'transparent' }}
      aria-label="Alert rules"
    >
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-white text-[13px] font-medium">Alert rules</h3>
        <span className="text-white/50 text-[11px]">
          Saved in this browser — {rules.length} of {limit}
        </span>
      </div>
      <p className="mt-1 text-white/45 text-[11px] leading-snug">
        Rules live in this browser’s storage. They are not tied to a wallet and do not follow you to another device.
      </p>

      {storeWarning && (
        <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
          {storeWarning}
        </p>
      )}

      {residents.length > 0 && (
        <ArtCard pageId="alerts" idx={1} className="mt-3" padding="p-3">
          <p id="resident-pick-label" className="text-white/55 text-[11px]">
            Watch an island resident
          </p>
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-labelledby="resident-pick-label">
            {residents.map((resident) => (
              <button
                key={resident.id}
                type="button"
                // Fills the subject in the canonical `network:pool` form so nobody
                // hand-types a base58 pool id — the step where a Solana subject
                // gets a character wrong and the rule silently watches nothing.
                onClick={() => {
                  setSubject(resident.subject);
                  setKind('pool-price-above');
                }}
                className="min-h-11 px-3 rounded-lg text-[11px] text-white/80"
                style={{ background: '#111', border: '1px solid var(--color-purple-75)' }}
              >
                {resident.symbol} — {resident.label}
              </button>
            ))}
          </div>
        </ArtCard>
      )}

      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="sr-only">Rule type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AlertRuleKind)}
            className={CONTROL}
            style={CONTROL_STYLE}
          >
            <optgroup label="Readable on this deployment">
              {evaluable.map((k) => (
                <option key={k} value={k}>
                  {RULE_KIND_LABELS[k]}
                </option>
              ))}
            </optgroup>
            {dark.length > 0 && (
              <optgroup label="Cannot evaluate here yet">
                {dark.map((k) => (
                  <option key={k} value={k}>
                    {RULE_KIND_LABELS[k]} — not readable here
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <p className="text-white/60 text-[11px] leading-snug">{RULE_KIND_MEANING[kind]}</p>

        <p className="text-white/45 text-[11px] leading-snug">Reads: {source.attribution}.</p>

        {/* The whole point of this block: a dark source is disclosed at the moment
            the rule is chosen, not discovered later as an empty inbox. */}
        {!readiness.readable && readiness.detail && (
          <p className="text-[11px] leading-snug" style={{ color: '#FFD37C' }}>
            {readiness.detail} A rule of this type can be saved, but it will report
            “cannot evaluate” until the source is readable — it will not report calm.
          </p>
        )}

        <label className="block">
          <span className="sr-only">{SUBJECT_LABEL[kind]}</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={SUBJECT_SHAPE[kind] === 'pool' ? 'eth:0x… · base:0x… · solana:<pool id>' : SUBJECT_LABEL[kind]}
            // Autocorrect and capitalisation are OFF because a Solana pool id is
            // base58 and case-sensitive: a helpfully capitalised first letter is a
            // different pool, or no pool at all.
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="text"
            className={CONTROL}
            style={CONTROL_STYLE}
          />
        </label>

        {usesThreshold(kind) && (
          <label className="block">
            {/* Per-kind, because the kinds do not share a unit: a box hard-labelled
                "USD threshold" over a field that means hours creates a rule that
                fires at the wrong time, or never. */}
            <span className="sr-only">{THRESHOLD_LABEL[kind]}</span>
            <input
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder={THRESHOLD_LABEL[kind] ?? ''}
              inputMode="decimal"
              className={CONTROL}
              style={CONTROL_STYLE}
            />
          </label>
        )}

        <button
          type="button"
          onClick={() => {
            onAdd({ kind, subject, threshold });
            setSubject('');
            setThreshold('');
          }}
          className="min-h-11 px-4 rounded-lg text-[12px] text-white"
          style={{ background: 'var(--color-purple-80)' }}
        >
          Add rule
        </button>

        {writeError && (
          <p className="text-[11px] leading-snug" style={{ color: '#FF9C9C' }} role="alert">
            {writeError}
          </p>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {rules.map((rule) => {
          const ruleReadiness = readinessForRule(rule.kind);
          const resident = residentLabelForSubject(rule.subject);
          return (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-2 py-2"
              style={{ borderTop: '1px solid var(--color-purple-75)' }}
            >
              <div className="min-w-0">
                <p className="text-white text-[12px] truncate">{describeRule(rule)}</p>
                <p className="text-white/45 text-[11px]">
                  {resident && `${resident} · `}
                  {ALERT_SOURCES[RULE_SOURCE[rule.kind]].label}
                  {!ruleReadiness.readable && ' — source not readable here'}
                  {!rule.enabled && ' — off'}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" onClick={() => onToggle(rule.id, !rule.enabled)} className={TEXT_BUTTON}>
                  {rule.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button type="button" onClick={() => onRemove(rule.id)} className={TEXT_BUTTON}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default AlertRuleBuilder;
