import { useEffect, useRef, useState } from "react";
import type { Mode } from "../api/types";
import "./ModePill.css";

interface ModeOption {
  value: Mode;
  label: string;
  disabled?: boolean;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: "observe", label: "observe mode" },
  { value: "suggest", label: "suggest mode" },
  // The isolate-mode proxy is Phase 3 and doesn't exist yet
  // (packages/daemon/src/proxy/ — see CLAUDE.md's "ask before" list), so
  // choosing it here would set real router state with no corresponding
  // backend behaviour. It stays listed (not removed) so the pill still
  // shows the real mode correctly if something outside the UI (e.g.
  // `fern mode isolate` from the CLI) has already set it.
  { value: "isolate", label: "isolate mode", disabled: true },
];

export function ModePill({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const currentIndex = MODE_OPTIONS.findIndex((o) => o.value === mode);
    optionRefs.current[Math.max(currentIndex, 0)]?.focus();
  }, [open, mode]);

  function closeAndRefocus(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function focusDelta(fromIndex: number, delta: number): void {
    let next = fromIndex;
    for (let step = 0; step < MODE_OPTIONS.length; step++) {
      next = (next + delta + MODE_OPTIONS.length) % MODE_OPTIONS.length;
      const option = MODE_OPTIONS[next];
      if (option && !option.disabled) break;
    }
    optionRefs.current[next]?.focus();
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent): void {
    if (
      event.key === "ArrowDown" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      setOpen(true);
    }
  }

  function handleOptionKeyDown(
    event: React.KeyboardEvent,
    index: number,
  ): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeAndRefocus();
        break;
      case "ArrowDown":
        event.preventDefault();
        focusDelta(index, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusDelta(index, -1);
        break;
      case "Home":
        event.preventDefault();
        focusDelta(-1, 1);
        break;
      case "End":
        event.preventDefault();
        focusDelta(0, -1);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  function selectOption(option: ModeOption): void {
    if (option.disabled) return;
    onChange(option.value);
    closeAndRefocus();
  }

  return (
    <div className="mode-pill" ref={rootRef}>
      <span className="mode-pill__dot" aria-hidden="true" />
      <button
        type="button"
        ref={triggerRef}
        className="mode-pill__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Routing mode: ${current?.label ?? mode}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
      >
        {current?.label ?? mode}
        <span className="mode-pill__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Routing mode"
          className="mode-pill__listbox"
        >
          {MODE_OPTIONS.map((option, index) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={option.value === mode}
              aria-disabled={option.disabled}
              disabled={option.disabled}
              className="mode-pill__option"
              data-disabled={option.disabled}
              ref={(el) => {
                optionRefs.current[index] = el;
              }}
              tabIndex={-1}
              onClick={() => selectOption(option)}
              onKeyDown={(e) => handleOptionKeyDown(e, index)}
            >
              {option.label}
              {option.disabled && (
                <span className="mode-pill__coming-soon">coming soon</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
