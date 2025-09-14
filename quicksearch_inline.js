/*
 * quicksearch_inline.js
 *
 * part of pfSense (https://www.pfsense.org)
 * Copyright (c) 2015-2025 Rubicon Communications, LLC (Netgate)
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Overlay Quick Search opened from a compact blue magnifier icon.
 * - Keyboard nav (↑/↓, ←/→, Home/End, Enter, Esc)
 * - "Whole words only" toggle (server-side via ?ww=1 or ?ww=0)
 * - Smart grouping (":" and "/" treated as separators)
 * - Groups first (by size desc, then name), singles after (alphabetical)
 * - Navbar icon mounted right AFTER the Help menu item (fallback to right cluster)
 * - Fine-grained top alignment to pfSense logo via NUDGE_TOP
 * - In-panel magnifier spins while searching; click it to rebuild index
 */

(function () {
  // -------------------- Tunables --------------------
  const BUILD         = 'InlineQuickSearch v2025-09-14-after-help-mount-fix-li+keydown-single';
  const PH_BASE_LABEL = 'Find';
  const MIN_CHARS     = 3;
  const IDLE_MS       = 100;

  // Small visual fine-tune so the icon perfectly matches the logo top
  // (many themes draw 1–2px line/padding differences).
  const NUDGE_TOP     = -5;  // negative = move a bit higher

  // Host container where the navbar button was mounted (left or right).
  // We use it for vertical alignment computations.
  let qsHostEl = null;

  // Debounce helper
  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  // -------------------- CSS --------------------
  (function injectCss(){
    if (document.getElementById('qs-style-overlay')) return;
    const s = document.createElement('style');
    s.id = 'qs-style-overlay';
    s.textContent = `
      /* IMPORTANT: Use Bootstrap-compatible LI for navbar to avoid hiding/overlap */
      #qs-nav-li{
        display:block;               /* no flex here — keep Bootstrap expectations */
        float:left;                  /* .navbar-nav > li normally floats left */
      }

      #qs-nav-icon{
        --qs-size: 28px;
        position:relative; z-index:2; /* keep above neighboring anchors */
        display:inline-flex; align-items:center; justify-content:center;
        width:var(--qs-size); height:var(--qs-size);
        margin-left:8px; border-radius:8px;
        cursor:pointer; user-select:none; outline:none;
        background:#0b6efd; color:#fff; border:0; line-height:1; padding:0;
        /* margin-top is computed in JS to align its TOP to the logo TOP */
      }
      #qs-nav-icon:focus-visible{ box-shadow:0 0 0 3px rgba(11,110,253,.35); }
      #qs-nav-icon svg{ width:60%; height:60%; pointer-events:none; }

      #qs-overlay{ position:fixed; left:0; right:0; top:52px; display:none; z-index:100001; }
      #qs-overlay.open{ display:block; }

      #qs-panel{
        margin:0 auto; max-width:960px; width:min(90vw,960px);
        background:#fff; color:#222; border-radius:12px;
        border:1px solid #e5e7eb; box-shadow:0 18px 40px rgba(0,0,0,.45); overflow:hidden;
      }
      @media (prefers-color-scheme: dark){
        #qs-panel{ background:#1f1f1f; color:#e7e7e7; border-color:rgba(0,0,0,.2); }
      }

      #qs-top{ display:flex; align-items:center; gap:10px; padding:12px; border-bottom:1px solid rgba(0,0,0,.08); }
      #qs-input{
        flex:1 1 auto; height:36px; padding:6px 10px; border-radius:8px;
        border:1px solid rgba(0,0,0,.15); background:transparent; color:inherit;
      }
      #qs-input::placeholder{ opacity:.7; }
      #qs-whole{ display:flex; align-items:center; gap:6px; white-space:nowrap; font-size:12px; opacity:.9; }

      /* In-panel action button: magnifier spins while searching. Click to rebuild index. */
      #qs-action{
        display:inline-flex; align-items:center; justify-content:center;
        width:36px; height:36px; border-radius:8px; border:1px solid rgba(0,0,0,.15);
        background:transparent; cursor:pointer; color:inherit;
      }
      #qs-action:disabled{ opacity:.5; cursor:default; }
      #qs-action svg{ width:18px; height:18px; pointer-events:none; }

      /* Spinner animation for the magnifier */
      @keyframes qs-rot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      #qs-action.spin svg{ animation: qs-rot .9s linear infinite; transform-origin: 50% 50%; }

      #qs-list{ max-height:65vh; overflow:auto; padding:0; margin:0; }
      .qs-row{ list-style:none; display:flex; align-items:center; gap:14px;
               padding:12px 14px; border-bottom:1px solid rgba(0,0,0,.06);
               cursor:pointer; outline:none; }
      .qs-row:hover{ background:rgba(0,0,0,.06); }
      .qs-row.focused{ background:rgba(13,110,253,.12); }
      @media (prefers-color-scheme: dark){
        .qs-row:hover{ background:rgba(255,255,255,.06); }
        .qs-row.focused{ background:rgba(13,110,253,.22); }
      }
      .qs-title{ flex:1 1 auto; font-weight:600; }
      .qs-path{ flex:0 0 auto; font-size:12px; opacity:.75; }

      .qs-group{ font-weight:600; }
      .qs-group .qs-title{ display:flex; align-items:center; gap:10px; }
      .qs-caret{
        width:10px; height:10px; display:inline-block;
        border: solid currentColor; border-width: 0 2px 2px 0; padding:2px;
        transform: rotate(-45deg);
      }
      .qs-row[aria-expanded="true"] .qs-caret{ transform: rotate(45deg); }
      .qs-child{ padding-left:36px; font-weight:500; }

      .qs-badge{
        min-width:26px; height:22px; padding:0 8px; display:inline-flex;
        align-items:center; justify-content:center; border-radius:999px;
        font-size:12px; font-weight:700; border:1px solid currentColor; opacity:.8;
      }

      #qs-empty{ padding:10px 14px; font-size:12px; opacity:.8; display:none; border-top:1px solid rgba(0,0,0,.06); }
      .hidden{ display:none !important; }
    `;
    document.head.appendChild(s);
  })();

  // -------------------- i18n --------------------
  let I18N = null;
  const L = (k, dflt) => (I18N && typeof I18N[k] === 'string') ? I18N[k] : dflt;
  async function loadI18n(){
    try{
      const r = await fetch('/diag_quicksearch.php?i18n=1&t=' + Date.now(), { credentials:'same-origin', cache:'no-store' });
      if (r.ok) I18N = await r.json();
    }catch(_e){}
  }

  // -------------------- helpers --------------------
  const escapeHtml   = s => (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const humanizePath = p => (p||'').split('/').pop().replace(/\.php$/i,'').replace(/_/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase());

  function titleFromItem(it){
    let t = it.page || it.title || it.label || it.name || it.text || it.display || '';
    if (!t || /^\/[A-Za-z0-9/_\-.]+/.test(t)) t = humanizePath(it.path || '');
    return t || (it.path||'');
  }

  // -------------------- navbar icon (mounted after Help menu) --------------------
  function ensureNavIcon(){
    if (document.getElementById('qs-nav-icon')) return;

    const nav   = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top') || document;
    // Prefer the LEFT primary nav (not .navbar-right). Try pfSense container first.
    const pfbar = document.querySelector('#pf-navbar') || nav;
    const left  = pfbar.querySelector('.navbar-nav:not(.navbar-right)') || pfbar.querySelector('.navbar-nav') || null;
    const right = pfbar.querySelector('.navbar-right') || null;

    const li  = document.createElement('li');
    li.id = 'qs-nav-li';

    const btn = document.createElement('button');
    btn.id = 'qs-nav-icon';
    btn.title = 'Quick Search';
    btn.setAttribute('aria-label', 'Quick Search');
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M15.5 14h-.79l-.28-.28A6.2 6.2 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.22-1.57l.28.28v.79L20 21.5 21.5 20l-6-6zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>`;
    li.appendChild(btn);

    // Place right AFTER the Help menu (left navbar) when possible.
    let mounted = false;
    if (left) {
      // Try exact last item (pfSense usually has Help as the last <li>)
      const lastLi = left.querySelector('li:last-child');
      // Or heuristically locate a link whose text equals "Help" (or localized variants).
      const helpLi = Array.from(left.querySelectorAll('li')).find(liEl => {
        const a = liEl.querySelector('a, span');
        if (!a) return false;
        const t = (a.textContent || '').trim().toLowerCase();
        return t === 'help' || t === 'помощь' || t === 'ayuda' || t === 'hilfe' || t === 'aide';
      }) || lastLi;

      if (helpLi && helpLi.parentElement === left) {
        helpLi.insertAdjacentElement('afterend', li);
        qsHostEl = left;
        mounted = true;
      }
    }

    // Fallback: mount in the right cluster if we couldn't use left.
    if (!mounted && right) {
      right.appendChild(li);
      qsHostEl = right;
      mounted = true;
    }
    if (!mounted) return; // give up quietly if there is no navbar

    btn.addEventListener('click', toggleOverlay);
    btn.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' ') { e.preventDefault(); toggleOverlay(); }});

    // Align to the TOP of the pfSense logo and set overlay position.
    alignIconTopToLogoTop();
    setOverlayTop();

    window.addEventListener('resize', debounce(()=>{
      alignIconTopToLogoTop();
      setOverlayTop();
    }, 120));
  }

  /**
   * Align the TOP edge of the magnifier button to the TOP edge of the
   * pfSense logo in the navbar. We allow NEGATIVE margin-top because
   * the navbar list usually has its own top padding.
   * IMPORTANT: We compute the offset relative to the real host container
   * (left or right) that we mounted into.
   */
  function alignIconTopToLogoTop(){
    const btn = document.getElementById('qs-nav-icon');
    if (!btn) return;

    const nav   = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top') || document;

    const brand = document.querySelector('#topmenu .navbar-brand') ||
                  document.querySelector('.navbar-brand') || null;
    let logoEl = null;
    if (brand){
      logoEl = brand.querySelector('#logo') ||
               brand.querySelector('svg') ||
               brand.querySelector('img');
    }
    const refEl  = logoEl || brand || (document.querySelector('#pf-navbar') || nav);
    const hostEl = qsHostEl || (document.querySelector('#pf-navbar .navbar-right') || nav);

    if (!refEl || !hostEl) return;

    const refRect  = refEl.getBoundingClientRect();
    const hostRect = hostEl.getBoundingClientRect();

    // DO NOT clamp to >= 0; allow negative to nudge it up.
    const offset = Math.round(refRect.top - hostRect.top) + NUDGE_TOP;
    btn.style.marginTop = offset + 'px';
  }

  function setOverlayTop(){
    const overlay = document.getElementById('qs-overlay');
    const nav = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top');
    if (!overlay || !nav) return;
    const h = Math.round(nav.getBoundingClientRect().height || 52);
    overlay.style.top = h + 'px';
  }

  // -------------------- overlay --------------------
  function buildOverlay(){
    if (document.getElementById('qs-overlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'qs-overlay';
    wrap.innerHTML = `
      <div id="qs-panel" role="dialog" aria-modal="true" aria-label="Quick Search">
        <div id="qs-top">
          <input id="qs-input" type="search" placeholder="${PH_BASE_LABEL}..." autocomplete="off">
          <label id="qs-whole">
            <input type="checkbox" id="qs-whole-cb">
            <span>${escapeHtml('Whole words only')}</span>
          </label>
          <!-- Magnifier spins while searching; click to rebuild -->
          <button id="qs-action" title="${escapeHtml('Rebuild index')}" aria-label="${escapeHtml('Rebuild index')}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M15.5 14h-.79l-.28-.28A6.2 6.2 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.22-1.57l.28.28v.79L20 21.5 21.5 20l-6-6zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </button>
        </div>
        <ul id="qs-list" role="listbox" aria-label="Search results"></ul>
        <div id="qs-empty"></div>
      </div>
    `;
    document.body.appendChild(wrap);

    document.addEventListener('click', (e)=>{
      const o = document.getElementById('qs-overlay');
      if (!o || !o.classList.contains('open')) return;
      const panel = document.getElementById('qs-panel');
      if (panel && !panel.contains(e.target) && e.target !== document.getElementById('qs-nav-icon')){
        closeOverlay();
      }
    });

    document.addEventListener('keydown', (e)=>{
      const o = document.getElementById('qs-overlay');
      if (!o || !o.classList.contains('open')) return;
      if (e.key === 'Escape'){ e.preventDefault(); closeOverlay(); }
    });
  }

  function openOverlay(){
    buildOverlay();
    setOverlayTop();
    const o = document.getElementById('qs-overlay');
    o.classList.add('open');
    const i = document.getElementById('qs-input');
    i.focus(); i.select();
  }
  function closeOverlay(){ const o = document.getElementById('qs-overlay'); if (o) o.classList.remove('open'); }
  function toggleOverlay(){ const o=document.getElementById('qs-overlay'); (o && o.classList.contains('open'))? closeOverlay(): openOverlay(); }

  // -------------------- grouping --------------------
  function groupItems(items){
    const rec = items.map(it => {
      const full = (titleFromItem(it) || '')
        .replace(/\s*[:/]\s*/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim();
      const segs = full.split(' / ').filter(Boolean);
      return { full, segs, path: it.path || '' };
    });

    const freq1 = Object.create(null);
    const freq2 = Object.create(null);
    for (const r of rec){
      if (!r.full) continue;
      if (r.segs.length >= 1){ const k1=r.segs[0]; freq1[k1]=(freq1[k1]||0)+1; }
      if (r.segs.length >= 2){ const k2=r.segs.slice(0,2).join(' / '); freq2[k2]=(freq2[k2]||0)+1; }
    }

    const groupsMap = new Map();
    const singles   = [];

    for (const r of rec){
      if (!r.full){ continue; }
      const k2 = r.segs.length >= 2 ? r.segs.slice(0,2).join(' / ') : '';
      const k1 = r.segs.length >= 1 ? r.segs[0] : '';

      let key = '';
      if (k2 && (freq2[k2] || 0) >= 2) key = k2;
      else if (k1 && (freq1[k1] || 0) >= 2) key = k1;

      if (key){
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push({ title:r.full, path:r.path });
      } else {
        singles.push({ title:r.full, path:r.path });
      }
    }

    const groups = Array.from(groupsMap.entries())
      .map(([title, items]) => ({ title, items: items.sort((a,b)=> a.title.localeCompare(b.title)) }))
      .sort((a,b)=> (b.items.length - a.items.length) || a.title.localeCompare(b.title));

    singles.sort((a,b)=> a.title.localeCompare(b.title));
    return { groups, singles };
  }

  // -------------------- rendering + keyboard --------------------
  let focusables = [];
  let keyboardIndex = -1;

  function clearList(){
    const ul = document.getElementById('qs-list');
    if (ul) ul.innerHTML='';
    setEmptyMessage('');
    focusables = [];
    keyboardIndex = -1;
  }
  function setEmptyMessage(txt){
    const el = document.getElementById('qs-empty');
    if (!el) return;
    if (txt){ el.textContent = txt; el.style.display='block'; }
    else { el.textContent=''; el.style.display='none'; }
  }
  function makeRow({title, path, classes=[], role='option'}){
    const li = document.createElement('li');
    li.className = ['qs-row'].concat(classes).join(' ');
    li.setAttribute('role', role);
    li.setAttribute('tabindex', '-1');
    li.innerHTML = `
      <div class="qs-title">${escapeHtml(title)}</div>
      ${path ? `<div class="qs-path">${escapeHtml(path)}</div>` : ''}
    `;
    return li;
  }

  // Rebuild the list of focusable, VISIBLE rows (prevents "skipping every other item").
  function updateFocusables(){
    const list = document.getElementById('qs-list');
    focusables = Array.from(list.querySelectorAll('.qs-row')).filter(el => !el.classList.contains('hidden'));
    if (keyboardIndex >= focusables.length) keyboardIndex = focusables.length - 1;
    if (keyboardIndex < 0 && focusables.length) keyboardIndex = 0;
    focusables.forEach(el => el.classList.remove('focused'));
    if (focusables[keyboardIndex]) {
      focusables[keyboardIndex].classList.add('focused');
      focusables[keyboardIndex].focus({preventScroll:true});
      focusables[keyboardIndex].scrollIntoView({ block:'nearest' });
    }
  }

  function render(items){
    const list = document.getElementById('qs-list');
    if (!list) return;

    clearList();

    if (!items || !items.length){
      setEmptyMessage(L('no_results','No results...'));
      return;
    }

    const {groups, singles} = groupItems(items);

    // groups first
    for (const g of groups){
      const li = makeRow({ title: g.title, classes:['qs-group'], role:'button' });
      li.setAttribute('aria-expanded', 'false');
      li.querySelector('.qs-title').innerHTML = `<span class="qs-caret" aria-hidden="true"></span>${escapeHtml(g.title)}`;
      const badge = document.createElement('div'); badge.className='qs-badge'; badge.textContent = String(g.items.length);
      li.appendChild(badge);
      list.appendChild(li);

      const frag = document.createDocumentFragment();
      for (const ch of g.items){
        const row = makeRow({ title: ch.title, path: ch.path, classes:['qs-child','hidden'] });
        row.addEventListener('click', ()=> { if (ch.path) window.location.assign(ch.path); });
        frag.appendChild(row);
      }
      list.appendChild(frag);

      li.addEventListener('click', ()=>{
        const open = li.getAttribute('aria-expanded') === 'true';
        li.setAttribute('aria-expanded', open ? 'false' : 'true');
        let n = li.nextElementSibling;
        while (n && !n.classList.contains('qs-group') && !n.classList.contains('qs-single')){
          if (open) n.classList.add('hidden'); else n.classList.remove('hidden');
          n = n.nextElementSibling;
        }
        updateFocusables();
      });
    }

    // singles after groups
    for (const s of singles){
      const li = makeRow({ title:s.title, path:s.path, classes:['qs-single'] });
      li.addEventListener('click', ()=> { if (s.path) window.location.assign(s.path); });
      list.appendChild(li);
    }

    keyboardIndex = 0;
    updateFocusables();
  }

  // Move focus by delta among currently visible items
  function focusStep(delta){
    if (!focusables.length) return;
    const visible = focusables;
    let i = keyboardIndex + delta;
    if (i < 0) i = 0;
    if (i >= visible.length) i = visible.length - 1;
    if (i === keyboardIndex) return;
    visible[keyboardIndex]?.classList.remove('focused');
    keyboardIndex = i;
    const el = visible[keyboardIndex];
    el.classList.add('focused');
    el.focus({preventScroll:true});
    el.scrollIntoView({ block:'nearest' });
  }

  function handleKey(e){
    const o = document.getElementById('qs-overlay');
    if (!o || !o.classList.contains('open')) return;

    const current = focusables[keyboardIndex];

    switch (e.key){
      case 'ArrowDown': e.preventDefault(); focusStep(+1); break;
      case 'ArrowUp':   e.preventDefault(); focusStep(-1); break;
      case 'Home':      e.preventDefault(); keyboardIndex = 0; updateFocusables(); break;
      case 'End':       e.preventDefault(); keyboardIndex = focusables.length - 1; updateFocusables(); break;
      case 'ArrowRight':
        if (current && current.classList.contains('qs-group') && current.getAttribute('aria-expanded')==='false'){
          current.click(); e.preventDefault();
        }
        break;
      case 'ArrowLeft':
        if (current && current.classList.contains('qs-group') && current.getAttribute('aria-expanded')==='true'){
          current.click(); e.preventDefault();
        }
        break;
      case 'Enter':
        if (!current) break;
        if (current.classList.contains('qs-group')){ current.click(); }
        else {
          const path = (current.querySelector('.qs-path')||{}).textContent || '';
          if (path) window.location.assign(path.trim());
        }
        e.preventDefault();
        break;
      default: break;
    }
  }

  // -------------------- Querying --------------------
  let inflight = null;
  let seq = 0;
  let idleTimer = null;

  // Toggle in-panel magnifier spinning state
  function setActionSpin(on){
    const btn = document.getElementById('qs-action');
    if (!btn) return;
    btn.classList.toggle('spin', !!on);
  }

  // Debounced search: start spinner immediately on input, stop after fetch
  const schedule = ()=>{
    setActionSpin(true);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(runNow, IDLE_MS);
  };

  // Rebuild index (keeps spinner on and triggers a fresh search)
  async function rebuildIndex(){
    const btn = document.getElementById('qs-action');
    if (!btn) return;
    try{
      btn.disabled = true;
      setActionSpin(true);
      await fetch('/diag_quicksearch.php?rebuild=1&t='+Date.now(), {credentials:'same-origin'});
      runNow();
    }catch(_e){} finally{ btn.disabled = false; }
  }

  function runNow(){
    const q = (document.getElementById('qs-input')?.value || '').trim();
    const wholeChecked = !!document.getElementById('qs-whole-cb')?.checked;

    if (q.length < MIN_CHARS){
      clearList();
      setActionSpin(false);
      if (q.length) setEmptyMessage(L('no_results','No results...'));
      return;
    }

    if (inflight) { inflight.abort(); inflight = null; }
    const controller = new AbortController(); inflight = controller;
    const mySeq = ++seq;

    // Backend expects "ww=1|0"
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('ww', wholeChecked ? '1' : '0');
    params.set('t', String(Date.now()));

    fetch('/diag_quicksearch.php?' + params.toString(),
      { credentials:'same-origin', signal:controller.signal, cache:'no-store' })
      .then(r => r.json())
      .then(d => { if (mySeq===seq) render(d.items || []); })
      .catch(err => {
        if (err && err.name === 'AbortError') return;
        setEmptyMessage(L('request_error','Request error'));
        console.error('[InlineQuickSearch] fetch error:', err);
      })
      .finally(()=> { if (mySeq===seq) { inflight = null; setActionSpin(false); } });
  }

  // -------------------- Boot --------------------
  function mount(){
    if (document.getElementById('qs-mounted-flag')) return;
    const flag = document.createElement('meta'); flag.id='qs-mounted-flag'; document.head.appendChild(flag);

    ensureNavIcon();
    buildOverlay();
    setOverlayTop();

    loadI18n().then(()=>{
      const input = document.getElementById('qs-input');
      if (input) input.placeholder = (L('find', PH_BASE_LABEL) + '...');
    });

    // NOTE: we intentionally do NOT bind keydown on #qs-input or #qs-list,
    // because the same event would bubble and also trigger the document handler,
    // causing "skip every other item". We keep a SINGLE global keydown handler.
    document.getElementById('qs-input')?.addEventListener('input', schedule);
    document.getElementById('qs-whole-cb')?.addEventListener('change', runNow);
    document.getElementById('qs-action')?.addEventListener('click', rebuildIndex);

    document.addEventListener('keydown', handleKey);
    console.log('[InlineQuickSearch]', BUILD, 'mounted');
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', mount, {once:true});
  } else {
    mount();
  }
})();
