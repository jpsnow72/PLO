/**
 * Explorer hotkeys (rebrand slice 13, issue #25): the documented
 * key set, plus the guards the binding in useExplorerHotkeys runs
 * behind. This list is the single source for both the Settings
 * page and the Explorer's shortcuts popover — only keys that are
 * actually bound appear here.
 *
 * Escape is listed because it IS an Explorer key, but it is bound
 * by the tools that own the state it closes — the card picker
 * (CardPicker) and the drawing overlay (DrawingOverlay) each close
 * themselves on Esc. The Explorer hook deliberately does not bind
 * it: a second binding would fire both at once.
 */

export interface HotkeyDoc {
  keys: string;
  action: string;
}

export const EXPLORER_HOTKEYS: HotkeyDoc[] = [
  { keys: '←', action: 'Step back one move along the line' },
  {
    keys: '→',
    action: 'Step forward again — only through moves you stepped back over',
  },
  { keys: '1–5', action: 'Take the 1st–5th action listed at this node' },
  {
    keys: 'Esc',
    action: 'Close the card picker, or stop drawing (bound by those tools themselves)',
  },
];

/** True when the key event is aimed at a form field — hotkeys must never fight typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** True while a modal dialog (the card picker) is on screen — hotkeys pause behind it. */
export function modalOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null
  );
}
