import React, { useEffect, useId, useRef, useState } from 'react';

const storageKey = 'boardly.workspace-split';
const defaults = { side: 60, stacked: 42 };
function savedSizes() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, Number.isFinite(saved?.[key]) ? Math.max(20, Math.min(80, saved[key])) : fallback]));
  } catch { return defaults; }
}

export default function SplitWorkspace({ children, secondary, primaryLabel = 'Task board' }) {
  const container = useRef(null), drag = useRef(null), id = useId();
  const [sizes, setSizes] = useState(savedSizes), [width, setWidth] = useState(0);
  const side = width >= 900, direction = side ? 'side' : 'stacked';
  const min = side ? Math.ceil(320 / width * 100) : 25;
  const max = side ? Math.floor((width - 350) / width * 100) : 65;
  const clamp = value => Math.max(min, Math.min(max, value));
  const percent = clamp(sizes[direction]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(sizes)); } catch {} }, [sizes]);
  function resize(value) { setSizes(previous => ({ ...previous, [direction]: clamp(value) })); }
  function move(event) {
    if (drag.current !== event.pointerId) return;
    const rect = container.current.getBoundingClientRect();
    resize(100 * (side ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height));
  }
  return <div ref={container} className={`split-workspace ${secondary ? 'split-workspace-open' : ''}`} data-layout={direction} style={{ '--primary-size': `${percent}%` }}>
    <section id={`${id}-primary`} aria-label={primaryLabel} className="split-primary">{children}</section>
    {secondary && <>
      <div role="separator" tabIndex={0} aria-label="Resize task board and coding pane" aria-controls={`${id}-primary ${id}-secondary`}
        aria-orientation={side ? 'vertical' : 'horizontal'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(percent)}
        aria-valuetext={`${Math.round(percent)} percent for ${primaryLabel.toLowerCase()}`} title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        className="workspace-divider" onDoubleClick={() => resize(defaults[direction])}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={move} onPointerUp={event => { if (drag.current !== event.pointerId) return; drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => {
          const negative = side ? 'ArrowLeft' : 'ArrowUp', positive = side ? 'ArrowRight' : 'ArrowDown';
          if (![negative, positive, 'Home', 'End', 'Enter'].includes(event.key)) return;
          event.preventDefault(); resize(event.key === 'Home' ? min : event.key === 'End' ? max : event.key === 'Enter' ? defaults[direction] : percent + (event.key === negative ? -2 : 2));
        }}><span /></div>
      <div id={`${id}-secondary`} className="split-secondary">{secondary}</div>
    </>}
  </div>;
}
