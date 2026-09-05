import { useEffect, useState, type ReactNode } from 'react';
export const inventory = (stock: Record<string, number>) =>
  Object.entries(stock)
    .filter(([, n]) => n > 0)
    .map(([item, n]) => `${n} ${item}`)
    .join(', ') || 'Empty';
export const fixed = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : value.toFixed(digits);
export const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
export function numberValue(text: string, label: string, min: number, max: number, integer = true) {
  if (!text.trim()) throw new Error(`${label} is required.`);
  const n = Number(text);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max)
    throw new Error(`${label} must be ${integer ? 'an integer ' : ''}from ${min} to ${max}.`);
  return n;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function NumberSetting({
  label,
  value,
  min = 0,
  max = 100,
  onApply,
  disabled = false,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onApply: (n: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(String(value));
    setError('');
  }, [value]);
  const apply = () => {
    try {
      onApply(numberValue(draft, label, min, max));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="number-setting">
      <Field label={label}>
        <span className="input-action">
          <input
            type="number"
            aria-label={label}
            min={min}
            max={max}
            value={draft}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(e) => {
              setDraft(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
            }}
          />
          <button
            aria-label={`Apply ${label}`}
            disabled={disabled || draft === String(value)}
            onClick={apply}
          >
            Apply
          </button>
        </span>
      </Field>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    select: 'M5 3l13 9-6 1-3 6z',
    pan: 'M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4',
    move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
    obstacle: 'M3 5h18v14H3zM3 12h18M9 5v7M15 12v7',
    erase: 'M4 13l9-9 7 7-9 9H7zM11 20h10M8 9l7 7',
    robot: 'M6 5h12v14H6zM9 9h6M4 8v8M20 8v8M9 16h6',
    supply: 'M4 7h16v13H4zM8 7V3h8v4M8 13h8M12 9v8',
    process: 'M5 4h14v16H5zM8 9h8M9 4v5M15 4v5M8 16h8',
    assembly: 'M4 5h7v7H4zM13 5h7v7h-7zM8 15h8v6H8z',
    delivery: 'M4 5h16v15H4zM8 12h10M14 8l4 4-4 4',
    undo: 'M8 5L3 10l5 5M3 10h11a6 6 0 010 12',
    redo: 'M16 5l5 5-5 5M21 10h-11a6 6 0 000 12',
    fit: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6',
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.select} />
    </svg>
  );
}
