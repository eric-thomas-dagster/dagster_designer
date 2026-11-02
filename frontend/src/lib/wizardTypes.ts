import type { ReactNode } from 'react';
import type { FieldEntry } from './ingestionWizard';

/** One step of a guided wizard: the schema fields it asks about. A step with no entries is skipped. */
export interface WizardStepDef {
  key: string;
  title: string;
  /** Appended to the heading only (e.g. "to Shopify"), not to the stepper label. */
  titleSuffix?: string;
  blurb: string;
  entries: FieldEntry[];
  /** Extra step content rendered after `entries` (bespoke editors such as an endpoint list). */
  custom?: () => ReactNode;
  /** Review-step rows for what `custom` collected, from the live form values. */
  summary?: (values: Record<string, any>) => { label: string; value: string }[];
}

/** A collapsible group of optional fields on the review step. */
export interface WizardGroup {
  key: string;
  label: string;
  entries: FieldEntry[];
}
