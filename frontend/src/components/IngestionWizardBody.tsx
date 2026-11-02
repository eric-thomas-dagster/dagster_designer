import { useMemo } from 'react';
import { GENERIC_FIELD_GROUPS } from '@/lib/genericFields';
import { classifyIngestionFields } from '@/lib/ingestionWizard';
import type { WizardStepDef } from '@/lib/wizardTypes';
import { GuidedWizard, type GuidedWizardProps } from './GuidedWizard';

type Props = Omit<GuidedWizardProps, 'steps' | 'moreGroups'>;

/** Guided flow for the ~190 SaaS `*_ingestion` templates: Connect, What to load, Where it goes, Review. */
export function IngestionWizardBody(props: Props) {
  const { properties, required, displayName } = props;
  const fields = useMemo(() => classifyIngestionFields(properties, required), [properties, required]);

  const steps = useMemo<WizardStepDef[]>(
    () => [
      { key: 'connect', title: 'Connect', titleSuffix: `to ${displayName}`, blurb: 'Name this data and give Dagster access to your account.', entries: fields.connect },
      { key: 'load', title: 'What to load', blurb: 'Choose what to pull. Anything you leave alone uses the sensible default.', entries: fields.load },
      {
        key: 'destination',
        title: 'Where it goes',
        blurb: 'Pick a warehouse, or leave it empty to keep the data in memory as a DataFrame for transforms.',
        entries: fields.destination,
      },
    ],
    [fields, displayName],
  );
  const moreGroups = useMemo(
    () => GENERIC_FIELD_GROUPS.map((g) => ({ key: g.key, label: g.label, entries: fields.more[g.key] })),
    [fields],
  );

  return <GuidedWizard {...props} steps={steps} moreGroups={moreGroups} />;
}
