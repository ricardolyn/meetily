import { useCallback, useEffect, useRef, useState } from 'react';

interface Options {
  /** localStorage key for persisting the width. */
  storageKey: string;
  /** Initial fallback width (px) when nothing is stored yet. */
  defaultWidth: number;
  /** Lower clamp on the panel width (px). */
  minWidth: number;
  /** Lower clamp on the *other* side (px). The panel can't grow past
   *  parent.clientWidth - minOpposite. */
  minOpposite: number;
}

interface Result {
  /** Current panel width in px. */
  width: number;
  /** Spread these onto the drag handle element. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
  /** Spread this onto the container that holds both sides — the hook
   *  needs it to clamp the drag against the parent's width. */
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
}

/**
 * Bare-bones horizontal resize for a right-side panel. Stores its width
 * in localStorage, clamps against the container, and uses page-level
 * mouse listeners while dragging so the user can drift off the handle.
 */
export function useHorizontalResize({
  storageKey,
  defaultWidth,
  minWidth,
  minOpposite,
}: Options): Result {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultWidth;
  });
  const draggingRef = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // Panel sits on the right side, so panel width = right edge - mouse X.
      const raw = rect.right - e.clientX;
      const max = Math.max(minWidth, rect.width - minOpposite);
      const next = Math.min(Math.max(raw, minWidth), max);
      setWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        window.localStorage.setItem(storageKey, String(Math.round(width)));
      } catch {
        // Ignore quota / SecurityError; width still works in-session.
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [minWidth, minOpposite, storageKey, width]);

  return { width, handleProps: { onMouseDown }, containerRef };
}
