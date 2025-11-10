import { useState, useEffect } from 'react';
import { Clock, Calendar } from 'lucide-react';

interface CronBuilderProps {
  value: string;
  onChange: (cronExpression: string) => void;
}

// Common preset schedules
const PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Daily at 6am', value: '0 6 * * *' },
  { label: 'Daily at noon', value: '0 12 * * *' },
  { label: 'Daily at 6pm', value: '0 18 * * *' },
  { label: 'Weekly (Monday at 6am)', value: '0 6 * * 1' },
  { label: 'Monthly (1st at 6am)', value: '0 6 1 * *' },
  { label: 'Weekdays (Mon-Fri at 6am)', value: '0 6 * * 1-5' },
];

export function CronBuilder({ value, onChange }: CronBuilderProps) {
  const [mode, setMode] = useState<'preset' | 'custom' | 'advanced'>('preset');
  const [minute, setMinute] = useState('0');
  const [hour, setHour] = useState('0');
  const [dayOfMonth, setDayOfMonth] = useState('*');
  const [month, setMonth] = useState('*');
  const [dayOfWeek, setDayOfWeek] = useState('*');

  // Parse existing cron expression when component mounts or value changes
  useEffect(() => {
    if (value) {
      const parts = value.split(' ');
      if (parts.length === 5) {
        setMinute(parts[0]);
        setHour(parts[1]);
        setDayOfMonth(parts[2]);
        setMonth(parts[3]);
        setDayOfWeek(parts[4]);

        // Check if it matches a preset
        const matchingPreset = PRESETS.find(p => p.value === value);
        if (matchingPreset) {
          setMode('preset');
        } else if (parts.some(p => p.includes('/') || p.includes('-') || p.includes(','))) {
          setMode('advanced');
        } else {
          setMode('custom');
        }
      }
    }
  }, [value]);

  // Update cron expression when custom values change
  useEffect(() => {
    if (mode === 'custom') {
      const newCron = `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`;
      if (newCron !== value) {
        onChange(newCron);
      }
    }
  }, [mode, minute, hour, dayOfMonth, month, dayOfWeek]);

  const handlePresetChange = (presetValue: string) => {
    onChange(presetValue);
  };

  const handleAdvancedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  // Generate human-readable description
  const getDescription = (cron: string): string => {
    const preset = PRESETS.find(p => p.value === cron);
    if (preset) return preset.label;

    const parts = cron.split(' ');
    if (parts.length !== 5) return 'Invalid cron expression';

    const [min, hr, dom, mon, dow] = parts;

    let desc = 'Runs ';

    // Frequency
    if (min === '*' && hr === '*') {
      desc += 'every minute';
    } else if (min.startsWith('*/')) {
      desc += `every ${min.slice(2)} minutes`;
    } else if (hr === '*') {
      desc += `every hour at ${min} minutes past`;
    } else {
      desc += `at ${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }

    // Day of week
    if (dow !== '*') {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      if (dow.includes('-')) {
        const [start, end] = dow.split('-');
        desc += ` on ${days[parseInt(start)]}-${days[parseInt(end)]}`;
      } else if (dow === '1-5') {
        desc += ' on weekdays';
      } else {
        desc += ` on ${days[parseInt(dow)]}`;
      }
    }

    // Day of month
    if (dom !== '*' && dow === '*') {
      if (dom === '1') {
        desc += ' on the 1st of each month';
      } else if (dom === '15') {
        desc += ' on the 15th of each month';
      } else {
        desc += ` on day ${dom} of each month`;
      }
    }

    return desc;
  };

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div className="flex space-x-2">
        <button
          type="button"
          onClick={() => setMode('preset')}
          className={`px-3 py-1.5 text-sm rounded-md ${
            mode === 'preset'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Preset
        </button>
        <button
          type="button"
          onClick={() => setMode('custom')}
          className={`px-3 py-1.5 text-sm rounded-md ${
            mode === 'custom'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Custom
        </button>
        <button
          type="button"
          onClick={() => setMode('advanced')}
          className={`px-3 py-1.5 text-sm rounded-md ${
            mode === 'advanced'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          Advanced
        </button>
      </div>

      {/* Preset mode */}
      {mode === 'preset' && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            Choose a schedule
          </label>
          <select
            value={value}
            onChange={(e) => handlePresetChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select a schedule...</option>
            {PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Custom mode */}
      {mode === 'custom' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Hour */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                <Clock className="w-3 h-3 inline mr-1" />
                Hour
              </label>
              <select
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="*">Every hour</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>
                    {i.toString().padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </div>

            {/* Minute */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                <Clock className="w-3 h-3 inline mr-1" />
                Minute
              </label>
              <select
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="*">Every minute</option>
                <option value="0">:00</option>
                <option value="15">:15</option>
                <option value="30">:30</option>
                <option value="45">:45</option>
                {Array.from({ length: 60 }, (_, i) => (
                  <option key={i} value={i}>
                    :{i.toString().padStart(2, '0')}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Day of Week */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                <Calendar className="w-3 h-3 inline mr-1" />
                Day of Week
              </label>
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="*">Every day</option>
                <option value="1-5">Weekdays (Mon-Fri)</option>
                <option value="0">Sunday</option>
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
              </select>
            </div>

            {/* Day of Month */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                <Calendar className="w-3 h-3 inline mr-1" />
                Day of Month
              </label>
              <select
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="*">Every day</option>
                <option value="1">1st</option>
                <option value="15">15th</option>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Month
            </label>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
            >
              <option value="*">Every month</option>
              <option value="1">January</option>
              <option value="2">February</option>
              <option value="3">March</option>
              <option value="4">April</option>
              <option value="5">May</option>
              <option value="6">June</option>
              <option value="7">July</option>
              <option value="8">August</option>
              <option value="9">September</option>
              <option value="10">October</option>
              <option value="11">November</option>
              <option value="12">December</option>
            </select>
          </div>
        </div>
      )}

      {/* Advanced mode - raw cron input */}
      {mode === 'advanced' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Cron Expression
          </label>
          <input
            type="text"
            value={value}
            onChange={handleAdvancedChange}
            placeholder="*/5 * * * *"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            Format: minute hour day-of-month month day-of-week
          </p>
        </div>
      )}

      {/* Description */}
      {value && (
        <div className="p-2 bg-blue-50 border border-blue-200 rounded-md">
          <p className="text-sm text-blue-900">
            <strong>Schedule:</strong> {getDescription(value)}
          </p>
          <p className="text-xs text-blue-700 mt-1 font-mono">{value}</p>
        </div>
      )}
    </div>
  );
}
