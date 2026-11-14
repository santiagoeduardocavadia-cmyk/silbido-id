/**
 * Controles propios que reemplazan a los nativos del navegador (que no se pueden estilizar bien):
 *  - <input type="range">: se pinta el tramo recorrido con la variable CSS --p.
 *  - <select>: se oculta y se muestra un botón + lista desplegable con el estilo de la app.
 * El elemento original sigue siendo la fuente de verdad (value, change, disabled, opciones),
 * así que el resto del código no cambia.
 */
const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

const CHEVRON = '<svg viewBox="0 0 12 8" width="12" height="8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let openList = null; // { close() } de la lista abierta (solo una a la vez)

// ---------- sliders ----------
export function enhanceRange(input) {
  if (input.dataset.enhanced) return;
  input.dataset.enhanced = '1';
  const paint = () => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const v = Number(input.value);
    input.style.setProperty('--p', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
  };
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return inputValue.get.call(this);
    },
    set(v) {
      inputValue.set.call(this, v);
      paint();
    },
  });
  input.addEventListener('input', paint);
  new MutationObserver(paint).observe(input, { attributes: true, attributeFilter: ['min', 'max', 'step'] });
  paint();
}

// ---------- listas desplegables ----------
export function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cselect-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<span class="cselect-label"></span><span class="cselect-chev">${CHEVRON}</span>`;
  sel.parentNode.insertBefore(wrap, sel);
  wrap.append(btn, sel);
  sel.classList.add('cselect-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  const labelEl = btn.querySelector('.cselect-label');

  const refresh = () => {
    const o = sel.options[sel.selectedIndex];
    labelEl.textContent = o ? o.textContent : '';
    btn.disabled = sel.disabled;
    wrap.classList.toggle('is-disabled', sel.disabled);
  };
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() {
      return selectValue.get.call(this);
    },
    set(v) {
      selectValue.set.call(this, v);
      refresh();
    },
  });
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  sel.addEventListener('change', refresh);
  refresh();

  // Nombre accesible: toma el texto de la etiqueta que envuelve al control
  const lab = sel.closest('label');
  if (lab) {
    const t = lab.querySelector(':scope > span:not(.cselect-label)');
    if (t) btn.setAttribute('aria-label', `${t.textContent.trim()}: ${labelEl.textContent}`);
  }

  function open() {
    if (btn.disabled) return;
    if (openList) openList.close();
    const list = document.createElement('ul');
    list.className = 'cselect-list';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    Array.from(sel.options).forEach((o, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.tabIndex = -1;
      li.dataset.i = String(i);
      li.setAttribute('aria-selected', String(i === sel.selectedIndex));
      li.innerHTML = `<span>${o.textContent}</span><span class="cselect-tick">${CHECK}</span>`;
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      list.appendChild(li);
    });
    document.body.appendChild(list);
    const r = btn.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    const h = list.offsetHeight;
    const below = window.innerHeight - r.bottom;
    const up = below < h + 12 && r.top > below;
    list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - list.offsetWidth - 8))}px`;
    list.style.top = `${up ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    list.style.maxHeight = `${Math.max(120, (up ? r.top : below) - 20)}px`;
    list.classList.toggle('up', up);
    btn.setAttribute('aria-expanded', 'true');
    wrap.classList.add('is-open');

    const items = Array.from(list.children);
    const focusItem = (i) => {
      const k = Math.max(0, Math.min(items.length - 1, i));
      items[k].focus();
      items[k].scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => {
      const o = sel.options[i];
      if (!o || o.disabled) return;
      const changed = i !== sel.selectedIndex;
      sel.selectedIndex = i;
      refresh();
      close(true);
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const onDown = (e) => {
      if (!list.contains(e.target) && !btn.contains(e.target)) close();
    };
    const onKey = (e) => {
      const cur = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusItem(cur + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusItem(cur < 0 ? 0 : cur - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusItem(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusItem(items.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (cur >= 0) pick(cur);
      } else if (e.key === 'Tab') close();
      else if (e.key.length === 1) {
        const k = items.findIndex((li, i) => i > cur && li.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
        if (k >= 0) focusItem(k);
      }
    };
    const onClick = (e) => {
      const li = e.target.closest('li');
      if (li) pick(Number(li.dataset.i));
    };
    const onHover = (e) => {
      const li = e.target.closest('li');
      if (li && li !== document.activeElement) li.focus({ preventScroll: true });
    };
    const reposition = () => close();
    function close(refocus = false) {
      list.remove();
      btn.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('is-open');
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      list.removeEventListener('keydown', onKey);
      openList = null;
      if (refocus) btn.focus();
    }
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    list.addEventListener('keydown', onKey);
    list.addEventListener('click', onClick);
    list.addEventListener('mousemove', onHover);
    openList = { close };
    focusItem(Math.max(0, sel.selectedIndex));
  }

  btn.addEventListener('click', () => (wrap.classList.contains('is-open') ? openList && openList.close(true) : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
}

/** Aplica los controles propios a todo lo que haya en el documento. */
export function enhanceControls(root = document) {
  root.querySelectorAll('input[type="range"]').forEach(enhanceRange);
  root.querySelectorAll('select').forEach(enhanceSelect);
}
