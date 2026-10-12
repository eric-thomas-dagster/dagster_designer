/**
 * Generic schema.json annotations for fields whose relevance or meaning
 * depends on the current value of another field in the same form --
 * `x-dagster-visible-when` and `x-dagster-label-by`. Not specific to any
 * one component or field: the community catalog's first real use is
 * `bucket_url` on ingestion components (relevant only when
 * `destination` is filesystem/databricks/athena, and genuinely means
 * something different per destination -- the final write target for
 * filesystem, just a staging area for databricks/athena), but either
 * annotation is reusable for any field with this shape.
 *
 * Both are read straight off the field's own schema entry, so a schema
 * author opts a field in without any frontend changes -- same convention
 * as `x-dagster-destination-fields`/`ui:widget`.
 */

export interface VisibleWhenRule {
  field: string;
  values: string[];
}

export interface LabelByRule {
  field: string;
  labels: Record<string, string>;
}

/**
 * True unless the field declares `x-dagster-visible-when` and the named
 * trigger field's current form value isn't in its `values` list. A field
 * with no rule is always visible.
 */
export function isFieldVisible(fieldSchema: any, formData: Record<string, unknown>): boolean {
  const rule: VisibleWhenRule | undefined = fieldSchema?.['x-dagster-visible-when'];
  if (!rule) return true;
  return rule.values?.includes(formData[rule.field] as string) ?? false;
}

/**
 * The field's display label: `x-dagster-label-by`'s entry for the current
 * trigger value when present and non-empty, else the given fallback
 * (callers pass their own prettified-field-name fallback so this stays
 * usable without importing any particular formatting convention).
 */
export function labelFor(fieldSchema: any, formData: Record<string, unknown>, fallback: string): string {
  const rule: LabelByRule | undefined = fieldSchema?.['x-dagster-label-by'];
  if (rule) {
    const byValue = rule.labels?.[formData[rule.field] as string];
    if (byValue) return byValue;
  }
  return fallback;
}
