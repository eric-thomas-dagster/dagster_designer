import { useState } from 'react';
import { Plus, X, Info } from 'lucide-react';

interface TranslationEditorProps {
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
}

export function TranslationEditor({ value, onChange }: TranslationEditorProps) {
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

  const commonFields = [
    { key: 'description', label: 'Description', placeholder: 'Asset description' },
    { key: 'group_name', label: 'Group Name', placeholder: 'my_group' },
    { key: 'key', label: 'Asset Key Pattern', placeholder: 'my_{{ node.name }}' },
    { key: 'owners', label: 'Owners', placeholder: 'team@company.com' },
    { key: 'tags', label: 'Tags (comma-separated)', placeholder: 'prod,critical' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">
          Translation (Asset Customization)
        </label>
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

      <div className="space-y-2">
        {commonFields.map((field) => {
          const fieldValue = translation[field.key] || '';
          const isActive = fieldValue !== '';

          return (
            <div key={field.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">
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
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          );
        })}
      </div>

      {/* Advanced/Custom fields */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
          Advanced Options
        </summary>
        <div className="mt-2 p-2 bg-gray-50 rounded-md">
          <textarea
            value={JSON.stringify(translation, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                setTranslation(parsed);
                onChange(parsed);
              } catch {
                // Invalid JSON, ignore
              }
            }}
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={6}
            placeholder="{}"
          />
          <div className="text-xs text-gray-500 mt-1">
            Edit as JSON for full control
          </div>
        </div>
      </details>

      {/* Examples */}
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
          Examples
        </summary>
        <div className="mt-2 space-y-2 text-xs text-gray-600">
          <div className="bg-gray-50 p-2 rounded">
            <div className="font-medium">Custom description:</div>
            <code className="text-xs">{`description: "Table {{ props.table }}"`}</code>
          </div>
          <div className="bg-gray-50 p-2 rounded">
            <div className="font-medium">Group all assets:</div>
            <code className="text-xs">group_name: &quot;analytics&quot;</code>
          </div>
          <div className="bg-gray-50 p-2 rounded">
            <div className="font-medium">Custom key pattern:</div>
            <code className="text-xs">{`key: "prod_{{ node.name }}"`}</code>
          </div>
        </div>
      </details>
    </div>
  );
}
