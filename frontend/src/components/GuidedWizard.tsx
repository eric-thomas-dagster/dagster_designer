import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, KeyRound, SlidersHorizontal } from 'lucide-react';
import { prettifyFieldName } from '@/lib/genericFields';
import {
  envVarReference,
  isSecretField,
  missingRequired,
  optionsFor,
  selectedOptions,
  toggleOption,
  type FieldEntry,
} from '@/lib/ingestionWizard';
import type { WizardGroup, WizardStepDef } from '@/lib/wizardTypes';

export interface GuidedWizardProps {
  componentType: string;
  /** "Shopify" -- shown as "Connect to Shopify" on a step titled "Connect" when `titleSuffix` is set. */
  displayName: string;
  properties: Record<string, any>;
  required: string[];
  formData: Record<string, any>;
  onFieldChange: (field: string, value: any) => void;
  /** The modal's own field renderer (label + description + the right widget for the field). */
  renderEntry: (name: string, schema: any) => ReactNode;
  steps: WizardStepDef[];
  /** Optional, rarely-needed settings tucked under the review step. */
  moreGroups: WizardGroup[];
  /** Extra per-step problems beyond schema-required fields (either/or rules, conditional requirements). */
  stepErrors?: (stepKey: string, values: Record<string, any>) => string[];
  /** A short note under a field (e.g. what a connection URL looks like for the chosen database). */
  fieldNote?: (name: string, values: Record<string, any>) => string | null;
  onFinish: () => void;
  onAdvanced: () => void;
  onCancel: () => void;
  isDraft: boolean;
}

function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function summarize(name: string, schema: any, value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  // Show an env-var reference as typed; never echo a literal secret.
  if (isSecretField(name, schema) && !/^\$\{.+\}$/.test(s)) return '•'.repeat(Math.min(s.length, 12));
  return s;
}

const REVIEW_BLURB = 'Check the essentials. The optional settings below are rarely needed.';

