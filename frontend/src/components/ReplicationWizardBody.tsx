import { useEffect, useMemo, useRef } from 'react';
import {
  connectionNote, deriveOnChange, replicationKind, replicationLayout, replicationStepErrors,
} from '@/lib/replicationWizard';
import { GuidedWizard, type GuidedWizardProps } from './GuidedWizard';

type Props = Omit<GuidedWizardProps, 'steps' | 'moreGroups' | 'stepErrors' | 'fieldNote'>;

// Fields whose new value should fill in others (see deriveOnChange).
const WATCHED = ['source_type', 'target_type', 'source_table'] as const;

/** Guided flow for database_replication and sql_to_database_asset: Source, Target, Tables & mode, Review. */
export function ReplicationWizardBody(props: Props) {
  const { formData, onFieldChange } = props;
  const kind = replicationKind(props.componentType);
  const layout = useMemo(
    () => (kind ? replicationLayout(kind, props.properties) : { steps: [], moreGroups: [] }),
    [kind, props.properties],
  );

  // The field widgets write to the form themselves (not through this wizard), so watch the
  // form data for the fields that drive autofill rather than intercepting each change.
  const before = useRef(formData);
  useEffect(() => {
    const prev = before.current;
    before.current = formData;
    if (!kind || prev === formData) return;
    for (const field of WATCHED) {
      if (formData[field] === prev[field]) continue;
      // `prev` supplies the changed field's old value (to tell "still auto-filled" from "user typed");
      // everything else is the live form.
      const updates = deriveOnChange(kind, field, formData[field], { ...formData, [field]: prev[field] });
      for (const [f, v] of Object.entries(updates)) onFieldChange(f, v);
    }
  }, [formData, kind, onFieldChange]);

  if (!kind) return null;
  return (
    <GuidedWizard
      {...props}
      steps={layout.steps}
      moreGroups={layout.moreGroups}
      stepErrors={(stepKey, values) => replicationStepErrors(kind, stepKey, values)}
      fieldNote={connectionNote}
    />
  );
}
