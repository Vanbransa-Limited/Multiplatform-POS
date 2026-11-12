/** Shared select UI for React screens, legacy views and the public menu.
 * The native select stays in its original parent as the form/state contract.
 */
export function installSelectControls(root = document) {
  if (!globalThis.HTMLDialogElement?.prototype.showModal) return () => {};
  const records = new Map();
  let active = null, sequence = 0;
  const normalise = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const labelFor = select => {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    let label = select.labels?.[0];
    let node = select;
    for (let depth = 0; !label && node && depth < 3; depth++, node = node.parentElement) {
      for (let previous = node.previousElementSibling; previous && !label; previous = previous.previousElementSibling) {
        if (previous.tagName === 'LABEL') label = previous;
      }
    }
    if (label) {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('select,input,button,.pos-select-trigger').forEach(node => node.remove());
      if (copy.textContent.trim()) return copy.textContent.trim();
    }
    return select.id?.replace(/[-_]/g, ' ') || 'Choose an option';
  };
  const close = () => {
    const menu = active;
    if (!menu) return;
    active = null;
    menu.record.trigger.setAttribute('aria-expanded', 'false');
    menu.record.trigger.removeAttribute('aria-controls');
    if (menu.dialog.open) menu.dialog.close();
    menu.dialog.remove();
    if (menu.scroller) menu.scroller.style.overflowY = menu.previousOverflow;
  };
  const position = () => {
    if (!active || matchMedia('(max-width: 767px)').matches) return;
    const rect = active.record.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 260), innerWidth - 24);
    const below = innerHeight - rect.bottom - 18;
    const above = rect.top - 18;
    const upward = below < 240 && above > below;
    const height = Math.max(100, Math.min(390, upward ? above : below));
    Object.assign(active.dialog.style, {
      width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
      top: `${upward ? Math.max(12, rect.top - Math.min(active.dialog.scrollHeight, height) - 6) : rect.bottom + 6}px`,
      maxHeight: `${height}px`,
    });
  };
  function open(record) {
    if (record.select.matches(':disabled') || record.select.hidden) return;
    close(); record.sync();
    const { select, trigger } = record;
    const title = labelFor(select);
    const dialog = document.createElement('dialog');
    const id = `select-menu-${++sequence}`;
    dialog.id = `${id}-dialog`;
    dialog.className = 'pos-select-menu';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = '<header class="pos-select-head"><h2></h2><button type="button" class="pos-select-close" aria-label="Close options"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="pos-select-search-wrap"><input type="search" class="pos-select-search" placeholder="Search options…" autocomplete="off" spellcheck="false"></div><div class="pos-select-list" role="listbox" tabindex="0"></div><p class="pos-select-empty" role="status" hidden>No matching options</p>';
    dialog.querySelector('h2').textContent = title;
    const search = dialog.querySelector('input');
    search.setAttribute('aria-label', `Search ${title}`);
    const list = dialog.querySelector('[role=listbox]');
    list.id = id; list.setAttribute('aria-label', title);
    const scroller = select.closest('.app-main-content');
    active = { dialog, record, scroller, previousOverflow: scroller?.style.overflowY, highlighted: -1, rows: [], selecting: false };
    const menu = active;
    if (scroller) scroller.style.overflowY = 'hidden';
    const optionsKey = () => JSON.stringify([select.selectedIndex, [...select.options].map(option => [option.label, option.value, option.disabled, option.hidden, option.parentElement?.label, option.parentElement?.disabled])]);
    menu.optionsKey = optionsKey();
    menu.readOptionsKey = optionsKey;
    const highlight = index => {
      if (!menu.rows.length) return;
      menu.highlighted = Math.max(0, Math.min(index, menu.rows.length - 1));
      menu.rows.forEach((row, i) => row.classList.toggle('is-highlighted', i === menu.highlighted));
      const row = menu.rows[menu.highlighted];
      list.setAttribute('aria-activedescendant', row.id);
      search.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    };
    const choose = index => {
      const option = select.options[index];
      if (!option || option.disabled || option.parentElement?.disabled || select.matches(':disabled')) return;
      menu.selecting = true;
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      record.sync(); close();
    };
    menu.render = () => {
      const query = normalise(search.value.trim());
      const fragment = document.createDocumentFragment();
      menu.rows = []; let lastGroup = null;
      [...select.options].forEach((option, index) => {
        if (option.hidden || !normalise(option.label).includes(query)) return;
        const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
        if (group && group !== lastGroup) {
          const heading = document.createElement('div'); heading.className = 'pos-select-group'; heading.textContent = group.label;
          fragment.append(heading);
        }
        lastGroup = group;
        const row = document.createElement('button');
        row.type = 'button'; row.tabIndex = -1; row.id = `${id}-option-${index}`;
        row.className = 'pos-select-option'; row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === select.selectedIndex));
        row.disabled = option.disabled || Boolean(group?.disabled);
        const text = document.createElement('span'); text.textContent = option.label || 'Choose an option'; row.append(text);
        if (index === select.selectedIndex) {
          const check = document.createElement('span'); check.className = 'pos-select-check'; check.setAttribute('aria-hidden', 'true');
          check.innerHTML = '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 10 4 4 8-8"/></svg>'; row.append(check);
        }
        row.addEventListener('click', () => choose(index));
        fragment.append(row);
        if (!row.disabled) menu.rows.push(row);
      });
      list.replaceChildren(fragment);
      dialog.querySelector('.pos-select-empty').hidden = list.querySelectorAll('[role=option]').length > 0;
      const selected = menu.rows.findIndex(row => row.getAttribute('aria-selected') === 'true');
      menu.highlighted = -1;
      if (menu.rows.length) highlight(selected >= 0 ? selected : 0);
      else { list.removeAttribute('aria-activedescendant'); search.removeAttribute('aria-activedescendant'); }
      position();
    };
    dialog.querySelector('.pos-select-search-wrap').hidden = select.options.length <= 7;
    search.addEventListener('input', menu.render);
    dialog.querySelector('.pos-select-close').addEventListener('click', close);
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (active === menu) close(); });
    let typed = '', typedAt = 0;
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault(); close();
        const targets = [...document.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(el => !el.matches(':disabled,.pos-select-native') && el.getBoundingClientRect().width && el.getBoundingClientRect().height && getComputedStyle(el).visibility !== 'hidden');
        const index = targets.indexOf(trigger); targets[index + (event.shiftKey ? -1 : 1)]?.focus(); return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(menu.highlighted + (event.key === 'ArrowDown' ? 1 : -1)); }
      else if (event.key === 'Home' && event.target !== search) { event.preventDefault(); highlight(0); }
      else if (event.key === 'End' && event.target !== search) { event.preventDefault(); highlight(menu.rows.length - 1); }
      else if (event.key === 'Enter' && (event.target === search || event.target === list)) { event.preventDefault(); const row = menu.rows[menu.highlighted]; row?.click(); }
      else if (event.target === list && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); typed = Date.now() - typedAt > 800 ? event.key : typed + event.key; typedAt = Date.now();
        const index = menu.rows.findIndex(row => normalise(row.textContent).startsWith(normalise(typed)));
        if (index >= 0) highlight(index);
      }
    });
    document.body.append(dialog);
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', dialog.id);
    dialog.showModal(); menu.render(); position();
    list.focus(); // Opening on a phone does not summon the keyboard.
  }
  function enhance(select) {
    if (records.has(select) || select.multiple || select.size > 1 || select.dataset.nativeSelect !== undefined) return;
    const trigger = document.createElement('button'); trigger.type = 'button';
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<span class="pos-select-value"></span><svg class="pos-select-chevron" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>';
    const error = document.createElement('span');
    error.className = 'pos-select-error'; error.id = `select-error-${++sequence}`; error.hidden = true; error.setAttribute('role', 'alert');
    const originalTabIndex = select.getAttribute('tabindex');
    const originalAriaHidden = select.getAttribute('aria-hidden');
    const hooks = [];
    const hook = (node, prototype, key) => {
      if (Object.hasOwn(node, key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor?.get || !descriptor.set) return;
      const get = function () { return descriptor.get.call(this); };
      Object.defineProperty(node, key, { configurable: true, get, set(value) { descriptor.set.call(this, value); record.sync(); } });
      return () => { if (Object.getOwnPropertyDescriptor(node, key)?.get === get) delete node[key]; };
    };
    const optionHooks = new Map();
    const record = { select, trigger, sync() {
      if (!select.isConnected) return;
      if (select.nextElementSibling !== trigger) select.after(trigger);
      if (trigger.nextElementSibling !== error) trigger.after(error);
      trigger.className = `${select.className.replace(/\bpos-select-native\b/g, '').trim()} pos-select-trigger`;
      trigger.style.cssText = select.style.cssText;
      trigger.hidden = select.hidden || select.style.display === 'none' || select.classList.contains('hidden');
      trigger.disabled = select.matches(':disabled');
      if (select.validity.valid) {
        trigger.removeAttribute('aria-invalid'); trigger.title = select.title; error.hidden = true;
        if (select.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
        else trigger.removeAttribute('aria-describedby');
      }
      trigger.setAttribute('aria-label', labelFor(select)); trigger.setAttribute('aria-required', String(select.required));
      const value = select.selectedOptions[0]?.label || select.getAttribute('data-placeholder') || 'Choose an option';
      const label = trigger.querySelector('.pos-select-value'); if (label.textContent !== value) label.textContent = value;
      const currentOptions = new Set(select.options);
      for (const [option, undo] of optionHooks) if (!currentOptions.has(option)) { undo?.(); optionHooks.delete(option); }
      currentOptions.forEach(option => {
        if (!optionHooks.has(option)) optionHooks.set(option, hook(option, HTMLOptionElement.prototype, 'selected'));
      });
      if (active?.record === record && !active.selecting) {
        if (trigger.disabled || trigger.hidden) close();
        else {
          const key = active.readOptionsKey();
          if (key !== active.optionsKey) { active.optionsKey = key; active.render(); }
        }
      }
    }, destroy() {
      if (active?.record === record) close();
      hooks.forEach(undo => undo?.()); optionHooks.forEach(undo => undo?.()); select.classList.remove('pos-select-native');
      if (originalTabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', originalTabIndex);
      if (originalAriaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', originalAriaHidden);
      select.removeEventListener('input', sync); select.removeEventListener('change', sync); select.removeEventListener('focus', focus); select.removeEventListener('invalid', invalid); select.removeEventListener('click', click);
      trigger.remove(); error.remove(); records.delete(select);
    } };
    const sync = () => record.sync();
    const focus = () => trigger.focus();
    const click = event => { event.preventDefault(); open(record); };
    const invalid = event => {
      event.preventDefault(); trigger.setAttribute('aria-invalid', 'true'); trigger.title = select.validationMessage;
      error.textContent = select.validationMessage; error.hidden = false;
      trigger.setAttribute('aria-describedby', [select.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' ')); trigger.focus();
    };
    records.set(select, record);
    hooks.push(hook(select, HTMLSelectElement.prototype, 'value'), hook(select, HTMLSelectElement.prototype, 'selectedIndex'));
    select.classList.add('pos-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    select.after(trigger); record.sync();
    trigger.addEventListener('click', () => open(record));
    trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); open(record); } });
    select.addEventListener('input', sync); select.addEventListener('change', sync); select.addEventListener('focus', focus); select.addEventListener('click', click); select.addEventListener('invalid', invalid);
  }
  const scan = node => {
    if (!(node instanceof Element) && node !== root) return;
    if (node.matches?.('select')) enhance(node);
    node.querySelectorAll?.('select').forEach(enhance);
  };
  scan(root);
  const observer = new MutationObserver(changes => {
    let removed = false;
    for (const change of changes) {
      if (change.type === 'childList') { change.addedNodes.forEach(scan); removed ||= change.removedNodes.length > 0; }
      const target = change.target.nodeType === 3 ? change.target.parentElement : change.target;
      const select = target?.closest?.('select');
      if (select) {
        if (select.multiple || select.size > 1) records.get(select)?.destroy();
        else { enhance(select); records.get(select)?.sync(); }
      }
      if (target?.matches?.('fieldset')) target.querySelectorAll('select').forEach(select => records.get(select)?.sync());
    }
    if (removed) for (const [select, record] of records) if (!select.isConnected) record.destroy();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'required', 'hidden', 'style', 'class', 'label', 'selected', 'multiple', 'size', 'aria-label'] });
  const reset = () => setTimeout(() => records.forEach(record => record.sync()), 0);
  const scroll = event => { if (active && !active.dialog.contains(event.target)) position(); };
  root.addEventListener('reset', reset); window.addEventListener('resize', position); root.addEventListener('scroll', scroll, true);
  return () => { observer.disconnect(); close(); root.removeEventListener('reset', reset); window.removeEventListener('resize', position); root.removeEventListener('scroll', scroll, true); [...records.values()].forEach(record => record.destroy()); };
}
