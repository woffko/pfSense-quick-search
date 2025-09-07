/* quicksearch_inline.js
 * Inline Quick Search placed at the far-right of pfSense top navbar.
 * Searches only on button press (or Enter). Backend: /diag_quicksearch.php?q=...
 */

(function () {
  const BUILD          = 'InlineQuickSearch v2025-09-06-09';
  const BTN_BASE_LABEL = 'Find';
  const PH_BASE_LABEL  = 'Find';

  // ---------- CSS ----------
  (function injectCss(){
    const id = 'qs-inline-style';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      /* align right navbar content and keep icons centered */
      #topmenu #pf-navbar .navbar-right{
        display:flex; align-items:center;
      }
      #topmenu #pf-navbar .navbar-right > li{
        display:flex; align-items:center;
      }
      #topmenu #pf-navbar .navbar-right > li > a{
        display:flex; align-items:center;
      }

      /* host li for the search form */
      #topmenu #pf-navbar .navbar-right > li.qs-li{ margin:0; padding:0; }

      /* the form */
      #qs-inline-form.navbar-form.qs-inline{
        display:inline-flex; margin:0 !important; padding:0 !important; white-space:nowrap; position:relative;
      }
      /* stretch children to the same height; we will also hard-sync heights via JS */
      #qs-inline-form .form-group{
        display:flex; align-items:stretch; gap:8px; margin:0;
      }

      /* compact visual */
      #qs-inline-form .form-control.input-sm{ padding:6px 8px; }
      #qs-inline-form .btn-sm{
        display:inline-flex; align-items:center; justify-content:center;
        padding:6px 12px; line-height:normal; min-width:64px;
      }

      /* input width */
      #qs-inline-input{ width:180px; min-width:140px; }
      @media (max-width:1200px){ #qs-inline-input{ width:160px; } }
      @media (max-width: 992px){ #qs-inline-input{ width:140px; } }

      /* dropdown */
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
  function titleFromItem(it){
    let t = it.page || it.title || it.label || it.name || it.text || it.display || '';
    if (!t || isPathLike(t)) t = humanizePath(it.path || '');
    return t || (it.path||'');
  }
  function lockButtonWidth(btn, labels){
    if (!btn) return;
    const orig = btn.textContent; let maxw = 0;
    for (const lbl of labels){ btn.textContent = lbl; maxw = Math.max(maxw, Math.ceil(btn.getBoundingClientRect().width)); }
    btn.textContent = orig; btn.style.width = maxw + 'px';
  }
  // make button height exactly the same as input height (theme-agnostic)
  function syncHeights(btn, input){
    if (!btn || !input) return;
    // ensure layout is up-to-date
    requestAnimationFrame(() => {
      const h = Math.ceil(input.getBoundingClientRect().height);
      if (h > 0) btn.style.height = h + 'px';
    });
  }
  // debounce for resize
  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  // ---------- mount ----------
  let phTimer = null;

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
        <button id="qs-inline-btn" type="submit" class="btn btn-primary btn-sm">${BTN_BASE_LABEL}</button>
      </div>
      <div id="qs-inline-dd" role="listbox" aria-label="Search results"></div>
    `;
    li.appendChild(form);
    rightList.appendChild(li); // last -> far right

    const input = form.querySelector('#qs-inline-input');
    const btn   = form.querySelector('#qs-inline-btn');
    const panel = form.querySelector('#qs-inline-dd');

    lockButtonWidth(btn, [BTN_BASE_LABEL, BTN_BASE_LABEL+'.', BTN_BASE_LABEL+'..', BTN_BASE_LABEL+'...']);
    syncHeights(btn, input);

    // keep heights in sync on resize/theme/layout changes
    window.addEventListener('resize', debounce(()=>syncHeights(btn, input), 100));

    // run search on submit
    form.addEventListener('submit', (e) => { e.preventDefault(); runQuery(input.value.trim(), panel, btn, input); });

    // close dropdown
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) hide(panel); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(panel); });

    console.log('[InlineQuickSearch]', BUILD, 'mounted');
  }

  const show = p => (p.style.display='block');
  const hide = p => { p.style.display='none'; p.innerHTML=''; };

  function setBusy(btn, input, busy){
    if (phTimer){ clearInterval(phTimer); phTimer = null; }
    if (busy){
      btn.disabled = true; btn.style.opacity='0.85'; btn.style.cursor='default';
      let n = 0;
      phTimer = setInterval(() => {
        n = (n+1) % 4;
        if (!input.value) input.placeholder = PH_BASE_LABEL + (n ? '.'.repeat(n) : '');
      }, 350);
    } else {
      btn.disabled = false; btn.style.opacity='1'; btn.style.cursor='pointer';
      if (!input.value) input.placeholder = PH_BASE_LABEL + '...';
    }
  }

  // ---------- fetch + render ----------
  function runQuery(q, panel, btn, input){
    if (!q){ hide(panel); return; }
    setBusy(btn, input, true);

    fetch('/diag_quicksearch.php?q=' + encodeURIComponent(q) + '&t=' + Date.now(), { credentials:'same-origin' })
      .then(r => r.json())
      .then(d => {
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
        panel.innerHTML = `<div style="padding:10px 12px; color:#c00; font-size:12px;">Request error</div>`;
        show(panel);
        console.error('[InlineQuickSearch] fetch error:', err);
      })
      .finally(() => setBusy(btn, input, false));
  }

  // ---------- boot ----------
  (document.readyState === 'loading')
    ? document.addEventListener('DOMContentLoaded', mount, { once:true })
    : mount();
})();
