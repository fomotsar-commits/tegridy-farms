import { useState } from 'react';
import {
  ALERT_RULE_KINDS,
  RULE_KIND_LABELS,
  RULE_KIND_MEANING,
  SUBJECT_LABEL,
  THRESHOLD_LABEL,
  describeRule,
  usesThreshold,
  type AlertRule,
  type AlertRuleKind,
} from '../../lib/alerts/rules';
import { ALERT_SOURCES, RULE_SOURCE, readinessForRule } from '../../lib/alerts/sources';

// The rules builder.
//
// It shows the SOURCE of a rule before the rule is created, and whether that
// source is readable on this deployment. A builder that let a user create a rule
// whose source is dark, and only revealed it afterwards as silence, would be
// selling protection it knows it cannot provide. Creation is still allowed — the
// rule is real and will start evaluating the moment the source is wired — but the
// warning is attached to the choice, not to the aftermath.

interface Props {
  rules: readonly AlertRule[];
  limit: number;
  hasPremium: boolean;
  busy: boolean;
  writeError: string | null;
  /** Non-null disables the form and explains why the store is unusable. */
  storeProblem: string | null;
  onAdd: (draft: { kind: AlertRuleKind; subject: string; threshold: string }) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}

export function AlertRuleBuilder({
  rules,
  limit,
  hasPremium,
  busy,
  writeError,
  storeProblem,
  onAdd,
  onRemove,
  onToggle,
}: Props) {
  const [kind, setKind] = useState<AlertRuleKind>('heat-tier');
  const [subject, setSubject] = useState('');
  const [threshold, setThreshold] = useState('');

  const readiness = readinessForRule(kind);
  const source = ALERT_SOURCES[RULE_SOURCE[kind]];
  const disabled = busy || storeProblem !== null;

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Alert rules"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-white text-[13px] font-medium">Alert rules</h3>
        <span className="text-white/50 text-[11px]">
          {rules.length} of {limit}
          {hasPremium ? ' (premium)' : ' (free tier)'}
        </span>
      </div>

      {storeProblem && (
        <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="status">
          {storeProblem}
        </p>
      )}

      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="sr-only">Rule type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AlertRuleKind)}
            disabled={disabled}
            className="w-full px-2 py-1 rounded-lg text-white text-[12px]"
            style={{ background: '#111', border: '1px solid var(--color-purple-75)' }}
          >
            {ALERT_RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {RULE_KIND_LABELS[k]}
              </option>
            ))}
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
            placeholder={SUBJECT_LABEL[kind]}
            disabled={disabled}
            className="w-full px-2 py-1 rounded-lg text-white text-[12px]"
            style={{ background: '#111', border: '1px solid var(--color-purple-75)' }}
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
              disabled={disabled}
              className="w-full px-2 py-1 rounded-lg text-white text-[12px]"
              style={{ background: '#111', border: '1px solid var(--color-purple-75)' }}
            />
          </label>
        )}

        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onAdd({ kind, subject, threshold });
            setSubject('');
            setThreshold('');
          }}
          className="px-3 py-1 rounded-lg text-[12px] text-white disabled:opacity-40"
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
          return (
            <li
              key={rule.id}
              className="flex items-start justify-between gap-2 py-2"
              style={{ borderTop: '1px solid var(--color-purple-75)' }}
            >
              <div className="min-w-0">
                <p className="text-white text-[12px] truncate">{describeRule(rule)}</p>
                <p className="text-white/45 text-[11px]">
                  {ALERT_SOURCES[RULE_SOURCE[rule.kind]].label}
                  {!ruleReadiness.readable && ' — source not readable here'}
                  {!rule.enabled && ' — off'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onToggle(rule.id, !rule.enabled)}
                  disabled={busy}
                  className="text-white/70 text-[11px] underline disabled:opacity-40"
                >
                  {rule.enabled ? 'Turn off' : 'Turn on'}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(rule.id)}
                  disabled={busy}
                  className="text-white/70 text-[11px] underline disabled:opacity-40"
                >
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
