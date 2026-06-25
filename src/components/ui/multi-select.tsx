import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface MultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  className?: string;
}

export function MultiSelect({ label, options, selected, onChange, className }: MultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleOption = useCallback(
    (option: string) => {
      if (selected.includes(option)) {
        onChange(selected.filter((s) => s !== option));
      } else {
        onChange([...selected, option]);
      }
    },
    [selected, onChange],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const displayLabel =
    selected.length === 0
      ? label
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <div ref={containerRef} className={`relative ${className || ''}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between gap-2 h-8 px-3 text-xs font-medium rounded-md border bg-white transition-colors hover:bg-muted/30 min-w-[130px]"
        style={{
          borderColor: 'var(--color-border)',
          color: selected.length ? 'var(--color-gray-900)' : 'var(--color-gray-500)',
        }}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
      </button>

      {isOpen && (
        <div
          className="absolute z-50 mt-1 min-w-[160px] bg-white border rounded-md shadow-lg overflow-auto"
          style={{ borderColor: 'var(--color-border)', maxHeight: 220 }}
        >
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-muted/50 transition-colors"
              style={{
                color: 'var(--color-brand-orange)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              Clear all
            </button>
          )}
          {options.map((option) => {
            const isSelected = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggleOption(option)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors"
              >
                <div
                  className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0"
                  style={{
                    borderColor: isSelected ? 'var(--color-brand-orange)' : 'var(--color-border)',
                    background: isSelected ? 'var(--color-brand-orange)' : 'transparent',
                  }}
                >
                  {isSelected && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="truncate">{option}</span>
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No options</div>
          )}
        </div>
      )}
    </div>
  );
}
