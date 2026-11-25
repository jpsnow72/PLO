import { useEffect, useRef, useState } from 'react';
import { isTypingTarget, modalOpen } from './hotkeys';
import { currentNodeOf, useStore, type PathStep } from '../store/useStore';

/**
 * Explorer keyboard navigation (rebrand slice 13, issue #25).
 *
 *   ← / →  step back / forward along the line
 *   1–5    take the nth action listed at the current node
 *
 * The store's path is a truncating stack (goToStep drops the steps
 * after the target — there is no redo state to read), so Forward is
 * this hook's own doing: stepping back parks the removed step on a
 * local redo stack, and → re-applies it through setPath (which
 * validates that every step still resolves in the loaded solve).
 * ANY other navigation — clicking an action or a node-strip step,
 * Reset, a deep link, a new solve — clears the redo stack, exactly
 * like a browser's forward history.
 *
 * Guards: nothing fires while typing in a field, while a modal
 * (the card picker) is open, or with a modifier key held. Escape is
 * deliberately NOT bound here — the card picker and the drawing
 * overlay each own their Esc handling, and a second binding would
 * fire both.
 */
export function useExplorerHotkeys(): void {
  const path = useStore((s) => s.path);
  const [redo, setRedo] = useState<PathStep[]>([]);
  // Set by the arrow handlers so the path watcher below can tell
  // "navigation I caused" (keep the redo stack) from any other
  // navigation (clear it).
  const selfNavRef = useRef(false);
  const prevPathRef = useRef(path);
  // Latest values for the (once-registered) key handler.
  const liveRef = useRef({ path, redo });
  liveRef.current = { path, redo };

  useEffect(() => {
    if (selfNavRef.current) {
      selfNavRef.current = false;
      prevPathRef.current = path;
      return;
    }
    if (prevPathRef.current !== path) {
      prevPathRef.current = path;
      setRedo((r) => (r.length > 0 ? [] : r));
    }
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || modalOpen()) return;
      const { path: p, redo: r } = liveRef.current;
      const st = useStore.getState();

      if (e.key === 'ArrowLeft') {
        const removed = p[p.length - 1];
        if (p.length <= 1 || !removed) return;
        e.preventDefault();
        selfNavRef.current = true;
        setRedo([removed, ...r]);
        st.goToStep(p.length - 2);
      } else if (e.key === 'ArrowRight') {
        const next = r[0];
        if (!next) return;
        e.preventDefault();
        selfNavRef.current = true;
        setRedo(r.slice(1));
        st.setPath([...p, next]);
      } else if (/^[1-5]$/.test(e.key)) {
        // A runout is outstanding (the street closed) or the line
        // already ended: there is no action list to pick from.
        if (st.pendingRunout || st.pendingTurnCards || st.terminalAction) return;
        const node = currentNodeOf(st.solve, st.path);
        const label = node?.actions[Number(e.key) - 1];
        if (!label) return;
        e.preventDefault();
        st.chooseAction(label);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
