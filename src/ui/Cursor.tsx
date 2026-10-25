// The cursor: a small dot that sticks to the pointer and a soft ring that follows a little behind it. The ring grows over
// links, shows a word over things marked data-cursor="Word" (or becomes a lens for data-cursor="lens"), squashes along the
// direction it is moving, and pulses on click. One requestAnimationFrame loop that runs only while the ring is still
// catching up with the pointer, so an idle page costs nothing.
// Only for a mouse or trackpad with Motion on. Touch screens, "reduce motion" and Motion off keep the normal cursor.
// `hideNative` hides the system arrow (landing page); the workspace keeps it, because data tables want a precise pointer.
import { useEffect, useRef, useState } from 'react';
import { useMotion } from './motion';

type Listener = (x: number, y: number) => void;
const listeners = new Set<Listener>();
/** Other effects (the torch in the night section) can follow the eased ring position. Returns an unsubscribe function. */
export const onCursorMove = (f: Listener) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

const TARGETS = '[data-cursor], a[href], button:not(:disabled), summary, [role="button"], select, input, label, canvas';

export function Cursor({ hideNative }: { hideNative: boolean }) {
  const { on } = useMotion();
  const [fine] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches);
  const wrap = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const blob = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!on || !fine || !wrap.current) return;
    const w = wrap.current!, d = dot.current!, r = ring.current!, b = blob.current!, l = label.current!;
    const html = document.documentElement;
    let tx = -200, ty = -200, dx = tx, dy = ty, rx = tx, ry = ty;
    let raf = 0;
    let seen = false;

    const frame = () => {
      raf = 0;
      dx += (tx - dx) * 0.62;
      dy += (ty - dy) * 0.62;
      rx += (tx - rx) * 0.15;
      ry += (ty - ry) * 0.15;
      const vx = tx - rx, vy = ty - ry;
      const speed = Math.hypot(vx, vy);
      const squash = Math.min(speed / 140, 0.34);
      d.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
      r.style.transform = `translate3d(${rx.toFixed(1)}px,${ry.toFixed(1)}px,0)`;
      b.style.transform = `rotate(${Math.atan2(vy, vx).toFixed(3)}rad) scale(${(1 + squash).toFixed(3)},${(1 - squash * 0.55).toFixed(3)})`;
      listeners.forEach((f) => f(rx, ry));
      if (speed > 0.25 || Math.hypot(tx - dx, ty - dy) > 0.25) raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      tx = e.clientX;
      ty = e.clientY;
      if (!seen) {
        seen = true;
        dx = rx = tx;
        dy = ry = ty;
        w.classList.add('on');
        if (hideNative) html.classList.add('cc-hide');
      }
      wake();
    };
    const over = (e: PointerEvent) => {
      const t = (e.target as Element | null)?.closest?.(TARGETS) ?? null;
      let state = 'idle';
      let text = '';
      if (t) {
        const c = t.getAttribute('data-cursor');
        if (c === 'lens') state = 'lens';
        else if (c) {
          state = 'label';
          text = c;
        } else state = 'link';
      }
      w.dataset.state = state;
      l.textContent = text;
    };
    const down = () => {
      w.classList.add('down');
      r.classList.remove('pulse');
      void r.offsetWidth;
      r.classList.add('pulse');
    };
    const up = () => w.classList.remove('down');
    const leave = () => w.classList.remove('on');
    const enter = () => seen && w.classList.add('on');

    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerover', over, { passive: true });
    addEventListener('pointerdown', down, { passive: true });
    addEventListener('pointerup', up, { passive: true });
    document.addEventListener('mouseleave', leave);
    document.addEventListener('mouseenter', enter);
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerover', over);
      removeEventListener('pointerdown', down);
      removeEventListener('pointerup', up);
      document.removeEventListener('mouseleave', leave);
      document.removeEventListener('mouseenter', enter);
      cancelAnimationFrame(raf);
      html.classList.remove('cc-hide');
      w.classList.remove('on');
    };
  }, [on, fine, hideNative]);

  if (!on || !fine) return null;
  return (
    <div className="cur" ref={wrap} data-state="idle" aria-hidden="true">
      <div className="cur-ring" ref={ring}>
        <div className="cur-blob" ref={blob} />
        <span className="cur-label" ref={label} />
      </div>
      <div className="cur-dot" ref={dot} />
    </div>
  );
}