export function GuidedWizard({
  componentType,  properties, required, formData, onFieldChange, renderEntry, steps: stepDefs, moreGroups,
  stepErrors, fieldNote, onFinish, onAdvanced, onCancel, isDraft,
}: GuidedWizardProps) {
  // Steps with nothing to ask are skipped; the review step always closes the flow.
  const stepList = useMemo(() => stepDefs.filter((d) => d.entries.length > 0), [stepDefs]);
  const steps = useMemo<string[]>(() => [...stepList.map((d) => d.key), 'review'], [stepList]);
  const defFor = (k: string) => stepList.find((d) => d.key === k);

  const [stepIdx, setStepIdx] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const step = steps[stepIdx];

  const stepEntries = (k: string): FieldEntry[] => defFor(k)?.entries ?? [];

  // A field the user hasn't touched may still carry a schema default; count it as filled.
  const values = useMemo(() => {
    const v: Record<string, any> = { ...formData };
    for (const [n, s] of Object.entries(properties)) {
      if (!isFilled(v[n]) && s && s.default !== null && s.default !== undefined) v[n] = s.default;
    }
    return v;
  }, [formData, properties]);

  const missingFor = (k: string): string[] => missingRequired(stepEntries(k), required, values);
  const problemsFor = (k: string): string[] => (k === 'review' ? [] : stepErrors?.(k, values) ?? []);
  const blocked = (k: string): boolean => missingFor(k).length > 0 || problemsFor(k).length > 0;
  const allMissing = steps.flatMap((k) => (k === 'review' ? [] : missingFor(k)));
  const allProblems = steps.flatMap((k) => problemsFor(k));

  const next = () => {
    if (blocked(step)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  };

  const finish = () => {
    if (allMissing.length > 0 || allProblems.length > 0) {
      // Jump to the first step that still needs something.
      const first = steps.find((k) => k !== 'review' && blocked(k));
      if (first) {
        setStepIdx(steps.indexOf(first));
        setShowErrors(true);
      }
      return;
    }
    onFinish();
  };

  const renderOne = ({ name, schema }: FieldEntry) => {
    const options = optionsFor(schema);
    const chosen = selectedOptions(formData[name]);
    const secret = isSecretField(name, schema) && schema?.type !== 'boolean';
    const missing = showErrors && missingFor(step).includes(name);
    const note = fieldNote?.(name, values) ?? null;
    return (
      <div key={name} className={missing ? 'rounded-md ring-1 ring-red-300 p-2 -m-2' : undefined}>
        {renderEntry(name, schema)}
        {options.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${prettifyFieldName(name)} options`}>
            {options.map((o) => {
              const on = chosen.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => onFieldChange(name, toggleOption(formData[name], o, schema?.type))}
                  className={`px-2 py-0.5 text-xs rounded-full border ${
                    on ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {on && <Check className="inline w-3 h-3 mr-0.5 -mt-0.5" />}
                  {o}
                </button>
              );
            })}
          </div>
        )}
        {secret && (
          <button
            type="button"
            onClick={() => onFieldChange(name, envVarReference(componentType, name))}
            className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-700"
            title="Store the secret in an environment variable instead of in the project files"
          >
            <KeyRound className="w-3 h-3" /> Read it from an environment variable instead
          </button>
        )}
        {note && <p className="text-xs text-gray-500 mt-1">{note}</p>}
        {missing && <p className="text-xs text-red-600 mt-1">Required</p>}
      </div>
    );
  };

  const summaryRows = stepList.flatMap((d) => d.entries).filter(
    (e) => isFilled(values[e.name]) && typeof values[e.name] !== 'boolean',
  );

  const activeMore = moreGroups.filter((g) => g.entries.length > 0);

  return (
    <div className="space-y-5">
      <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
        {steps.map((k, i) => (
          <li key={k} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => i < stepIdx && setStepIdx(i)}
              disabled={i > stepIdx}
              className={`flex items-center gap-1.5 ${i === stepIdx ? 'text-blue-700 font-semibold' : i < stepIdx ? 'text-gray-700 hover:text-blue-700' : 'text-gray-400'}`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] border ${
                  i === stepIdx ? 'bg-blue-600 border-blue-600 text-white' : i < stepIdx ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300'
                }`}
              >
                {i < stepIdx ? <Check className="w-3 h-3" /> : i + 1}
              </span>
              {defFor(k)?.title ?? 'Review'}
            </button>
            {i < steps.length - 1 && <span className="w-6 h-px bg-gray-300" />}
          </li>
        ))}
      </ol>

      <div>
        <h3 className="text-sm font-semibold text-gray-900">{(defFor(step)?.title ?? 'Review')}{defFor(step)?.titleSuffix ? ` ${defFor(step)!.titleSuffix}` : ''}</h3>
        <p className="text-xs text-gray-500">{defFor(step)?.blurb ?? REVIEW_BLURB}</p>
      </div>

      {step !== 'review' && <div className="space-y-4">{stepEntries(step).map(renderOne)}</div>}
      {step !== 'review' && showErrors && problemsFor(step).map((m) => (
        <p key={m} className="text-xs text-red-600">{m}</p>
      ))}

      {step === 'review' && (
        <>
          <dl className="rounded-md border border-gray-200 divide-y divide-gray-100 text-sm">
            {summaryRows.length === 0 && <div className="px-3 py-2 text-gray-500">Nothing filled in yet.</div>}
            {summaryRows.map((e) => (
              <div key={e.name} className="flex gap-3 px-3 py-1.5">
                <dt className="w-40 flex-shrink-0 text-gray-500">{e.schema?.label || prettifyFieldName(e.name)}</dt>
                <dd className="min-w-0 break-words font-mono text-xs text-gray-900 pt-0.5">{summarize(e.name, e.schema, values[e.name])}</dd>
              </div>
            ))}
          </dl>
          {activeMore.length > 0 && (
            <details className="border border-gray-200 rounded-md">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-gray-700 bg-gray-50 rounded-md flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-gray-400" /> Optional settings
                <span className="text-xs font-normal text-gray-400">{activeMore.map((g) => g.label).join(' · ')}</span>
              </summary>
              <div className="p-3 space-y-3">
                {activeMore.map((g) => (
                  <details key={g.key} className="border border-gray-100 rounded-md">
                    <summary className="cursor-pointer select-none px-3 py-1.5 text-sm text-gray-700">{g.label}</summary>
                    <div className="p-3 space-y-3">{g.entries.map((e) => <div key={e.name}>{renderEntry(e.name, e.schema)}</div>)}</div>
                  </details>
                ))}
              </div>
            </details>
          )}
          {allMissing.length > 0 && (
            <p className="text-xs text-red-600">
              Still needed: {allMissing.map((n) => properties[n]?.label || prettifyFieldName(n)).join(', ')}.
            </p>
          )}
          {allProblems.map((m) => (
            <p key={m} className="text-xs text-red-600">{m}</p>
          ))}
        </>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-gray-100">
        <button type="button" onClick={onAdvanced} className="text-xs text-gray-500 hover:text-gray-800 underline underline-offset-2">
          Switch to the advanced form
        </button>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          {stepIdx > 0 && (
            <button
              type="button"
              onClick={() => { setShowErrors(false); setStepIdx((i) => Math.max(i - 1, 0)); }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          )}
          {step !== 'review' ? (
            <button type="button" onClick={next} className="inline-flex items-center gap-1 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
              Next <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button type="button" onClick={finish} className="inline-flex items-center gap-1 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700">
              <Check className="w-4 h-4" /> {isDraft ? 'Add to sandbox' : 'Add data source'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
