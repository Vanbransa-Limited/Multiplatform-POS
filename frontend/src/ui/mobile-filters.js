// Reuse the actual filter controls so their values, listeners and existing
// filtering logic survive moving between the desktop toolbar and phone sheet.
export function createMobileFilters({ container, toolbar, controls, title = 'Filters', buttonLabel = 'Filters', count = () => 0, reset, closeOnSelect = false, doneLabel = 'Show results' }) {
  const nodes = controls.filter(Boolean);
  if (!toolbar || !nodes.length) return { dispose() {} };
  const id = `${container.id || 'screen'}-filters`;
  const homes = nodes.map(node => {
    const home = document.createElement('div');
    home.className = 'mobile-filter-home';
    node.before(home); home.append(node);
    return home;
  });
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'mobile-filter-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', id); trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2M11 3v6M5 9v6m10 0v6"/></svg><span>Filters</span><small hidden></small>';
  trigger.querySelector('span').textContent = buttonLabel;
  toolbar.append(trigger);
  const dialog = document.createElement('dialog');
  dialog.id = id; dialog.className = 'mobile-filter-sheet';
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.innerHTML = `<div class="mobile-filter-panel"><header><h2 id="${id}-title"></h2><button type="button" class="mobile-filter-close" aria-label="Close filters" autofocus><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="mobile-filter-body"></div><footer><button type="button" class="mobile-filter-reset">Reset</button><button type="button" class="mobile-filter-show">Show results</button></footer></div>`;
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('.mobile-filter-show').textContent = doneLabel;
  if (closeOnSelect) dialog.querySelector('.mobile-filter-close').setAttribute('aria-label', 'Close actions');
  container.append(dialog);
  const body = dialog.querySelector('.mobile-filter-body');
  const breakpoint = window.matchMedia('(max-width: 767px)');
  let scroller, previousOverflow;
  const update = () => {
    const total = count();
    const badge = trigger.querySelector('small');
    badge.hidden = !total; badge.textContent = String(total);
    trigger.setAttribute('aria-label', `${title}${total ? `, ${total} active` : ''}`);
  };
  const restore = () => {
    nodes.forEach((node, i) => { if (homes[i].isConnected) homes[i].append(node); });
    if (scroller) { scroller.style.overflowY = previousOverflow; scroller = null; }
    trigger.setAttribute('aria-expanded', 'false'); update();
  };
  const close = () => { if (dialog.open) dialog.close(); restore(); };
  // Dismiss before the original handler opens an editor or a native file
  // picker. Keeping the action sheet modal would otherwise cover that UI.
  dialog.addEventListener('click', event => {
    if (!closeOnSelect) return;
    const button = event.target.closest('button');
    if (button && nodes.some(node => node === button || node.contains(button))) close();
  }, true);
  trigger.addEventListener('click', () => {
    if (!breakpoint.matches) return;
    nodes.forEach(node => body.append(node));
    scroller = container.closest('.app-main-content');
    if (scroller) { previousOverflow = scroller.style.overflowY; scroller.style.overflowY = 'hidden'; }
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true');
    dialog.querySelector('.mobile-filter-close').focus(); update();
  });
  dialog.addEventListener('close', restore);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.querySelector('.mobile-filter-close').addEventListener('click', close);
  dialog.querySelector('.mobile-filter-show').addEventListener('click', close);
  dialog.querySelector('.mobile-filter-reset').addEventListener('click', () => { reset?.(); queueMicrotask(update); });
  dialog.querySelector('.mobile-filter-reset').hidden = !reset;
  const refresh = () => queueMicrotask(update);
  container.addEventListener('input', refresh);
  container.addEventListener('change', refresh);
  container.addEventListener('click', refresh);
  const observer = new MutationObserver(refresh);
  nodes.forEach(node => observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }));
  const resize = () => { if (!breakpoint.matches) close(); };
  breakpoint.addEventListener('change', resize); update();
  return { close, dispose() {
    observer.disconnect(); close();
    breakpoint.removeEventListener('change', resize);
    container.removeEventListener('input', refresh); container.removeEventListener('change', refresh); container.removeEventListener('click', refresh);
    trigger.remove(); dialog.remove();
    nodes.forEach((node, i) => { if (homes[i].isConnected) homes[i].replaceWith(node); });
  } };
}
