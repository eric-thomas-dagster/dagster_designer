import type { FieldEntry } from './ingestionWizard';

/** One step of a guided wizard: the schema fields it asks about. A step with no entries is skipped. */
export interface WizardStepDef {
  key: string;
  title: string;
  /** Appended to the heading only (e.g. "to Shopify"), not to the stepper label. */
  titleSuffix?: string;
  blurb: string;
  entries: FieldEntry[];
}

/** A collapsible group of optional fields on the review step. */
export interface WizardGroup {
  key: string;
  label: string;
  entries: FieldEntry[];
}
