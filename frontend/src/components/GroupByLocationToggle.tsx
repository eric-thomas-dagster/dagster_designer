/** Shared checkbox for the "group into a section per code location"
 *  preference, used identically across Catalog/Automation/Insights/
 *  Monitors/Ingestions/Resources. Callers only render this when there's
 *  more than one code location to group by in the first place. */
export function GroupByLocationToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none whitespace-nowrap"
      title="When no specific code location is picked, break this list into one section per location"
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5"
      />
      Group by location
    </label>
  );
}
