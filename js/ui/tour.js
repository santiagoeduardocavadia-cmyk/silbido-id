// Recorrido guiado: resalta una tarjeta tras otra y explica qué hizo el sistema en ese paso.
// steps: [{ el: Element, title, html }]
let active = null;

export function startTour(steps, { onEnd } = {}) {
  endTour();
  const list = steps.filter((s) => s.el && s.el.offsetParent !== null);
  if (!list.length) return;
  const spot = document.createElement('div');
  spot.className = 'tour-spot';
  const box = document.createElement('div');
  box.className = 'tour-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'false');
  box.setAttribute('aria-label', 'Cómo se identificó el silbido');
  document.body.append(spot, box);
  let i = 0;
  let timer = 0;
  let playing = false;

  const place = () => {
    const s = list[i];
    const r = s.el.getBoundingClientRect();
    const pad = 8;
    Object.assign(spot.style, {
      top: `${r.top - pad}px`,
      left: `${r.left - pad}px`,
      width: `${r.width + 2 * pad}px`,
      height: `${r.height + 2 * pad}px`,
    });
    const bw = Math.min(420, window.innerWidth - 24);
    box.style.width = `${bw}px`;
    const bh = box.offsetHeight;
    let top = r.bottom + 16;
    if (top + bh > window.innerHeight - 12) top = r.top - bh - 16;
    if (top < 12) top = window.innerHeight - bh - 12;
    const left = Math.max(12, Math.min(window.innerWidth - bw - 12, r.left + r.width / 2 - bw / 2));
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
  };

  const show = (k) => {
    i = Math.max(0, Math.min(list.length - 1, k));
    const s = list[i];
    box.innerHTML = `<div class="tour-head"><span class="tour-step">Paso ${i + 1} de ${list.length}</span><button type="button" class="tour-x" data-t="end" aria-label="Cerrar">×</button></div>
      <h3>${s.title}</h3><div class="tour-body">${s.html}</div>
      <div class="tour-dots">${list.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('')}</div>
      <div class="tour-nav"><button type="button" class="btn ghost sm" data-t="prev" ${i === 0 ? 'disabled' : ''}>Anterior</button>
      <button type="button" class="btn ghost sm" data-t="play">${playing ? 'Pausa' : 'Reproducir'}</button>
      <button type="button" class="btn primary sm" data-t="next">${i === list.length - 1 ? 'Terminar' : 'Siguiente'}</button></div>`;
    s.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    place();
    setTimeout(place, 380);
    box.querySelector('[data-t="next"]').focus({ preventScroll: true });
  };

  const next = () => (i === list.length - 1 ? endTour() : show(i + 1));
  const autoplay = () => {
    clearTimeout(timer);
    if (!playing) return;
    timer = setTimeout(() => {
      if (i === list.length - 1) {
        playing = false;
        show(i);
        return;
      }
      show(i + 1);
      autoplay();
    }, 5200);
  };

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    if (t === 'end') endTour();
    else if (t === 'prev') show(i - 1);
    else if (t === 'next') next();
    else if (t === 'play') {
      playing = !playing;
      show(i);
      autoplay();
    }
  });
  const onKey = (e) => {
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') show(i - 1);
  };
  const onMove = () => place();
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onMove, { passive: true });
  window.addEventListener('resize', onMove);
  active = () => {
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onMove);
    window.removeEventListener('resize', onMove);
    spot.remove();
    box.remove();
    if (onEnd) onEnd();
  };
  show(0);
}

export function endTour() {
  if (active) {
    const f = active;
    active = null;
    f();
  }
}
