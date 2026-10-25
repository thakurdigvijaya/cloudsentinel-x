// Small motion helpers shared by the landing page and the workspace. Nothing here changes what the page says:
// it only adds depth (tilt toward the pointer, cards that rise out of the page as you scroll).
// Every helper does nothing when Motion is off or the device has no fine pointer, and removes everything it added.

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const finePointer = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * Tilt toward the pointer, with a glare that follows it. Delegated on `root`, so cards that appear later work too.
 * Uses the individual `rotate` property (axis + angle) so it never fights an element's own `transform`.
 * The parent of a tilted element needs `perspective` in CSS, or the tilt looks flat.
 */
export function attachTilt(root: HTMLElement, selector: string, maxDeg: number): () => void {
  let active: HTMLElement | null = null;
  let queued = false;
  let ev: PointerEvent | null = null;
  const reset = (el: HTMLElement | null) => {
    if (!el) return;
    el.classList.remove('tilting');
    el.style.setProperty('--ax', '0');
    el.style.setProperty('--ay', '0');
    el.style.setProperty('--az', '1');
    el.style.setProperty('--ang', '0deg');
  };
  const apply = () => {
    queued = false;
    if (!ev || !active) return;
    const r = active.getBoundingClientRect();
    const px = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const py = clamp((ev.clientY - r.top) / r.height, 0, 1);
    const rx = -(py - 0.5) * 2 * maxDeg; // rotateX: top edge away when the pointer is near the top
    const ry = (px - 0.5) * 2 * maxDeg;
    const ang = Math.hypot(rx, ry);
    active.classList.add('tilting');
    active.style.setProperty('--ax', rx.toFixed(3));
    active.style.setProperty('--ay', ry.toFixed(3));
    active.style.setProperty('--az', '0');
    active.style.setProperty('--ang', `${ang.toFixed(2)}deg`);
    active.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
    active.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const el = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
    if (el !== active) {
      reset(active);
      active = el;
      if (el) el.dataset.tilt = '1';
    }
    if (!el) return;
    ev = e;
    if (!queued) {
      queued = true;
      requestAnimationFrame(apply);
    }
  };
  const leave = () => {
    reset(active);
    active = null;
  };
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerleave', leave);
  return () => {
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerleave', leave);
    reset(active);
  };
}

/**
 * Workspace depth: cards rise out of the page the first time they scroll into view, and keep a slight 3D lean while
 * they travel (leaning back as they enter from the bottom, leaning forward as they leave at the top).
 * `container` is the screen; returns a cleanup. Elements are tagged `.d3` only while Motion is on, so with Motion off
 * (or no IntersectionObserver) every card is simply visible.
 */
export function attachDepth(container: HTMLElement, selector: string): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const vh0 = innerHeight;
  // outermost cards only, and never a card taller than about one and a half screens: tipping a huge card back around its
  // far edge would throw its visible part off the page
  const all = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.parentElement?.closest(selector) && el.getBoundingClientRect().height < vh0 * 1.5);
  if (all.length === 0) return () => {};
  let shown = 0;
  for (const el of all) {
    const top = el.getBoundingClientRect().top;
    el.classList.add('d3');
    if (top < vh0) {
      // already on screen when the page opens: they come in one after another
      el.style.transitionDelay = `${Math.min(shown++, 7) * 75}ms`;
    }
  }
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          const el = e.target as HTMLElement;
          el.classList.add('in');
          io.unobserve(el);
          // the stagger is only for the first reveal; scrolling afterwards must feel immediate
          window.setTimeout(() => (el.style.transitionDelay = ''), 1400);
        }
      }),
    { threshold: 0, rootMargin: '0px 0px -7% 0px' },
  );
  all.forEach((el) => io.observe(el));

  let queued = false;
  const lean = () => {
    queued = false;
    const vh = innerHeight;
    const rects = all.map((el) => el.getBoundingClientRect());
    for (let i = 0; i < all.length; i++) {
      const r = rects[i];
      const el = all[i];
      if (r.bottom < -vh * 0.4 || r.top > vh * 1.4) continue;
      const mid = (r.top + r.height / 2 - vh / 2) / (vh / 2); // -1 at the top edge, +1 at the bottom edge, 0 when centred
      // entering from below: lean back up to 9deg; leaving above: lean forward up to 6deg
      const deg = mid > 0 ? clamp(mid - 0.25, 0, 1) * 9 : -clamp(-mid - 0.35, 0, 1) * 6;
      el.style.setProperty('--sr', deg.toFixed(2));
    }
  };
  const onScroll = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(lean);
    }
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  lean();
  return () => {
    io.disconnect();
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onScroll);
    all.forEach((el) => {
      el.classList.remove('d3', 'in');
      el.style.removeProperty('--sr');
      el.style.transitionDelay = '';
    });
  };
}
