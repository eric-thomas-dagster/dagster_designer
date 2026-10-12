import { useState } from 'react';
import { X, Info } from 'lucide-react';

interface TranslationEditorProps {
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
  /** Suppress specific commonFields entries -- used by ComponentConfigModal
   *  to drop description/group_name/owners/tags here when its own
   *  Post-processing > Metadata section (asset_field_overrides) is already
   *  showing them, which confirmed genuinely duplicates this editor for
   *  any single-asset (non-factory) component: both set the exact same
   *  underlying Dagster asset attributes, just one as a literal value and
   *  this one as a template string. Left empty (shows everything) for
   *  asset-factory components, where Metadata isn't available at all (no
   *  single resolvable asset key for post-processing to target) and this
   *  is the ONLY place to set these per-generated-asset. `key` (Asset Key
   *  Pattern / renaming) is never suppressed -- nothing else does that. */
  hideFields?: string[];
}

export function TranslationEditor({ value, onChange, hideFields }: TranslationEditorProps) {
  const [translation, setTranslation] = useState(value || {});

  const handleChange = (key: string, val: string) => {
    const updated = { ...translation, [key]: val };
    setTranslation(updated);
    onChange(updated);
  };

  const handleRemove = (key: string) => {
    const updated = { ...translation };
    delete updated[key];
    setTranslation(updated);
    onChange(updated);
  };

  const hidden = new Set(hideFields || []);
  const commonFields = [
    { key: 'description', label: 'Description', placeholder: 'Asset description' },
    { key: 'group_name', label: 'Group Name', placeholder: 'my_group' },
    { key: 'key', label: 'Asset Key Pattern', placeholder: 'my_{{ node.name }}' },
    { key: 'owners', label: 'Owners', placeholder: 'team@company.com' },
    { key: 'tags', label: 'Tags (comma-separated)', placeholder: 'prod,critical' },
  ].filter((f) => !hidden.has(f.key));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Translation (Asset Customization)
        </h3>
        <button
          type="button"
          className="text-xs text-blue-600 hover:text-blue-800"
          title="About Translation"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>

      <div className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-2">
        Customize how assets are generated. Use template variables like{' '}
        <code className="bg-blue-100 px-1 rounded">{'{{ node.name }}'}</code> or{' '}
        <code className="bg-blue-100 px-1 rounded">{'{{ props.table }}'}</code>
      </div>

      {hidden.size > 0 && (
        <div className="text-xs text-gray-500">
          Description, group name, owners, and tags for this asset are already set in the Metadata section above -- set them there instead.
        </div>
      )}

      <div className="space-y-2">
        {commonFields.map((field) => {
          const fieldValue = translation[field.key] || '';
          const isActive = fieldValue !== '';

          return (
            <div key={field.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs text-gray-500">
                  {field.label}
                </label>
                {isActive && (
                  <button
                    type="button"
                    onClick={() => handleRemove(field.key)}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <input
                type="text"
                value={fieldValue}
                onChange={(e) => handleChange(field.key, e.target.value)}
                placeholder={field.placeholder}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
