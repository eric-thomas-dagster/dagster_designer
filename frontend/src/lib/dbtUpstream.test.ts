import { describe, expect, it } from 'vitest';
import { isDbtBackedType } from './dbtUpstream';

describe('isDbtBackedType', () => {
  it('matches the enriched dbt component and plain dbt component types', () => {
    expect(isDbtBackedType('project_x.components.enriched_dbt_project.EnrichedDbtProjectComponent')).toBe(true);
    expect(isDbtBackedType('dagster_dbt.DbtProjectComponent')).toBe(true);
  });
  it('does not match other components or missing types', () => {
    expect(isDbtBackedType('dagster_community_components.AutoFieldComponent')).toBe(false);
    expect(isDbtBackedType(undefined)).toBe(false);
    expect(isDbtBackedType(null)).toBe(false);
  });
});
