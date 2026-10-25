// Numbers that count up once, the first time they scroll into view. The final text is in the page from the start, so
// nothing depends on the animation: with Motion off (or no IntersectionObserver) the number simply sits there.
import { useEffect, useRef } from 'react';
import { useMotion } from './motion';

const NUM = /\d[\d,]*(?:\.\d+)?/;

/** Display financial evidence exactly, never as a transient rounded count-up frame. */
export const shouldAnimateCountUp = (text: string) => !text.includes('₹');

function render(text: string, value: number, decimals: number, grouped: boolean) {
  const m = NUM.exec(text)!;
  const body = grouped ? value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : value.toFixed(decimals);
  return text.slice(0, m.index) + body + text.slice(m.index + m[0].length);
}

/** `armed` (default true) lets a caller hold the count until something else has happened, e.g. a scroll scene reaching its end. */
export function CountUp({ text, className, armed = true }: { text: string; className?: string; armed?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { on } = useMotion();
  useEffect(() => {
    const el = ref.current;
    const m = NUM.exec(text);
    // A screenshot near the end of the 1.1s animation can show ₹8,35,543
    // instead of the actual ₹8,35,622. Never animate money; keep other counters.
    if (!el || !m || !on || !armed || !shouldAnimateCountUp(text) || typeof IntersectionObserver === 'undefined') return;
    const target = parseFloat(m[0].replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0) return;
    const decimals = m[0].includes('.') ? m[0].split('.')[1].length : 0;
    const grouped = m[0].includes(',');
    let raf = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const dur = 1100;
        const tick = (now: number) => {
          const k = Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - k, 3);
          el.textContent = render(text, k < 1 ? target * e : target, decimals, grouped);
          if (k < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [text, on, armed]);
  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
