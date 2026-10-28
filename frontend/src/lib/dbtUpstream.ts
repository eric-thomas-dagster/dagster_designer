/**
 * dbt assets write their tables into the warehouse; they never hand Dagster a DataFrame. The dbt component's schema
 * still declares its output as "dataframe", so the type check lets a pandas-based transform be wired onto a dbt model
 * or seed -- and then the run fails because the default IO manager looks for a stored output dbt never wrote
 * ("No such file ... storage/seeds/raw_customers"). Anything that feeds a DataFrame into a Python component should skip these.
 */
export function isDbtBackedType(componentType: unknown): boolean {
  return typeof componentType === 'string' && /dbt/i.test(componentType);
}

export const DBT_UPSTREAM_REASON =
  "This asset is built by dbt, so its table lives in your warehouse and isn't handed to Python components as a DataFrame. " +
  'Transform it with a dbt model or a SQL transform instead.';
