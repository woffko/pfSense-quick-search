/*
 * quicksearch_inline.js
 *
 * part of pfSense (https://www.pfsense.org)
 * Copyright (c) 2015-2025 Rubicon Communications, LLC (Netgate)
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * http://www.apache.org/licenses/LICENSE-2.0
 */

(function () {
  const BUILD          = 'InlineQuickSearch v2025-09-09-03';
  const PH_BASE_LABEL  = 'Find';
  const MIN_CHARS      = 3;      // minimum query length
  const IDLE_MS        = 3000;   // delay after last keystroke before auto-search

  // ---------- CSS ----------
  (function injectCss(){
    const id = 'qs-inline-style';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      #topmenu #pf-navbar .navbar-right{ display:flex; align-items:center; }
      #topmenu #pf-navbar .navbar-right > li{ display:flex; align-items:center; }
      #topmenu #pf-navbar .navbar-right > li > a{ display:flex; align-items:center; }

      /* host li for the search form */
      #topmenu #pf-navbar .navbar-right > li.qs-li{ margin:0; padding:0; }

      /* container form pinned to the right */
      #qs-inline-form.navbar-form.qs-inline{
        display:inline-flex; margin:0 !important; padding:0 !important; white-space:nowrap; position:relative;
      }
      #qs-inline-form .form-group{
        display:flex; align-items:stretch; gap:8px; margin:0;
      }

      /* input width (compact) */
      #qs-inline-input{ width:180px; min-width:140px; padding:6px 8px; }
      @media (max-width:1200px){ #qs-inline-input{ width:160px; } }
      @media (max-width: 992px){ #qs-inline-input{ width:140px; } }

      /* icon button — height is synced via JS to match input exactly */
      #qs-inline-icon.btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding:0 10px; line-height:normal; min-width:34px;
      }
      #qs-inline-icon svg{ width:16px; height:16px; pointer-events:none; }
      @keyframes qs-spin { from{ transform:rotate(0deg);} to{ transform:rotate(360deg);} }
      #qs-inline-icon.spinning svg{ animation: qs-spin .9s linear infinite; transform-origin: 50% 50%; }
      #qs-inline-icon:disabled{ opacity:.6; cursor:default; }

      /* dropdown panel */
      #qs-inline-dd{
        display:none; position:absolute; right:0; top:100%; margin-top:6px;
        width:480px; max-width:70vw; max-height:60vh; overflow:auto; z-index:100000;
        background:#fff; border:1px solid #e5e5e5; border-radius:10px;
        box-shadow:0 14px 30px rgba(0,0,0,.18);
      }
      #qs-inline-dd [data-row]{ padding:10px 12px; border-bottom:1px solid #f3f3f3; cursor:pointer; }
      #qs-inline-dd [data-row]:hover{ background:#f8f9fb; }
      #qs-inline-dd .t{ font-weight:600; color:#111; }
      #qs-inline-dd .p{ font-size:12px; color:#666; margin-top:2px; }
    `;
    document.head.appendChild(s);
  })();

  // ---------- helpers ----------
  const escapeHtml = s => (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const isPathLike = s => /^\/[A-Za-z0-9/_\-.]+(\?.*)?(#.*)?$/.test(s || '');
  const humanizePath = p => (p||'').split('/').pop().replace(/\.php$/i,'').replace(/_/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase());
  const debounce = (fn, ms) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

  function titleFromItem(it){
    let t = it.page || it.title || it.label || it.name || it.text || it.display || '';
    if (!t || isPathLike(t)) t = humanizePath(it.path || '');
    return t || (it.path||'');
  }
  const show = p => (p.style.display='block');
  const hide = p => { p.style.display='none'; p.innerHTML=''; };

  // Match icon height to input height (theme-agnostic)
  function syncHeights(icon, input){
    if (!icon || !input) return;
    requestAnimationFrame(() => {
      const h = Math.ceil(input.getBoundingClientRect().height);
      if (!h) return;
      icon.style.height = h + 'px';
      icon.style.minHeight = h + 'px';
      icon.style.lineHeight = h + 'px';
      // Uncomment to make the button perfectly square:
      // icon.style.width = h + 'px';
    });
  }

  // ---------- state ----------
  let idleTimer = null;   // triggers auto-search after typing idle
  let inflight = null;    // AbortController for the active fetch
  let busy = false;       // prevents rebuild clicks while searching
  let seq = 0;            // guards against out-of-order responses

  function setSpin(iconEl, spinning){
    if (!iconEl) return;
    if (spinning){
      iconEl.classList.add('spinning');
      iconEl.disabled = true;  // disable clicks while spinning/typing/searching
    } else {
      iconEl.classList.remove('spinning');
      iconEl.disabled = false; // enable click for rebuild-after-search
    }
  }
  function setBusy(iconEl, isBusy){
    busy = isBusy;
    setSpin(iconEl, isBusy);
  }

  // Core search: fetch results and render the dropdown
  function runQuery(q, panel, iconEl, {rebuild=false} = {}){
    const query = (q||'').trim();
    if (query.length < MIN_CHARS){ hide(panel); setSpin(iconEl, false); return; }

    // cancel previous request if any
    if (inflight){ inflight.abort(); inflight = null; }

    const controller = new AbortController();
    inflight = controller;
    setBusy(iconEl, true);
    const mySeq = ++seq;

    const url = '/diag_quicksearch.php?q=' + encodeURIComponent(query)
              + (rebuild ? '&rebuild=1' : '')
              + '&t=' + Date.now();

    fetch(url, { credentials:'same-origin', signal: controller.signal, cache:'no-store' })
      .then(r => r.json())
      .then(d => {
        if (mySeq !== seq) return; // stale response
        const items = d.items || [];
        if (!items.length){
          panel.innerHTML = `<div style="padding:10px 12px; color:#999; font-size:12px;">No results...</div>`;
          show(panel); return;
        }
        panel.innerHTML = items.map(it => {
          const title = titleFromItem(it);
          const path  = it.path || '';
          const second = (path && path !== title) ? `<div class="p">${escapeHtml(path)}</div>` : '';
          return `<div data-row role="option" data-path="${escapeHtml(path)}"><div class="t">${escapeHtml(title)}</div>${second}</div>`;
        }).join('');

        panel.querySelectorAll('[data-row]').forEach(row => {
          row.addEventListener('mouseover', () => {
            panel.querySelectorAll('[data-row]').forEach(r => r.style.background='');
            row.style.background='#f8f9fb';
          });
          row.addEventListener('click', () => {
            const path = row.getAttribute('data-path') || '';
            if (/^\/[A-Za-z0-9/_\-.]+(\?.*)?(#.*)?$/.test(path)) window.location.assign(path);
          });
        });
        show(panel);
      })
      .catch(err => {
        if (err && err.name === 'AbortError') return;
        panel.innerHTML = `<div style="padding:10px 12px; color:#c00; font-size:12px;">Request error</div>`;
        show(panel);
        console.error('[InlineQuickSearch] fetch error:', err);
      })
      .finally(() => {
        if (mySeq !== seq) return;
        setBusy(iconEl, false);
        inflight = null;
      });
  }

  // Rebuild-then-search (fixes the case where ?rebuild=1 clears cache but doesn't return results)
  async function rebuildThenSearch(q, panel, iconEl){
    const query = (q||'').trim();
    if (query.length < MIN_CHARS) return;

    // stop any running search
    if (inflight){ inflight.abort(); inflight = null; }

    setBusy(iconEl, true); // keep spinner during rebuild + search
    try {
      const url = '/diag_quicksearch.php?rebuild=1&t=' + Date.now();
      await fetch(url, { credentials:'same-origin', cache:'no-store' });
    } catch (e) {
      // Rebuild failures shouldn't block the follow-up search
      console.warn('[InlineQuickSearch] rebuild failed (continuing):', e);
    }
    // Now run a normal search with the same query
    runQuery(query, panel, iconEl, {rebuild:false});
  }

  // ---------- mount ----------
  function mount(){
    if (document.getElementById('qs-inline-form')) return;

    const nav = document.getElementById('topmenu');
    const rightList = nav && (nav.querySelector('#pf-navbar .navbar-right') || nav.querySelector('.navbar-right'));
    if (!rightList) return;

    const li = document.createElement('li');
    li.className = 'qs-li';

    const form = document.createElement('form');
    form.id = 'qs-inline-form';
    form.className = 'navbar-form qs-inline';
    form.setAttribute('role','search');
    form.setAttribute('autocomplete','off');
    form.innerHTML = `
      <div class="form-group">
        <input id="qs-inline-input" type="search"
               placeholder="${PH_BASE_LABEL}..."
               class="form-control input-sm" aria-label="Quick search">
        <button id="qs-inline-icon" type="button" class="btn btn-default btn-sm"
                title="Rebuild index & repeat search" aria-label="Rebuild index & repeat search">
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M15.5 14h-.79l-.28-.28A6.2 6.2 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.22-1.57l.28.28v.79L20 21.5 21.5 20l-6-6zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
        </button>
      </div>
      <div id="qs-inline-dd" role="listbox" aria-label="Search results"></div>
    `;
    li.appendChild(form);
    rightList.appendChild(li);

    const input = form.querySelector('#qs-inline-input');
    const icon  = form.querySelector('#qs-inline-icon');
    const panel = form.querySelector('#qs-inline-dd');

    // make the icon exactly as tall as the input (also on resize/theme changes)
    syncHeights(icon, input);
    window.addEventListener('resize', debounce(()=>syncHeights(icon, input), 100));

    // Auto-search after user stops typing for IDLE_MS
    const queueSearch = () => {
      setSpin(icon, true);               // spin as soon as typing starts
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const q = input.value.trim();
        if (q.length >= MIN_CHARS) {
          runQuery(q, panel, icon, {rebuild:false});
        } else {
          setSpin(icon, false);
          hide(panel);
        }
      }, IDLE_MS);
    };
    input.addEventListener('input', queueSearch);

    // Pressing Enter triggers immediate search (respecting MIN_CHARS)
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      setSpin(icon, true);
      runQuery(input.value.trim(), panel, icon, {rebuild:false});
    });

    // Clicking the icon after a search: rebuild cache, then repeat the same search
    icon.addEventListener('click', () => {
      if (busy) return;                            // ignore while a request is running
      const q = input.value.trim();
      if (q.length < MIN_CHARS) return;
      rebuildThenSearch(q, panel, icon);           // <-- fixed behavior
    });

    // Close the dropdown on outside click or ESC
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) hide(panel); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(panel); });

    console.log('[InlineQuickSearch]', BUILD, 'mounted');
  }

  // ---------- boot ----------
  (document.readyState === 'loading')
    ? document.addEventListener('DOMContentLoaded', mount, { once:true })
    : mount();
})();
