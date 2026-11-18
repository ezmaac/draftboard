/* Leafs Ticket Draft — single-page front end (no build step). */
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('topnav');
  const $modal = document.getElementById('modal');
  const $toast = document.getElementById('toast');

  const state = { me: null, teams: [], teamMap: {}, users: [] };
  let cleanup = null; // teardown for the current view (timers, SSE)

  // ------------------------------------------------------------ utils
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const fmtGameDate = g => { const d = parseDate(g.date); return `${DOW[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const fmtDur = secs => {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const fmtWhen = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${esc(u.color)}">${esc(initials(u.display_name))}</span>`;
  const team = abbr => state.teamMap[abbr] || { abbr, city: '', name: abbr, div: 'Metropolitan' };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/login')) { state.me = null; location.hash = '#/login'; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, err = false) {
    $toast.textContent = msg; $toast.className = 'toast' + (err ? ' err' : ''); $toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ($toast.hidden = true), 3200);
  }

  function modal(html, onMount) {
    $modal.innerHTML = `<div class="box">${html}</div>`;
    $modal.hidden = false;
    const close = () => { $modal.hidden = true; $modal.innerHTML = ''; };
    $modal.onclick = e => { if (e.target === $modal || e.target.closest('[data-close]')) close(); };
    onMount?.($modal, close);
    return close;
  }

  // ------------------------------------------------------------ router
  const routes = [
    [/^#\/login$/, viewLogin, { public: true }],
    [/^#\/?$/, viewHome],
    [/^#\/new$/, viewNewDraft],
    [/^#\/board\/(\d+)$/, viewBoard],
    [/^#\/history$/, viewHistoryIndex],
    [/^#\/history\/(\d+)$/, viewHistory],
    [/^#\/profile$/, viewProfile],
  ];

  async function route() {
    cleanup?.(); cleanup = null;
    const hash = location.hash || '#/';
    const match = routes.find(([re]) => re.test(hash));
    if (!match) { location.hash = '#/'; return; }
    const [re, view, opts = {}] = match;
    if (!opts.public && !state.me) { location.hash = '#/login'; return; }
    if (opts.public && state.me) { location.hash = '#/'; return; }
    $nav.hidden = !state.me;
    document.querySelectorAll('[data-nav]').forEach(a => {
      const n = a.dataset.nav;
      a.classList.toggle('active', (n === 'home' && /^#\/?$|^#\/new|^#\/board/.test(hash)) || hash.startsWith(`#/${n}`));
    });
    try { await view(...hash.match(re).slice(1)); }
    catch (e) { $app.innerHTML = `<div class="page"><div class="panel"><h2>Something went wrong</h2><p class="error">${esc(e.message)}</p><a class="btn" href="#/">Back</a></div></div>`; }
  }

  // ------------------------------------------------------------ login / register
  function viewLogin() {
    let mode = 'login';
    const render = () => {
      $app.innerHTML = `
      <div class="auth-wrap"><form class="auth-card" id="authForm" autocomplete="on">
        <div style="font-size:2.4rem">🍁</div>
        <h1>Leafs Ticket<br>Draft</h1>
        <p class="muted small">Season ticket game draft for the partners.</p>
        <div class="tabs">
          <button type="button" class="btn ${mode === 'login' ? 'on' : ''}" data-mode="login">Log in</button>
          <button type="button" class="btn ${mode === 'register' ? 'on' : ''}" data-mode="register">Sign up</button>
        </div>
        <div class="field"><label>Username</label><input type="text" name="username" required autocomplete="username"></div>
        ${mode === 'register' ? `<div class="field"><label>Display name</label><input type="text" name="display_name" placeholder="e.g. Mark"></div>` : ''}
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></div>
        ${mode === 'register' ? `<div class="field"><label>Invite code</label><input type="text" name="invite_code" required></div>` : ''}
        <p class="error" id="authErr"></p>
        <button class="btn primary" style="width:100%">${mode === 'login' ? 'Log in' : 'Create account'}</button>
      </form></div>`;
      $app.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => { mode = b.dataset.mode; render(); }));
      $app.querySelector('#authForm').onsubmit = async e => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        try {
          const { user } = await api('POST', mode === 'login' ? '/api/login' : '/api/register', body);
          state.me = user; location.hash = '#/';
        } catch (err) { $app.querySelector('#authErr').textContent = err.message; }
      };
    };
    render();
  }

  // ------------------------------------------------------------ home (drafts list)
  async function viewHome() {
    const drafts = await api('GET', '/api/drafts');
    const isAdmin = state.me.is_admin;
    const item = d => `
      <div class="draft-item">
        <div>
          <div class="title">${esc(d.name)} <span class="pill ${d.status}">${d.status}</span></div>
          <div class="muted small">${esc(d.season)} · ${d.game_count} games · ${d.order_type} order · ${d.pick_count}/${d.game_count} picked</div>
        </div>
        <div class="row">
          ${d.status === 'live' ? `<a class="btn go" href="#/board/${d.id}">Enter draft room</a>` : ''}
          ${d.status === 'setup' ? `<a class="btn" href="#/board/${d.id}">Preview board</a>${isAdmin ? `<button class="btn primary" data-start="${d.id}">Start draft</button>` : ''}` : ''}
          ${d.status === 'complete' ? `<a class="btn" href="#/board/${d.id}">Board</a><a class="btn primary" href="#/history/${d.id}">Results</a>` : ''}
          ${isAdmin && d.status !== 'complete' ? `<button class="btn danger sm" data-del="${d.id}">Delete</button>` : ''}
        </div>
      </div>`;
    const active = drafts.filter(d => d.status !== 'complete');
    const done = drafts.filter(d => d.status === 'complete');
    $app.innerHTML = `
      <div class="page">
        <div class="row spread" style="margin-bottom:14px">
          <h1 style="margin:0">Hi, ${esc(state.me.display_name)}</h1>
          ${isAdmin ? `<a class="btn primary" href="#/new">+ New draft</a>` : ''}
        </div>
        <div class="panel">
          <h2>Current drafts</h2>
          ${active.length ? active.map(item).join('') : `<p class="muted">No draft in progress. ${isAdmin ? 'Create one to load the season schedule.' : 'The commissioner will set one up.'}</p>`}
        </div>
        <div class="panel">
          <h2>Past drafts</h2>
          ${done.length ? done.map(item).join('') : `<p class="muted">Completed drafts will be kept here.</p>`}
        </div>
      </div>`;
    $app.querySelectorAll('[data-start]').forEach(b => (b.onclick = async () => {
      if (!confirm('Start the draft? The clock begins for the first pick immediately.')) return;
      try { await api('POST', `/api/drafts/${b.dataset.start}/start`); location.hash = `#/board/${b.dataset.start}`; }
      catch (e) { toast(e.message, true); }
    }));
    $app.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => {
      if (!confirm('Delete this draft and all its picks?')) return;
      try { await api('DELETE', `/api/drafts/${b.dataset.del}`); route(); } catch (e) { toast(e.message, true); }
    }));
  }

  // ------------------------------------------------------------ new draft (commissioner)
  async function viewNewDraft() {
    if (!state.me.is_admin) { location.hash = '#/'; return; }
    const users = await api('GET', '/api/users');
    const y = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    let order = users.map(u => u.id);
    let games = [];

    $app.innerHTML = `
      <div class="page">
        <h1>New draft</h1>
        <div class="grid2">
          <div class="panel">
            <h2>Details</h2>
            <div class="field"><label>Draft name</label><input type="text" id="dName" value="${y}–${String(y + 1).slice(2)} Season Draft"></div>
            <div class="field"><label>Season</label><input type="text" id="dSeason" value="${y}-${String(y + 1).slice(2)}"></div>
            <div class="field"><label>Order type</label>
              <select id="dType"><option value="snake">Snake (1-2-3, 3-2-1 …)</option><option value="linear">Linear (1-2-3, 1-2-3 …)</option></select>
            </div>
            <h2 style="margin-top:20px">Partners &amp; order</h2>
            <div class="check-list" id="who"></div>
            <ol class="order-list" id="order"></ol>
            <button class="btn sm" id="shuffle">🎲 Randomize order</button>
          </div>
          <div class="panel">
            <h2>Schedule</h2>
            <div class="field"><label>Source</label>
              <select id="src"><option value="sample">Sample schedule (placeholder)</option><option value="csv">Paste / upload CSV</option></select>
            </div>
            <div id="sampleOpts" class="field"><label>Season starts (year)</label><input type="number" id="sYear" value="${y}"></div>
            <div id="csvOpts" hidden>
              <p class="muted small">Columns: <code>date, time, opponent, notes</code>. Away games (opponent starting with “@”) are skipped.</p>
              <input type="file" id="csvFile" accept=".csv,text/csv" style="margin-bottom:8px">
              <textarea id="csv" placeholder="date,time,opponent,notes&#10;2026-10-07,7:00 PM,Montreal,Home opener&#10;2026-10-10,7:00 PM,BOS,"></textarea>
            </div>
            <button class="btn" id="preview">Load schedule</button>
            <p class="error" id="schedErr"></p>
            <div id="schedPreview" class="small"></div>
          </div>
        </div>
        <div class="row"><button class="btn primary" id="create">Create draft</button><a class="btn" href="#/">Cancel</a><span class="error" id="createErr"></span></div>
      </div>`;

    const $ = s => $app.querySelector(s);
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    const renderWho = () => {
      $('#who').innerHTML = users.map(u => `<label><input type="checkbox" value="${u.id}" ${order.includes(u.id) ? 'checked' : ''}> ${avatar(u)} ${esc(u.display_name)}</label>`).join('');
      $('#who').querySelectorAll('input').forEach(cb => (cb.onchange = () => {
        const id = Number(cb.value);
        order = cb.checked ? [...order, id] : order.filter(x => x !== id);
        renderOrder();
      }));
    };
    const renderOrder = () => {
      $('#order').innerHTML = order.map((id, i) => `
        <li><span class="pos">${i + 1}</span>${avatar(byId[id])}<span class="name">${esc(byId[id].display_name)}</span>
        <button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>▼</button></li>`).join('')
        || '<li class="muted">Tick the partners taking part.</li>';
      $('#order').querySelectorAll('[data-up]').forEach(b => (b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; renderOrder(); }));
      $('#order').querySelectorAll('[data-down]').forEach(b => (b.onclick = () => { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; renderOrder(); }));
    };
    renderWho(); renderOrder();
    $('#shuffle').onclick = () => { for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } renderOrder(); };
    $('#src').onchange = () => { const csv = $('#src').value === 'csv'; $('#csvOpts').hidden = !csv; $('#sampleOpts').hidden = csv; };
    $('#csvFile').onchange = async e => { const f = e.target.files[0]; if (f) $('#csv').value = await f.text(); };

    const loadSchedule = async () => {
      $('#schedErr').textContent = '';
      try {
        const r = await api('POST', '/api/schedule/preview', { source: $('#src').value, csv: $('#csv').value, season_start: $('#sYear').value });
        games = r.games;
        const months = {};
        games.forEach(g => { const d = parseDate(g.date); const k = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; months[k] = (months[k] || 0) + 1; });
        $('#schedPreview').innerHTML = `
          <p><b>${games.length} home games</b> · ${Object.entries(months).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
          ${order.length ? `<p class="muted">${order.length} partners → ${Math.floor(games.length / order.length)} games each${games.length % order.length ? `, ${games.length % order.length} extra going to the first ${games.length % order.length} in the order` : ''}.</p>` : ''}
          ${$('#src').value === 'sample' ? '<p class="error">Sample data only — not the real Leafs schedule.</p>' : ''}`;
        if (r.errors.length) $('#schedErr').innerHTML = r.errors.slice(0, 8).map(esc).join('<br>') + (r.errors.length > 8 ? `<br>…and ${r.errors.length - 8} more` : '');
      } catch (e) { $('#schedErr').textContent = e.message; }
    };
    $('#preview').onclick = loadSchedule;
    loadSchedule();

    $('#create').onclick = async () => {
      try {
        const { id } = await api('POST', '/api/drafts', {
          name: $('#dName').value, season: $('#dSeason').value, order_type: $('#dType').value, user_ids: order, games,
        });
        toast('Draft created'); location.hash = `#/board/${id}`;
      } catch (e) { $('#createErr').textContent = e.message; }
    };
  }

  // ------------------------------------------------------------ the draft board
  async function viewBoard(id) {
    let s = await api('GET', `/api/drafts/${id}`);
    let clockBase = 0, clockT0 = 0;
    let selected = null;
    const f = loadFilters();

    function loadFilters() {
      try { return { team: '', dows: [], hideTaken: false, q: '', ...JSON.parse(localStorage.getItem('boardFilters') || '{}') }; }
      catch { return { team: '', dows: [], hideTaken: false, q: '' }; }
    }
    function saveFilters() { try { localStorage.setItem('boardFilters', JSON.stringify(f)); } catch { /* storage unavailable */ } }

    const userMap = () => Object.fromEntries(s.order.map(o => [o.user_id, { id: o.user_id, display_name: o.display_name, color: o.color }]));

    $app.innerHTML = `
      <div class="board-page">
        <div class="scoreboard">
          <div class="sb-cell">
            <div class="clock-ctrls">
              <button class="icon-btn" id="pauseBtn" title="Pause / resume clock">❚❚</button>
              <button class="icon-btn" id="undoBtn" title="Undo last pick (commissioner)">↶</button>
            </div>
            <div><div class="clock" id="clock">00:00</div><div class="clock-sub" id="clockSub">time on the clock</div></div>
          </div>
          <div class="sb-cell">
            <div class="rp"><div class="n" id="rnd">–</div><div class="l">Round</div></div>
            <div class="rp"><div class="n" id="pk">–</div><div class="l">Pick</div></div>
          </div>
          <div class="sb-cell onclock" id="onclock"></div>
        </div>
        <div class="toolbar">
          <select id="fTeam"><option value="">All opponents</option>${state.teams.map(t => `<option value="${t.abbr}">${esc(t.city)} ${esc(t.name)}</option>`).join('')}</select>
          <div class="dow-chips" id="fDow">${DOW.map((d, i) => `<button data-dow="${i}" title="${d}">${d}</button>`).join('')}</div>
          <label class="toggle"><input type="checkbox" id="fHide"> Available only</label>
          <input type="text" class="search" id="fQ" placeholder="🔍  Search team, date, note…">
          <button class="btn sm" id="fClear">Clear</button>
          <span class="spacer"></span>
          <button class="btn go" id="draftBtn" disabled>Draft game</button>
        </div>
        <div class="banner"><span id="banner"></span>
          <div class="legend" style="justify-content:center;margin-top:2px"><span><i style="background:var(--atl)"></i>Atlantic</span><span><i style="background:var(--met)"></i>Metropolitan</span><span><i style="background:var(--cen)"></i>Central</span><span><i style="background:var(--pac)"></i>Pacific</span></div></div>
        <div class="board" id="board"></div>
        <div class="ticker"><div class="tag">🍁 PICKS</div><div class="track"><div class="scroll" id="ticker"></div></div></div>
      </div>`;
    const $ = sel => $app.querySelector(sel);

    // filters
    $('#fTeam').value = f.team; $('#fHide').checked = f.hideTaken; $('#fQ').value = f.q;
    const syncDow = () => $('#fDow').querySelectorAll('button').forEach(b => b.classList.toggle('on', f.dows.includes(+b.dataset.dow)));
    syncDow();
    $('#fTeam').onchange = () => { f.team = $('#fTeam').value; saveFilters(); renderBoard(); };
    $('#fHide').onchange = () => { f.hideTaken = $('#fHide').checked; saveFilters(); renderBoard(); };
    $('#fQ').oninput = () => { f.q = $('#fQ').value; saveFilters(); renderBoard(); };
    $('#fDow').onclick = e => {
      const b = e.target.closest('[data-dow]'); if (!b) return;
      const d = +b.dataset.dow;
      f.dows = f.dows.includes(d) ? f.dows.filter(x => x !== d) : [...f.dows, d];
      saveFilters(); syncDow(); renderBoard();
    };
    $('#fClear').onclick = () => { Object.assign(f, { team: '', dows: [], hideTaken: false, q: '' }); saveFilters(); $('#fTeam').value = ''; $('#fHide').checked = false; $('#fQ').value = ''; syncDow(); renderBoard(); };

    const myTurn = () => s.draft.status === 'live' && s.on_clock && (s.on_clock.user_id === state.me.id || state.me.is_admin);

    function renderHeader() {
      const d = s.draft;
      clockBase = d.elapsed_ms; clockT0 = performance.now();
      const users = userMap();
      $('#pauseBtn').disabled = d.status !== 'live';
      $('#pauseBtn').textContent = d.paused_at ? '▶' : '❚❚';
      $('#undoBtn').disabled = !state.me.is_admin || !s.picks.length || d.status === 'setup';
      $('#rnd').textContent = s.on_clock ? s.on_clock.round : d.status === 'complete' ? '✓' : '–';
      $('#pk').textContent = s.on_clock ? s.on_clock.pick_in_round : '–';
      const taken = s.picks.length, total = s.games.length;
      $('#banner').innerHTML = `${esc(d.name)} <span class="muted">· ${taken}/${total} games drafted${d.status === 'setup' ? ' · draft not started' : ''}${d.status === 'complete' ? ' · draft complete' : ''}</span>`;

      let html = '';
      if (s.on_clock) {
        const u = users[s.on_clock.user_id];
        const mine = s.on_clock.user_id === state.me.id;
        html = `<div style="min-width:0;flex:1">
          <div class="who">${avatar(u, 'lg')}<div style="min-width:0">
            ${mine ? '<div class="yours">YOU’RE ON THE CLOCK</div>' : '<div class="yours" style="color:var(--muted)">ON THE CLOCK</div>'}
            <div class="name">${esc(u.display_name)}</div></div></div>
          <div class="nextup"><b>Next up:</b>${s.upcoming.slice(0, 4).map(p => `<span>${esc(users[p.user_id].display_name)}</span>`).join('') || '<span>—</span>'}</div>
        </div>`;
      } else if (d.status === 'setup') {
        html = `<div><div class="name" style="font-family:var(--cond);font-size:2rem;font-weight:800">DRAFT NOT STARTED</div>
          <div class="nextup"><b>Order:</b>${s.order.map(o => `<span>${o.position}. ${esc(o.display_name)}</span>`).join('')}</div>
          ${state.me.is_admin ? '<button class="btn go" id="startBtn" style="margin-top:8px">Start draft</button>' : ''}</div>`;
      } else {
        html = `<div><div class="name" style="font-family:var(--cond);font-size:2.4rem;font-weight:800">DRAFT COMPLETE 🏒</div>
          <a class="btn primary" href="#/history/${d.id}" style="margin-top:6px">View results</a></div>`;
      }
      $('#onclock').innerHTML = html;
      $('#startBtn')?.addEventListener('click', async () => {
        try { s = await api('POST', `/api/drafts/${id}/start`); renderAll(); } catch (e) { toast(e.message, true); }
      });
      tickClock();
    }

    function tickClock() {
      const d = s.draft;
      const running = d.status === 'live' && !d.paused_at;
      const ms = clockBase + (running ? performance.now() - clockT0 : 0);
      const el = $('#clock'); if (!el) return;
      el.textContent = d.status === 'live' ? fmtDur(ms / 1000) : '00:00';
      el.classList.toggle('paused', !!d.paused_at);
      const times = s.picks.map(p => p.seconds_taken);
      $('#clockSub').textContent = d.paused_at ? 'clock paused' :
        times.length ? `avg pick ${fmtDur(times.reduce((a, b) => a + b, 0) / times.length)}` : 'time on the clock';
    }

    function gameMatches(g) {
      const d = parseDate(g.date);
      if (f.team && g.opponent !== f.team) return false;
      if (f.dows.length && !f.dows.includes(d.getDay())) return false;
      if (f.q) {
        const t = team(g.opponent);
        const hay = `${t.abbr} ${t.city} ${t.name} ${fmtGameDate(g)} ${MONTHS_LONG[d.getMonth()]} ${g.notes}`.toLowerCase();
        if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    }

    function renderBoard() {
      const pickByGame = Object.fromEntries(s.picks.map(p => [p.game_id, p]));
      const users = userMap();
      const months = new Map();
      s.games.forEach(g => {
        const d = parseDate(g.date); const k = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
        if (!months.has(k)) months.set(k, { label: MONTHS_LONG[d.getMonth()], year: d.getFullYear(), games: [] });
        months.get(k).games.push(g);
      });
      if (selected && pickByGame[selected]) selected = null;
      $('#board').innerHTML = [...months.values()].map(m => {
        const cards = m.games.filter(g => gameMatches(g) && !(f.hideTaken && pickByGame[g.id])).map(g => {
          const t = team(g.opponent); const p = pickByGame[g.id];
          if (p) {
            const u = users[p.user_id];
            return `<div class="card taken ${p.user_id === state.me.id ? 'mine' : ''}" style="--who:${esc(u.color)}" title="Taken by ${esc(u.display_name)} in ${fmtDur(p.seconds_taken)}">
              <div class="top"><span>${fmtGameDate(g)}</span><span>${t.abbr}</span></div>
              <div class="opp">${esc(t.name)}</div>
              <div class="by"><span class="dot"></span>${esc(u.display_name)}<span class="slot">${p.round}.${p.pick_in_round}</span></div>
            </div>`;
          }
          return `<button class="card ${t.div} ${selected === g.id ? 'selected' : ''}" data-game="${g.id}">
            <div class="top"><span>${fmtGameDate(g)}</span><span>${fmtTime(g.time)}</span></div>
            <div class="city">${esc(t.city)}</div>
            <div class="opp">${esc(t.name)}</div>
            ${g.notes ? `<div class="note">★ ${esc(g.notes)}</div>` : ''}
          </button>`;
        }).join('');
        return `<section class="month"><div class="month-head">${m.label} <span>${m.year}</span></div>${cards || '<div class="empty-month">No games match</div>'}</section>`;
      }).join('') || '<p class="muted" style="padding:16px">No games in this draft.</p>';
      $('#draftBtn').disabled = !(selected && myTurn());
      $('#draftBtn').textContent = myTurn() && s.on_clock.user_id !== state.me.id ? `Draft for ${users[s.on_clock.user_id].display_name}` : 'Draft game';
    }

    function renderTicker() {
      const users = userMap();
      const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
      const recent = s.picks.slice(-15).reverse();
      const el = $('#ticker');
      if (!recent.length) { el.className = 'scroll still'; el.innerHTML = '<span>No picks yet — good luck, partners.</span>'; return; }
      el.className = 'scroll';
      el.innerHTML = recent.map(p => { const g = gameMap[p.game_id]; const t = team(g.opponent);
        return `<span><b>${p.round}.${p.pick_in_round}</b>${esc(users[p.user_id].display_name)} / ${fmtGameDate(g)} vs ${esc(t.name)}<span class="t">(${fmtDur(p.seconds_taken)})</span></span>`; }).join('');
    }

    function renderAll() { renderHeader(); renderBoard(); renderTicker(); }
    renderAll();

    // interactions
    $('#board').onclick = e => {
      const c = e.target.closest('[data-game]'); if (!c) return;
      const gid = +c.dataset.game;
      selected = selected === gid ? null : gid;
      renderBoard();
    };
    $('#board').ondblclick = e => { const c = e.target.closest('[data-game]'); if (c) { selected = +c.dataset.game; renderBoard(); confirmPick(); } };
    $('#draftBtn').onclick = confirmPick;

    function confirmPick() {
      if (!selected || !myTurn()) return;
      const g = s.games.find(x => x.id === selected); const t = team(g.opponent);
      const forUser = userMap()[s.on_clock.user_id];
      const behalf = s.on_clock.user_id !== state.me.id;
      modal(`
        <div class="muted small">ROUND ${s.on_clock.round} · PICK ${s.on_clock.pick_in_round} · ${behalf ? `ON BEHALF OF ${esc(forUser.display_name.toUpperCase())}` : 'YOUR PICK'}</div>
        <div class="big">${esc(t.city)} ${esc(t.name)}</div>
        <p>${DOW[parseDate(g.date).getDay()] === 'Sat' ? '🏒 Saturday night · ' : ''}${fmtGameDate(g)} · ${fmtTime(g.time)}${g.notes ? ` · ${esc(g.notes)}` : ''}</p>
        <div class="row"><button class="btn go" id="confirmPick">Lock it in</button><button class="btn" data-close>Cancel</button></div>`,
        ($m, close) => {
          $m.querySelector('#confirmPick').onclick = async () => {
            try { s = await api('POST', `/api/drafts/${id}/pick`, { game_id: g.id }); selected = null; close(); renderAll(); toast(`Drafted: ${t.name} · ${fmtGameDate(g)}`); }
            catch (err) { close(); toast(err.message, true); refresh(); }
          };
        });
    }

    $('#pauseBtn').onclick = async () => { try { s = await api('POST', `/api/drafts/${id}/pause`); renderAll(); } catch (e) { toast(e.message, true); } };
    $('#undoBtn').onclick = async () => {
      if (!confirm('Undo the last pick? That partner goes back on the clock.')) return;
      try { s = await api('POST', `/api/drafts/${id}/undo`); renderAll(); } catch (e) { toast(e.message, true); }
    };

    // live updates
    async function refresh() {
      const prevCount = s.picks.length;
      try { s = await api('GET', `/api/drafts/${id}`); } catch { return; }
      renderAll();
      if (s.picks.length > prevCount && s.on_clock?.user_id === state.me.id) toast('🍁 You’re on the clock!');
    }
    const es = new EventSource(`/api/drafts/${id}/events`);
    es.addEventListener('update', refresh);
    const timer = setInterval(tickClock, 250);
    const onKey = e => { if (e.key === 'Escape' && selected) { selected = null; renderBoard(); } };
    document.addEventListener('keydown', onKey);
    cleanup = () => { es.close(); clearInterval(timer); document.removeEventListener('keydown', onKey); };
  }

  // ------------------------------------------------------------ history
  async function viewHistoryIndex() {
    const drafts = (await api('GET', '/api/drafts')).filter(d => d.status === 'complete' || d.pick_count > 0);
    $app.innerHTML = `
      <div class="page">
        <h1>Draft history</h1>
        <div class="panel">
          ${drafts.length ? drafts.map(d => `
            <div class="draft-item">
              <div><div class="title">${esc(d.name)} <span class="pill ${d.status}">${d.status}</span></div>
              <div class="muted small">${esc(d.season)} · ${d.pick_count}/${d.game_count} picks${d.completed_at ? ` · finished ${fmtWhen(d.completed_at)}` : ''}</div></div>
              <a class="btn primary" href="#/history/${d.id}">View results</a>
            </div>`).join('') : '<p class="muted">No drafts with picks yet.</p>'}
        </div>
      </div>`;
  }

  async function viewHistory(id) {
    const s = await api('GET', `/api/drafts/${id}`);
    const d = s.draft;
    const users = Object.fromEntries(s.order.map(o => [o.user_id, { id: o.user_id, display_name: o.display_name, color: o.color }]));
    const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
    const rounds = Math.max(0, ...s.picks.map(p => p.round));
    const pickAt = (r, uid) => s.picks.find(p => p.round === r && p.user_id === uid);
    const cell = p => {
      if (!p) return '<span class="muted">—</span>';
      const g = gameMap[p.game_id]; const t = team(g.opponent);
      return `<div class="rg-cell card ${t.div}" style="cursor:default"><div class="d">${fmtGameDate(g)}</div><div class="o">${esc(t.name)}</div><div class="s">#${p.overall} · ${fmtDur(p.seconds_taken)}</div></div>`;
    };
    const stats = uid => {
      const ps = s.picks.filter(p => p.user_id === uid);
      const secs = ps.map(p => p.seconds_taken);
      const weekend = ps.filter(p => [0, 5, 6].includes(parseDate(gameMap[p.game_id].date).getDay())).length;
      const total = secs.reduce((a, b) => a + b, 0);
      return { ps, count: ps.length, weekend, total, avg: secs.length ? total / secs.length : 0, max: secs.length ? Math.max(...secs) : 0 };
    };
    const duration = d.completed_at && d.started_at ? (d.completed_at - d.started_at) / 1000 : null;

    $app.innerHTML = `
      <div class="page" style="max-width:1300px">
        <div class="row spread"><h1 style="margin:0">${esc(d.name)}</h1><a class="btn" href="#/board/${d.id}">Open board</a></div>
        <p class="muted">${esc(d.season)} · <span class="pill ${d.status}">${d.status}</span> · ${d.order_type} order ·
          ${d.started_at ? `started ${fmtWhen(d.started_at)}` : 'not started'}${duration ? ` · took ${fmtDur(duration)}` : ''}</p>

        <div class="panel">
          <h2>Draft order</h2>
          <div class="row">${s.order.map(o => `<div class="row" style="gap:8px"><b style="font-family:var(--cond);font-size:1.6rem;color:var(--clock)">${o.position}</b>${avatar(users[o.user_id])}<span>${esc(o.display_name)}</span></div>`).join('<span class="muted">→</span>')}</div>
        </div>

        <div class="grid2">
          ${s.order.map(o => { const st = stats(o.user_id); return `
            <div class="panel partner-col">
              <h3>${avatar(users[o.user_id])} ${esc(o.display_name)}</h3>
              <div class="stat-row">
                <div class="stat"><div class="v">${st.count}</div><div class="k">Games</div></div>
                <div class="stat"><div class="v">${st.weekend}</div><div class="k">Fri–Sun</div></div>
                <div class="stat"><div class="v">${fmtDur(st.avg)}</div><div class="k">Avg pick</div></div>
                <div class="stat"><div class="v">${fmtDur(st.max)}</div><div class="k">Longest</div></div>
              </div>
              <ul class="mini-list">${st.ps.slice().sort((a, b) => gameMap[a.game_id].date.localeCompare(gameMap[b.game_id].date)).map(p => { const g = gameMap[p.game_id];
                return `<li><span>${fmtGameDate(g)} · ${esc(team(g.opponent).name)}</span><span>R${p.round} · ${fmtDur(p.seconds_taken)}</span></li>`; }).join('') || '<li class="muted">No picks</li>'}</ul>
            </div>`; }).join('')}
        </div>

        <div class="panel">
          <h2>Results by round</h2>
          <div class="table-wrap"><table class="results-grid">
            <thead><tr><th class="rnd">Rd</th>${s.order.map(o => `<th>${esc(o.display_name)}</th>`).join('')}</tr></thead>
            <tbody>${Array.from({ length: rounds }, (_, i) => `<tr><td class="rnd">${i + 1}</td>${s.order.map(o => `<td>${cell(pickAt(i + 1, o.user_id))}</td>`).join('')}</tr>`).join('')
              || `<tr><td colspan="${s.order.length + 1}" class="muted">No picks yet</td></tr>`}</tbody>
          </table></div>
        </div>

        <div class="panel">
          <h2>Pick log</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>#</th><th>Rd.Pick</th><th>Partner</th><th>Game</th><th>Time taken</th><th>Picked at</th></tr></thead>
            <tbody>${s.picks.map(p => { const g = gameMap[p.game_id]; const t = team(g.opponent);
              return `<tr><td>${p.overall}</td><td>${p.round}.${p.pick_in_round}</td><td>${esc(users[p.user_id].display_name)}${p.made_by && p.made_by !== p.user_id ? ' <span class="muted small">(entered by commissioner)</span>' : ''}</td>
                <td>${fmtGameDate(g)} · ${fmtTime(g.time)} · ${esc(t.city)} ${esc(t.name)}</td><td>${fmtDur(p.seconds_taken)}</td><td class="muted">${fmtWhen(p.picked_at)}</td></tr>`; }).join('')}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ profile
  async function viewProfile() {
    const me = state.me;
    const drafts = await api('GET', '/api/drafts');
    $app.innerHTML = `
      <div class="page">
        <h1>Profile</h1>
        <div class="grid2">
          <form class="panel" id="pForm">
            <div class="row" style="margin-bottom:14px">${avatar(me, 'lg')}<div><div style="font-family:var(--cond);font-size:1.6rem;font-weight:800">${esc(me.display_name)}</div>
              <div class="muted small">@${esc(me.username)}${me.is_admin ? ' · Commissioner' : ''} · joined ${esc(me.created_at.slice(0, 10))}</div></div></div>
            <div class="field"><label>Display name</label><input type="text" name="display_name" value="${esc(me.display_name)}" maxlength="40"></div>
            <div class="field"><label>Email (optional)</label><input type="email" name="email" value="${esc(me.email || '')}"></div>
            <div class="field"><label>Favourite Leaf (optional)</label><input type="text" name="favorite_player" value="${esc(me.favorite_player || '')}"></div>
            <div class="field"><label>Board colour</label><input type="color" name="color" value="${esc(me.color)}" style="width:70px;height:38px;border:0;background:none"></div>
            <p class="error" id="pErr"></p>
            <button class="btn primary">Save profile</button>
          </form>
          <form class="panel" id="pwForm">
            <h2>Change password</h2>
            <div class="field"><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input type="password" name="next" required minlength="6" autocomplete="new-password"></div>
            <p class="error" id="pwErr"></p>
            <button class="btn">Update password</button>
          </form>
        </div>
        <div class="panel"><h2>My drafts</h2><div id="myDrafts" class="muted">Loading…</div></div>
      </div>`;
    const $ = sel => $app.querySelector(sel);
    $('#pForm').onsubmit = async e => {
      e.preventDefault();
      try { const { user } = await api('PUT', '/api/me', Object.fromEntries(new FormData(e.target))); state.me = user; toast('Profile saved'); viewProfile(); }
      catch (err) { $('#pErr').textContent = err.message; }
    };
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      try { await api('PUT', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Password updated'); }
      catch (err) { $('#pwErr').textContent = err.message; }
    };
    // per-draft summary of my picks
    const rows = [];
    for (const d of drafts.filter(x => x.pick_count > 0)) {
      const s = await api('GET', `/api/drafts/${d.id}`);
      const mine = s.picks.filter(p => p.user_id === me.id);
      if (!mine.length) continue;
      const avg = mine.reduce((a, p) => a + p.seconds_taken, 0) / mine.length;
      rows.push(`<tr><td><a href="#/history/${d.id}">${esc(d.name)}</a></td><td>${mine.length}</td><td>${fmtDur(avg)}</td><td>${s.order.find(o => o.user_id === me.id)?.position ?? '—'}</td></tr>`);
    }
    $('#myDrafts').innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Draft</th><th>Games</th><th>Avg pick time</th><th>Draft slot</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : 'No picks yet.';
  }

  // ------------------------------------------------------------ boot
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = '#/login'; };
  window.addEventListener('hashchange', route);
  (async () => {
    const [{ user }, teams] = await Promise.all([api('GET', '/api/me'), fetch('/api/teams').then(r => r.json())]);
    state.me = user; state.teams = teams; state.teamMap = Object.fromEntries(teams.map(t => [t.abbr, t]));
    route();
  })();
})();
