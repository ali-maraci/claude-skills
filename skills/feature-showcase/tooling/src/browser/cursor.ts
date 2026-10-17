// Injected into every document of the recorded context: a visible cursor that
// follows real mouse events, plus a ripple on mousedown. Hidden until the first move
// so card scenes show no cursor.
export const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__fsCursor) return;
  window.__fsCursor = true;
  const install = () => {
    const c = document.createElement('div');
    Object.assign(c.style, {
      position: 'fixed', left: '0px', top: '0px', width: '22px', height: '22px',
      marginLeft: '-11px', marginTop: '-11px', borderRadius: '50%', display: 'none',
      background: 'rgba(15,23,42,0.35)', border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.45)',
      zIndex: '2147483647', pointerEvents: 'none', transition: 'transform 120ms ease',
    });
    document.documentElement.appendChild(c);
    document.addEventListener('mousemove', (e) => {
      c.style.display = 'block'; c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px';
    }, true);
    document.addEventListener('mousedown', (e) => {
      c.style.transform = 'scale(0.7)';
      const r = document.createElement('div');
      Object.assign(r.style, {
        position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px', width: '10px', height: '10px',
        marginLeft: '-5px', marginTop: '-5px', borderRadius: '50%', border: '3px solid rgba(20,184,166,.9)',
        zIndex: '2147483646', pointerEvents: 'none', transition: 'all 450ms ease-out',
      });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => Object.assign(r.style, { width: '64px', height: '64px', marginLeft: '-32px', marginTop: '-32px', opacity: '0' }));
      setTimeout(() => r.remove(), 500);
    }, true);
    document.addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  };
  if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded', install);
})();`;
