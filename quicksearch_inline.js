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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.*
 */

(function () {
  // -------------------- Tunables --------------------
  const BUILD         = 'InlineQuickSearch v2025-09-15-mobile-overlay-top';
  const PH_BASE_LABEL = 'Find';
  const MIN_CHARS     = 3;
  const IDLE_MS       = 100;

  // Desktop micro tuning for vertical alignment (mobile ignores this).
  const NUDGE_TOP     = 0;

  // Persist last entered query across openings (until localStorage is cleared).
  const LS_KEY_LAST_QUERY = 'pf_qs_last_query';

  // Host UL where the desktop navbar button is mounted.
  let qsHostEl = null;

  // Debounce helper
  const debounce = (fn, ms)=>{ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

  // -------------------- CSS --------------------
  (function injectCss(){
    if (document.getElementById('qs-style-overlay')) return;
    const s = document.createElement('style');
    s.id = 'qs-style-overlay';
    s.textContent = `
      /* Desktop nav icon (in the left UL) */
      #qs-nav-li{ display:block; float:left; }

      #qs-nav-icon{
        --qs-size:28px;
        --qs-y: 0px; /* computed on desktop only */
        position:relative; z-index:2;
        display:inline-flex; align-items:center; justify-content:center;
        width:var(--qs-size); height:var(--qs-size);
        margin-left:8px; border-radius:8px;
        cursor:pointer; user-select:none; outline:none;
        background:#0b6efd; color:#fff; border:0; line-height:1; padding:0;
        transform: translateY(var(--qs-y));
        will-change: transform;
      }
      #qs-nav-icon:focus-visible{ box-shadow:0 0 0 3px rgba(11,110,253,.35); }
      #qs-nav-icon svg{ width:60%; height:60%; pointer-events:none; }

      /* MOBILE/COLLAPSED header icon: centered horizontally inside .navbar-header */
      #qs-nav-mobile{
        display:none; /* hidden by default (desktop) */
        position:absolute; z-index:3;
        width:34px; height:34px; border-radius:8px;
        background:#0b6efd; color:#fff; border:0;
        left:50%; top:50%;
        transform: translate(-50%, -50%);
        align-items:center; justify-content:center;
        line-height:1; padding:0; cursor:pointer;
      }
      #qs-nav-mobile svg{ width:60%; height:60%; pointer-events:none; }
      #qs-nav-mobile:focus-visible{ box-shadow:0 0 0 3px rgba(11,110,253,.35); }

      /* Treat "mobile" by width for layout. Collapsed/expanded behavior is finalized in JS. */
      @media (max-width: 767px){
        /* Keep desktop icon out of the way on small screens */
        #qs-nav-li{ display:none; }
        #qs-nav-icon{ transform:none !important; }

        /* Allow absolute centering of the mobile button */
        #pf-navbar .navbar-header, .navbar-header{ position:relative; }
        #qs-nav-mobile{ display:inline-flex; }
      }

      /* Overlay — IMPORTANT: top:0 by default! On desktop JS repositions under navbar. */
      #qs-overlay{
        position:fixed; left:0; right:0; top:0;
        display:none; z-index:100001;
      }
      #qs-overlay.open{ display:block; }

      #qs-panel{
        margin:0 auto; max-width:960px; width:min(90vw,960px);
        background:#fff; color:#222; border-radius:12px;
        border:1px solid #e5e7eb; box-shadow:0 18px 40px rgba(0,0,0,.45); overflow:hidden;
      }
      @media (prefers-color-scheme: dark){
        #qs-panel{ background:#1f1f1f; color:#e7e7e7; border-color:rgba(0,0,0,.2); }
      }

      /* MOBILE overlay = full width, flat corners */
      @media (max-width: 767px){
        #qs-panel{
          width:100vw; max-width:none; border-radius:0;
        }
      }

      /* Desktop top bar: a simple row */
      #qs-top{ display:flex; align-items:center; gap:10px; padding:12px; border-bottom:1px solid rgba(0,0,0,.08); }
      #qs-input{
        flex:1 1 auto; height:36px; padding:6px 10px; border-radius:8px;
        border:1px solid rgba(0,0,0,.15); background:transparent; color:inherit;
      }
      #qs-input::placeholder{ opacity:.7; }
      #qs-whole{ display:flex; align-items:center; gap:6px; white-space:nowrap; font-size:12px; opacity:.9; }

      /* On MOBILE, place the checkbox UNDER the input using CSS grid */
      @media (max-width: 767px){
        #qs-top{
          display:grid;
          grid-template-columns: 1fr auto;
          grid-template-areas:
            "input action"
            "whole whole";
          gap: 8px 10px;
          align-items:center;
        }
        #qs-input{ grid-area: input; width:100%; }
        #qs-action{ grid-area: action; }
        #qs-whole{ grid-area: whole; }
      }

      /* In-panel action button (magnifier spins while searching) */
      #qs-action{
        display:inline-flex; align-items:center; justify-content:center;
        width:36px; height:36px; border-radius:8px; border:1px solid rgba(0,0,0,.15);
        background:transparent; cursor:pointer; color:inherit;
      }
      #qs-action:disabled{ opacity:.5; cursor:default; }
      #qs-action svg{ width:18px; height:18px; pointer-events:none; }
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

  // Detect Bootstrap collapsed (mobile/tablet "burger" state)
  function isMobileCollapsed(){
    const nav = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top');
    const toggle = nav?.querySelector('.navbar-toggle');
    return !!(toggle && getComputedStyle(toggle).display !== 'none');
  }

  // -------------------- navbar icons (desktop + mobile) --------------------
  function ensureNavIcon(){
    // Avoid duplicates
    if (!document.getElementById('qs-nav-icon')){
      // Desktop icon (inside the menu UL)
      const nav   = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top') || document;
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

      // Place after the last LI that has a visible text label (usually Help).
      let mounted = false;
      if (left) {
        const lis = Array.from(left.children).filter(el => el.tagName === 'LI');
        const lastTextLi = [...lis].reverse().find(liEl => {
          const a = liEl.querySelector('a,span');
          const txt = (a?.textContent || '').replace(/\s+/g,' ').trim();
          return !!txt;
        });
        if (lastTextLi) {
          lastTextLi.insertAdjacentElement('afterend', li);
          qsHostEl = left;
          mounted = true;
        }
      }
      if (!mounted && right){ right.appendChild(li); qsHostEl = right; mounted = true; }
    }

    // Create mobile header icon (centered) once
    if (!document.getElementById('qs-nav-mobile')){
      const header = document.querySelector('#pf-navbar .navbar-header') ||
                     document.querySelector('.navbar-header');
      if (header){
        const mobileBtn = document.createElement('button');
        mobileBtn.id = 'qs-nav-mobile';
        mobileBtn.type = 'button';
        mobileBtn.title = 'Quick Search';
        mobileBtn.setAttribute('aria-label','Quick Search');
        mobileBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M15.5 14h-.79l-.28-.28A6.2 6.2 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.22-1.57l.28.28v.79L20 21.5 21.5 20l-6-6zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>`;
        header.appendChild(mobileBtn); // Centered via CSS (absolute inside header)
      }
    }

    // Bind both icons
    document.getElementById('qs-nav-icon')?.addEventListener('click', toggleOverlay);
    document.getElementById('qs-nav-mobile')?.addEventListener('click', toggleOverlay);

    // Initial layout passes
    queueAlign();
    queueFitNavbarWidth();
    setOverlayTop();

    // Recalculate on UI changes
    window.addEventListener('resize', debounce(()=>{ queueAlign(); queueFitNavbarWidth(); setOverlayTop(); }, 120));

    const header = document.querySelector('#pf-navbar .navbar-header') ||
                   document.querySelector('.navbar-header');
    const collapse = document.querySelector('#pf-navbar') ||
                     document.querySelector('.navbar-collapse');
    const moTargets = [header, collapse, collapse?.querySelector('.navbar-right')].filter(Boolean);
    for (const target of moTargets){
      const mo = new MutationObserver(debounce(()=>{ queueAlign(); queueFitNavbarWidth(); setOverlayTop(); }, 50));
      mo.observe(target, { attributes:true, childList:true, subtree:true, characterData:true });
    }

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(()=>{ queueAlign(); queueFitNavbarWidth(); setOverlayTop(); });
    }
    window.addEventListener('load', ()=>{ queueAlign(); queueFitNavbarWidth(); setOverlayTop(); }, { once:true });
  }

  // ---------- Desktop vertical centering (disabled on mobile) ----------
  function queueAlign(){ requestAnimationFrame(()=> requestAnimationFrame(alignIconToHeaderCenter)); }

  function alignIconToHeaderCenter(){
    const btn = document.getElementById('qs-nav-icon'); if (!btn) return;

    // On collapsed/mobile, keep the desktop icon unshifted.
    if (isMobileCollapsed()){
      btn.style.setProperty('--qs-y', '0px');
      return;
    }

    const header = document.querySelector('#pf-navbar .navbar-header') ||
                   document.querySelector('.navbar-header');
    if (!header) return;

    btn.style.setProperty('--qs-y', '0px');

    const hRect   = header.getBoundingClientRect();
    const bRect   = btn.getBoundingClientRect();

    const headerCenterY = hRect.top + hRect.height / 2;
    const btnCenterY    = bRect.top + bRect.height / 2;

    const dy = (headerCenterY - btnCenterY) + NUDGE_TOP;
    btn.style.setProperty('--qs-y', dy + 'px');
  }

  // ---------- Auto width fit (desktop only) ----------
  function queueFitNavbarWidth(){ requestAnimationFrame(()=> requestAnimationFrame(fitNavbarWidth)); }

  function fitNavbarWidth(){
    const nav = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top');
    const container = nav?.querySelector('.container');
    if (!nav || !container) return;

    // Mobile: restore native Bootstrap width
    if (isMobileCollapsed()){
      container.style.width = '';
      container.style.marginLeft = '';
      container.style.marginRight = '';
      return;
    }

    const header   = nav.querySelector('.navbar-header');
    const collapse = nav.querySelector('#pf-navbar') || nav.querySelector('.navbar-collapse');
    const left     = collapse?.querySelector('.navbar-nav:not(.navbar-right)');
    const right    = collapse?.querySelector('.navbar-right');

    const wHeader = header  ? header.getBoundingClientRect().width  : 0;
    const wLeft   = left    ? left.getBoundingClientRect().width    : 0;
    const wRight  = right   ? right.getBoundingClientRect().width   : 0;

    const GAP = 24;
    const EXTRA = 16;

    const needed = Math.ceil(wHeader + wLeft + wRight + GAP + EXTRA);
    const viewport = Math.floor(document.documentElement.clientWidth || window.innerWidth);

    const target = Math.min(needed, viewport);
    const curW   = Math.ceil(container.getBoundingClientRect().width);

    if (Math.abs(curW - target) > 1) {
      container.style.width = target + 'px';
      container.style.marginLeft = 'auto';
      container.style.marginRight = 'auto';
    }
  }

  // Position the overlay: on mobile/collapsed -> 0; on desktop -> under navbar.
  function setOverlayTop(){
    const overlay = document.getElementById('qs-overlay');
    if (!overlay) return;

    if (isMobileCollapsed()){
      // MOBILE/TABLET (burger visible): always from the very top of the viewport
      overlay.style.top = '0px';
      return;
    }

    // DESKTOP: keep it right under the navbar height
    const nav = document.getElementById('topmenu') || document.querySelector('.navbar-fixed-top');
    if (!nav) return;
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
      if (panel && !panel.contains(e.target) &&
          e.target !== document.getElementById('qs-nav-icon') &&
          e.target !== document.getElementById('qs-nav-mobile')){
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

    const last = localStorage.getItem(LS_KEY_LAST_QUERY);
    const input = document.getElementById('qs-input');
    if (last && input) { input.value = last; }

    document.getElementById('qs-overlay').classList.add('open');
    input.focus(); input.select();

    if (last && last.trim().length >= MIN_CHARS) runNow();
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

    // Merge groups that share the same prefix before the first '/'
    const merged = new Map();
    for (const [title, itemsArr] of groupsMap.entries()){
      const prefix = title.split(' / ')[0];
      if (!merged.has(prefix)) merged.set(prefix, []);
      merged.get(prefix).push({ title, items: itemsArr });
    }

    const finalGroups = [];
    for (const [prefix, arr] of merged.entries()){
      if (arr.length === 1){
        finalGroups.push({ title: arr[0].title, items: arr[0].items });
      } else {
        const flat = [];
        for (const g of arr) flat.push(...g.items);
        flat.sort((a,b)=> a.title.localeCompare(b.title));
        finalGroups.push({ title: prefix, items: flat });
      }
    }

    finalGroups.sort((a,b)=> (b.items.length - a.items.length) || a.title.localeCompare(b.title));
    singles.sort((a,b)=> a.title.localeCompare(b.title));

    return { groups: finalGroups, singles };
  }

  // -------------------- rendering + keyboard --------------------
  let focusables = [];
  let keyboardIndex = -1;

  function clearList(){
    const ul = document.getElementById('qs-list');
    if (ul) ul.innerHTML='';
    setEmptyMessage('');
    focusables = [];
    keyboardIndex = -1; // keep focus in input initially
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

  function updateFocusables(autofocus = false){
    const list = document.getElementById('qs-list');
    focusables = Array.from(list.querySelectorAll('.qs-row')).filter(el => !el.classList.contains('hidden'));
    if (keyboardIndex >= focusables.length) keyboardIndex = focusables.length - 1;
    if (keyboardIndex < 0 && autofocus && focusables.length) keyboardIndex = 0;

    focusables.forEach(el => el.classList.remove('focused'));
    if (keyboardIndex >= 0 && focusables[keyboardIndex]) {
      const el = focusables[keyboardIndex];
      el.classList.add('focused');
      el.focus({preventScroll:true});
      el.scrollIntoView({ block:'nearest' });
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
          n.classList.toggle('hidden', open);
          n = n.nextElementSibling;
        }
        updateFocusables(false);
      });
    }

    for (const s of singles){
      const li = makeRow({ title:s.title, path:s.path, classes:['qs-single'] });
      li.addEventListener('click', ()=> { if (s.path) window.location.assign(s.path); });
      list.appendChild(li);
    }

    keyboardIndex = -1; // keep focus in the input by default
    updateFocusables(false);
  }

  function focusStep(delta){
    if (!focusables.length) return;
    let i = keyboardIndex + delta;
    if (i < 0) i = 0;
    if (i >= focusables.length) i = focusables.length - 1;
    if (i === keyboardIndex) return;
    if (keyboardIndex >= 0) focusables[keyboardIndex]?.classList.remove('focused');
    keyboardIndex = i;
    const el = focusables[keyboardIndex];
    el.classList.add('focused');
    el.focus({preventScroll:true});
    el.scrollIntoView({ block:'nearest' });
  }

  function handleKey(e){
    const o = document.getElementById('qs-overlay');
    if (!o || !o.classList.contains('open')) return;

    const inputEl = document.getElementById('qs-input');
    const current = (keyboardIndex >= 0) ? focusables[keyboardIndex] : null;

    switch (e.key){
      case 'ArrowDown':
        if (document.activeElement === inputEl) {
          if (focusables.length) { keyboardIndex = 0; updateFocusables(true); }
          e.preventDefault();
        } else { e.preventDefault(); focusStep(+1); }
        break;

      case 'ArrowUp':
        if (document.activeElement === inputEl) {
          // stay in input
        } else {
          if (keyboardIndex <= 0) {
            e.preventDefault();
            focusables[0]?.classList.remove('focused');
            keyboardIndex = -1;
            inputEl.focus({preventScroll:true});
            inputEl.select();
          } else {
            e.preventDefault();
            focusStep(-1);
          }
        }
        break;

      case 'Home':
        e.preventDefault();
        if (focusables.length){ keyboardIndex = 0; updateFocusables(true); }
        break;

      case 'End':
        e.preventDefault();
        if (focusables.length){ keyboardIndex = focusables.length - 1; updateFocusables(true); }
        break;

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

      case 'Escape':
        e.preventDefault();
        if (document.activeElement !== inputEl) {
          focusables[keyboardIndex]?.classList.remove('focused');
          keyboardIndex = -1;
          inputEl.focus({preventScroll:true});
          inputEl.select();
        } else {
          closeOverlay();
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

      default:
        // Typing while a list item is focused moves caret to the input
        if (keyboardIndex >= 0 &&
            e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const pos = inputEl.selectionStart;
          inputEl.focus();
          inputEl.setSelectionRange(pos, pos);
        }
        break;
    }
  }

  // -------------------- Querying --------------------
  let inflight = null;
  let seq = 0;
  let idleTimer = null;

  function setActionSpin(on){
    const btn = document.getElementById('qs-action');
    if (!btn) return;
    btn.classList.toggle('spin', !!on);
  }

  const schedule = ()=>{
    setActionSpin(true);
    const v = (document.getElementById('qs-input')?.value || '');
    try{ localStorage.setItem(LS_KEY_LAST_QUERY, v); }catch(_e){}
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(runNow, IDLE_MS);
  };

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

    try{ localStorage.setItem(LS_KEY_LAST_QUERY, q); }catch(_e){}

    if (q.length < MIN_CHARS){
      clearList();
      setActionSpin(false);
      if (q.length) setEmptyMessage(L('no_results','No results...'));
      return;
    }

    if (inflight) { inflight.abort(); inflight = null; }
    const controller = new AbortController(); inflight = controller;
    const mySeq = ++seq;

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

    document.addEventListener('keydown', handleKey);
    document.getElementById('qs-input')?.addEventListener('input', schedule);
    document.getElementById('qs-whole-cb')?.addEventListener('change', runNow);
    document.getElementById('qs-action')?.addEventListener('click', rebuildIndex);

    console.log('[InlineQuickSearch]', BUILD, 'mounted');
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', mount, {once:true});
  } else {
    mount();
  }
})();
