import { useState } from 'react';
import { EXPLORER_HOTKEYS } from '../lib/hotkeys';

/**
 * The Explorer's "?" shortcuts popover (issue #25): lists exactly
 * the keys in EXPLORER_HOTKEYS — the same list the Settings page
 * shows, from the same source, so the two can never drift. Plain
 * toggle panel (not a modal): it never traps keys, and it closes
 * with its own button.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        onClick={() => setOpen((o) => !o)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-ink-dim ring-1 ring-navy-600 hover:bg-navy-800 hover:text-ink"
      >
        ?
      </button>
      {open ? (
        <span className="absolute right-0 top-8 z-30 block w-72 rounded-lg border border-navy-700 bg-navy-850 p-3 text-left shadow-panel">
          <span className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Keyboard shortcuts
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
            >
              Close ✕
            </button>
          </span>
          <span className="flex flex-col gap-1.5">
            {EXPLORER_HOTKEYS.map((h) => (
              <span key={h.keys} className="flex items-baseline gap-2.5 text-xs">
                <kbd className="w-10 shrink-0 rounded bg-navy-800 px-1 py-0.5 text-center font-mono text-[11px] text-ink ring-1 ring-navy-600">
                  {h.keys}
                </kbd>
                <span className="text-ink-dim">{h.action}</span>
              </span>
            ))}
          </span>
          <span className="mt-2 block text-[11px] text-ink-faint">
            Keys pause while you type in a field or a card picker is open.
          </span>
        </span>
      ) : null}
    </span>
  );
}
