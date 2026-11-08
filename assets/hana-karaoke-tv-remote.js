/* LG webOS remote navigation. Local UI only: never sends TV keys to the DB. */
(() => {
  'use strict';
  const selector = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,[tabindex]';
  function candidates() {
    return [...document.querySelectorAll(selector)].filter(element => {
      if (element.disabled || element.tabIndex < 0 || element.closest('[hidden],[inert]')) return false;
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
  }
  function focus(element) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function move(direction) {
    const items = candidates();
    if (!items.length) return;
    const active = document.activeElement, index = items.indexOf(active);
    if (index < 0) { focus(items[0]); return; }
    const from = active.getBoundingClientRect();
    const fx = from.x + from.width / 2, fy = from.y + from.height / 2;
    const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
    const sign = ['ArrowLeft', 'ArrowUp'].includes(direction) ? -1 : 1;
    let best = null, score = Infinity;
    for (const item of items) {
      if (item === active) continue;
      const rect = item.getBoundingClientRect();
      const dx = rect.x + rect.width / 2 - fx, dy = rect.y + rect.height / 2 - fy;
      const forward = (horizontal ? dx : dy) * sign;
      if (forward < 3) continue;
      const distance = forward + Math.abs(horizontal ? dy : dx) * 2;
      if (distance < score) { best = item; score = distance; }
    }
    // A single-row control bar also supports Up/Down, with wrap-around.
    focus(best || items[(index + sign + items.length) % items.length]);
  }
  document.addEventListener('focusin', event => {
    document.querySelectorAll('.tv-focus').forEach(element => element.classList.remove('tv-focus'));
    if (event.target.matches?.(selector)) event.target.classList.add('tv-focus');
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key || ({ 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 461: 'BrowserBack' })[event.keyCode];
    if ((key === 'BrowserBack' || event.keyCode === 461) && document.body.classList.contains('tv-display')) {
      event.preventDefault(); document.getElementById('screenSettings').click(); return;
    }
    const active = document.activeElement;
    if (active?.tagName === 'SELECT' || active?.tagName === 'TEXTAREA') return;
    const textInput = active?.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(active.type);
    // Preserve text caret editing, the native select, and all YouTube controls.
    if (textInput && ['ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      event.preventDefault(); move(key);
    } else if (key === 'Enter' && active?.matches('button,a[href],input[type="checkbox"],input[type="radio"],summary')) {
      event.preventDefault(); if (!active.disabled) active.click();
    }
  });
})();
