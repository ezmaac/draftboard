/* Leafs Ticket Draft — single-page front end (no build step). */
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('topnav');
  const $modal = document.getElementById('modal');
  const $toast = document.getElementById('toast');
  const BASE_TITLE = 'Leafs Ticket Draft';

  const state = { me: null, mailEnabled: false, logoUrl: '', teams: [], teamMap: {} };
  let cleanup = null; // teardown for the current view (timers, SSE)
  let routeSeq = 0;   // bumps on every navigation so slow-loading views can tell they're stale
  /** Register teardown for the view started at `seq`; if the user already navigated away, tear down now. */
  function own(seq, fn) { if (seq !== routeSeq) { fn(); return; } cleanup = fn; }

  // ------------------------------------------------------------ utils
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const TYPE_LABEL = { preseason: 'Preseason', regular: 'Regular season', playoff: 'Playoffs' };
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtTime = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const gDate = g => (g.date ? parseDate(g.date) : null);
  const fmtDay = g => { const d = gDate(g); return d ? `${DOW[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}` : ''; };
  // Playoff games are named by round and game number; their date may not be set yet.
  const fmtGameDate = g => (g.round ? `R${g.round} G${g.game_no}${g.date ? ` · ${fmtDay(g)}` : ''}` : fmtDay(g));
  const fmtYear = g => (g.date ? `, ${parseDate(g.date).getFullYear()}` : '');
  const gameSort = (a, b) => (a.round || 0) - (b.round || 0) || (a.game_no || 0) - (b.game_no || 0) || (a.date || '').localeCompare(b.date || '');
  const upcoming = (g, today) => !g.date || g.date >= today;
  const fmtMoney = n => (n == null ? '' : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  const fmtDur = secs => {
    if (secs == null) return '—';
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const fmtWhen = ms => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const torontoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  const initials = name => (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${esc(u?.color || '#555')}">${esc(initials(u?.display_name))}</span>`;
  const team = abbr => state.teamMap[abbr] || { abbr, city: abbr === 'TBD' ? 'To be' : '', name: abbr === 'TBD' ? 'Determined' : abbr, div: 'TBD' };
  /** Team logo <img>; 'light' variant for light/coloured backgrounds, 'dark' for dark ones. Hidden if it fails to load. */
  const logo = (abbr, variant = 'dark', cls = '') => (state.logoUrl && abbr && abbr !== 'TBD'
    ? `<img class="logo ${cls}" src="${esc(state.logoUrl.replace('{abbr}', abbr).replace('{variant}', variant))}" alt="" loading="lazy" onerror="this.remove()">` : '');
  // Team-coloured tile: main colour background, second colour stripe, readable text.
  const teamStyle = t => (t.color ? `style="--bg:${t.color};--ac:${t.accent};--fg:${t.text}"` : '');
  const gameName = g => { const t = team(g.opponent); return `${fmtGameDate(g)} · ${t.city} ${t.name}`; };
  const anySingle = s => s.games.some(g => g.single);
  const seatLabel = p => (p.seat ? ` · seat ${p.seat}` : '');
  const usersOf = s => Object.fromEntries(s.order.map(o => [o.user_id, { id: o.user_id, display_name: o.display_name, color: o.color }]));
  // Prices are for the pair of seats (as in the Ticket Tracker); a single-seat pick is worth its share.
  const pickValue = (p, g) => (g.price || 0) / (p.seat ? g.seats : 1);

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/login')) { state.me = null; location.hash = '#/login'; }
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.details = data.errors; e.unmatched = data.unmatched; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, err = false) {
    $toast.textContent = msg; $toast.className = 'toast' + (err ? ' err' : ''); $toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ($toast.hidden = true), 3600);
  }

  function modal(html, onMount) {
    $modal.innerHTML = `<div class="box">${html}</div>`;
    $modal.hidden = false;
    const close = () => { $modal.hidden = true; $modal.innerHTML = ''; };
    $modal.onclick = e => { if (e.target === $modal || e.target.closest('[data-close]')) close(); };
    onMount?.($modal, close);
    return close;
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(t => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.15, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
      });
    } catch { /* audio unavailable */ }
  }

  function live(key, fn, handlers = {}) {
    const es = new EventSource(`/api/events/${key}`);
    es.addEventListener('update', fn);
    for (const [ev, h] of Object.entries(handlers)) es.addEventListener(ev, e => { try { h(JSON.parse(e.data)); } catch { /* ignore */ } });
    return () => es.close();
  }

  // ------------------------------------------------------------ router
  const routes = [
    [/^#\/login$/, viewLogin, { public: true }],
    [/^#\/?$/, viewHome],
    [/^#\/new$/, viewNewDraft],
    [/^#\/import$/, viewImport],
    [/^#\/board\/(\d+)$/, viewBoard],
    [/^#\/history$/, viewHistoryIndex],
    [/^#\/history\/(\d+)$/, viewHistory],
    [/^#\/trades$/, viewTrades],
    [/^#\/profile$/, viewProfile],
    [/^#\/partners$/, viewPartners],
    [/^#\/forgot$/, viewForgot, { public: true }],
    [/^#\/reset\/([\w-]+)$/, viewReset, { any: true }],
  ];

  async function route() {
    cleanup?.(); cleanup = null;
    $modal.hidden = true; $modal.innerHTML = '';  // don't carry a popup onto the next page
    const seq = ++routeSeq;
    document.title = BASE_TITLE;
    const hash = location.hash || '#/';
    const match = routes.find(([re]) => re.test(hash));
    if (!match) { location.hash = '#/'; return; }
    const [re, view, opts = {}] = match;
    if (!opts.any && !opts.public && !state.me) { location.hash = '#/login'; return; }
    if (opts.public && state.me) { location.hash = '#/'; return; }
    $nav.hidden = !state.me || !!opts.any;
    $nav.classList.remove('menu-open'); menuBtn.textContent = '☰';
    document.body.classList.toggle('on-board', view === viewBoard);
    document.body.classList.remove('in-timeout');
    document.getElementById('navPartners').hidden = !state.me?.is_admin;
    document.querySelectorAll('[data-nav]').forEach(a => {
      const n = a.dataset.nav;
      a.classList.toggle('active', (n === 'home' && /^#\/?$|^#\/new|^#\/board/.test(hash)) || (n === 'history' && hash.startsWith('#/import')) || hash.startsWith(`#/${n}`));
    });
    if (state.me) updateTradeBadge();
    try { await view(...hash.match(re).slice(1)); }
    catch (e) {
      if (seq !== routeSeq) return; $app.innerHTML = `<div class="page"><div class="panel"><h2>Something went wrong</h2><p class="error">${esc(e.message)}</p><a class="btn" href="#/">Back</a></div></div>`; }
  }

  async function updateTradeBadge() {
    try {
      const trades = await api('GET', '/api/trades');
      const n = trades.filter(t => t.status === 'pending' && t.to_user === state.me.id).length;
      const b = document.getElementById('tradeBadge');
      b.textContent = n; b.hidden = !n;
    } catch { /* ignore */ }
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
        ${mode === 'register' ? `<div class="field"><label>Display name</label><input type="text" name="display_name" placeholder="e.g. Mark"></div>
        <div class="field"><label>Email <span class="muted">(for “you’re on the clock” and trade alerts)</span></label><input type="email" name="email" autocomplete="email"></div>` : ''}
        <div class="field"><label>Password</label><div class="pw-wrap"><input type="password" name="password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div></div>
        ${mode === 'register' ? `<div class="field"><label>Invite code</label><input type="text" name="invite_code" required></div>` : ''}
        <p class="error" id="authErr"></p>
        <button class="btn primary" style="width:100%">${mode === 'login' ? 'Log in' : 'Create account'}</button>
        ${mode === 'login' ? '<p class="small" style="text-align:center;margin:14px 0 0"><a href="#/forgot">Forgot your password?</a></p>' : ''}
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

  function viewForgot() {
    $app.innerHTML = `
      <div class="auth-wrap"><form class="auth-card" id="fForm">
        <div style="font-size:2.4rem">🍁</div><h1>Forgot<br>password</h1>
        <p class="muted small">Enter your username or email. If it matches an account with an email address, we’ll send a reset link (valid for 2 hours).</p>
        <div class="field"><label>Username or email</label><input type="text" name="login" required autocomplete="username"></div>
        <p class="error" id="fMsg"></p>
        <button class="btn primary" style="width:100%">Send reset link</button>
        <p class="small muted" style="margin:14px 0 0">No email on your profile? Ask the commissioner — they can create a reset link for you.</p>
        <p class="small" style="text-align:center"><a href="#/login">← Back to log in</a></p>
      </form></div>`;
    $app.querySelector('#fForm').onsubmit = async e => {
      e.preventDefault();
      const msg = $app.querySelector('#fMsg');
      try {
        const r = await api('POST', '/api/password/forgot', Object.fromEntries(new FormData(e.target)));
        msg.style.color = 'var(--text)';
        msg.textContent = r.mail_enabled ? 'If that matches an account, a reset link is on its way. Check your email.'
          : 'Email isn’t set up on this server yet, so no email was sent. Ask the commissioner for a reset link.';
      } catch (err) { msg.textContent = err.message; }
    };
  }

  function viewReset(token) {
    $app.innerHTML = `
      <div class="auth-wrap"><form class="auth-card" id="rForm">
        <div style="font-size:2.4rem">🍁</div><h1>Choose a new<br>password</h1>
        <div class="field"><label>New password</label><div class="pw-wrap"><input type="password" name="password" required minlength="6" autocomplete="new-password"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div></div>
        <div class="field"><label>Confirm new password</label><div class="pw-wrap"><input type="password" name="confirm" required minlength="6" autocomplete="new-password"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div></div>
        <p class="error" id="rErr"></p>
        <button class="btn primary" style="width:100%">Set password &amp; log in</button>
      </form></div>`;
    $app.querySelector('#rForm').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.password !== f.confirm) { $app.querySelector('#rErr').textContent = 'Passwords don’t match'; return; }
      try { const { user } = await api('POST', '/api/password/reset', { token, password: f.password }); state.me = user; toast('Password updated'); location.hash = '#/'; }
      catch (err) { $app.querySelector('#rErr').textContent = err.message; }
    };
  }

  async function viewPartners() {
    if (!state.me.is_admin) { location.hash = '#/'; return; }
    const seq = routeSeq;
    const [users, summary] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/history/summary')]);
    if (seq !== routeSeq) return;
    const seasonsOf = uid => new Set(summary.filter(r => r.user_id === uid).map(r => r.draft_id)).size;
    const shown = users.filter(u => !u.deleted);
    const removed = users.filter(u => u.deleted);
    $app.innerHTML = `
      <div class="page">
        <h1>Partners</h1>
        <div class="panel">
          <p class="muted small">You can have more than one commissioner — e.g. a backup who can run the draft if you’re away. There must always be at least one. Inactive partners can’t log in and aren’t offered for new drafts; their history stays. New partners join with the invite code.</p>
          <div class="table-wrap"><table>
            <thead><tr><th>Partner</th><th>Username</th><th>Email</th><th>Drafts</th><th>Role</th><th>Status</th><th></th></tr></thead>
            <tbody>${shown.map(u => `<tr>
              <td><div class="row" style="gap:8px">${avatar(u)} <b>${esc(u.display_name)}</b>${u.id === state.me.id ? ' <span class="muted small">(you)</span>' : ''}</div></td>
              <td>@${esc(u.username)}</td><td>${esc(u.email || '—')}</td><td>${seasonsOf(u.id)}</td>
              <td>${u.is_admin ? '<span class="pill complete">commissioner</span>' : 'partner'}</td>
              <td>${u.active ? '<span class="pill complete">active</span>' : '<span class="pill setup">inactive</span>'}</td>
              <td><div class="row" style="gap:6px;justify-content:flex-end">
                ${u.id === state.me.id ? '' : `<button class="btn sm" data-act="${u.active ? 'deactivate' : 'activate'}" data-id="${u.id}">${u.active ? 'Deactivate' : 'Activate'}</button>`}
                <button class="btn sm" data-act="${u.is_admin ? 'demote' : 'promote'}" data-id="${u.id}">${u.is_admin ? 'Remove commissioner' : 'Make commissioner'}</button>
                <button class="btn sm" data-act="reset" data-id="${u.id}">Reset password</button>
                ${u.id === state.me.id ? '' : `<button class="btn danger sm" data-act="delete" data-id="${u.id}">Delete</button>`}
              </div></td></tr>`).join('')}</tbody>
          </table></div>
        </div>
        ${removed.length ? `<div class="panel"><h2>Removed profiles</h2><p class="muted small">Kept by name only so past draft results stay complete: ${removed.map(u => esc(u.display_name)).join(', ')}.</p></div>` : ''}
      </div>`;
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    $app.querySelectorAll('[data-act]').forEach(b => (b.onclick = async () => {
      const u = byId[b.dataset.id], act = b.dataset.act;
      try {
        if (act === 'activate' || act === 'deactivate') {
          if (act === 'deactivate' && !confirm(`Deactivate ${u.display_name}? They’ll be logged out, can’t log in, and won’t be offered for new drafts. Their history stays.`)) return;
          await api('PUT', `/api/users/${u.id}`, { active: act === 'activate' });
        } else if (act === 'promote' || act === 'demote') {
          await api('PUT', `/api/users/${u.id}`, { is_admin: act === 'promote' });
          if (u.id === state.me.id) state.me.is_admin = false;
        } else if (act === 'delete') {
          if (!confirm(`Delete ${u.display_name}’s profile? This can’t be undone.\n\nIf they have draft history, their name is kept on past results but their login, email and profile are removed.`)) return;
          const r = await api('DELETE', `/api/users/${u.id}`);
          toast(r.kept_history ? 'Profile removed — name kept on past results' : 'Profile deleted');
        } else if (act === 'reset') {
          const r = await api('POST', `/api/users/${u.id}/reset-link`);
          modal(`<h2>Password reset link</h2>
            <p class="small">${r.emailed ? `Emailed to ${esc(u.email)}. You can also send it yourself:` : `Send this to ${esc(u.display_name)} (text, email…). It works once, for ${r.hours} hours.`}</p>
            <input type="text" readonly value="${esc(r.link)}" id="rl" style="margin-bottom:10px">
            <div class="row"><button class="btn primary" id="copyRl">Copy link</button><button class="btn" data-close>Close</button></div>`, ($m) => {
            $m.querySelector('#rl').select();
            $m.querySelector('#copyRl').onclick = async () => { try { await navigator.clipboard.writeText(r.link); toast('Copied'); } catch { $m.querySelector('#rl').select(); } };
          });
          return;
        }
        route();
      } catch (e) { toast(e.message, true); }
    }));
  }

  // ------------------------------------------------------------ home (drafts list)
  async function viewHome() {
        const seq = routeSeq;
const [drafts, users] = await Promise.all([api('GET', '/api/drafts'), api('GET', '/api/users')]);
    if (seq !== routeSeq) return;
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const isAdmin = state.me.is_admin;
    const item = d => {
      const oc = d.on_clock && userMap[d.on_clock.user_id];
      return `
      <div class="draft-item">
        <div>
          <div class="title">${esc(d.name)} <span class="pill ${d.status}">${d.status}</span>
            <span class="pill setup">${d.kind === 'playoff' ? 'Playoffs · single seats' : 'Season'}</span>
            ${d.mode === 'async' ? '<span class="pill setup">✉ by email</span>' : ''}${d.source === 'import' ? '<span class="pill setup">imported</span>' : ''}</div>
          <div class="muted small">${esc(d.season)} · ${d.game_count} games · ${d.order_type} order · ${d.pick_count}/${d.total_picks} picks</div>
          ${d.timeout ? `<div class="small" style="margin-top:4px"><span class="pill live" style="background:#3a2a0a;color:#ffcf3f">⏸ time out</span> called by ${esc(d.timeout.by_name)}</div>` : ''}
          ${oc ? `<div class="small" style="margin-top:4px">${avatar(oc)} <b>${esc(oc.display_name)}</b> on the clock · R${d.on_clock.round} P${d.on_clock.pick_in_round} · ${fmtDur(d.elapsed_ms / 1000)}</div>` : ''}
        </div>
        <div class="row">
          ${d.status === 'live' ? `<a class="btn go" href="#/board/${d.id}">${d.on_clock?.user_id === state.me.id ? 'Your pick →' : 'Enter draft room'}</a>` : ''}
          ${d.status === 'setup' ? `<a class="btn" href="#/board/${d.id}">Preview board</a>${isAdmin ? `<button class="btn primary" data-start="${d.id}">Start draft</button>` : ''}` : ''}
          ${d.status === 'complete' ? `<a class="btn" href="#/board/${d.id}">Board</a><a class="btn primary" href="#/history/${d.id}">Results</a>` : ''}
          ${isAdmin && (d.status !== 'complete' || d.source === 'import') ? `<button class="btn danger sm" data-del="${d.id}">Delete</button>` : ''}
        </div>
      </div>`;
    };
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
          ${done.length ? done.slice(0, 4).map(item).join('') + (done.length > 4 ? `<p><a href="#/history">All ${done.length} past drafts →</a></p>` : '') : `<p class="muted">Completed drafts will be kept here.</p>`}
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
    own(seq, live('home', () => { if ($modal.hidden && /^#\/?$/.test(location.hash || '#/')) route(); }));
  }

  // ------------------------------------------------------------ new draft (commissioner)
  const teamOptions = (sel = '') => `<option value="TBD">TBD</option>${state.teams.filter(t => !t.defunct).map(t => `<option value="${t.abbr}" ${t.abbr === sel ? 'selected' : ''}>${esc(t.city)} ${esc(t.name)}</option>`).join('')}`;

  async function viewNewDraft() {
    if (!state.me.is_admin) { location.hash = '#/'; return; }
        const seq = routeSeq;
const [allUsers, files, rot] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/schedules'), api('GET', '/api/drafts/next-order')]);
    if (seq !== routeSeq) return;
    const users = allUsers.filter(u => u.active);  // inactive partners can't be added to new drafts
    // Default to the season after the most recent season draft (or the current season if there's none).
    const prevStart = rot.previous ? parseInt(rot.previous.season, 10) : NaN;
    const y = Number.isFinite(prevStart) ? prevStart + 1 : (new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1);
    let order = rot.suggested.filter(id => users.some(u => u.id === id));
    let games = [];
    let kind = 'season';

    $app.innerHTML = `
      <div class="page">
        <h1>New draft</h1>
        <div class="grid2">
          <div class="panel">
            <h2>Details</h2>
            <div class="field"><label>Draft type</label>
              <select id="dKind"><option value="season">Season draft — preseason + regular season, seats as pairs</option>
              <option value="playoff">Playoff draft — by round &amp; game (rounds 1–3 pairs, Final single seats)</option></select>
            </div>
            <div class="field"><label>Draft name</label><input type="text" id="dName"></div>
            <div class="field"><label>Season</label><input type="text" id="dSeason" value="${y}-${String(y + 1).slice(2)}"></div>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1"><label>Order</label>
                <select id="dType"><option value="snake">Snake (1-2-3, 3-2-1)</option><option value="linear">Linear (1-2-3, 1-2-3)</option></select></div>
              <div class="field" style="flex:1"><label>How you’ll draft</label>
                <select id="dMode"><option value="live">Live — together, now</option><option value="async">By email — over a few days</option></select></div>
            </div>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1"><label>Clock warning after (minutes, 0 = none — never a hard limit)</label><input type="number" id="dWarn" value="2" min="0" step="0.5"></div>
              <div class="field" style="flex:1"><label>Time-out length (minutes) — any partner can call one</label><input type="number" id="dTO" value="3" min="0.5" max="30" step="0.5"></div>
            </div>
            <h2 style="margin-top:20px">Participating partners</h2>
            <p class="muted small" style="margin-top:-4px">Untick anyone sitting this draft out. Inactive partners aren’t listed.</p>
            <div class="check-list" id="who"></div>
            <h2 style="margin-top:16px">Selection order</h2>
            ${rot.previous ? `<div class="prev-order"><div class="k">Last season · ${esc(rot.previous.season)}</div>
              ${rot.previous.order.map(o => `<span>${o.position}. ${esc(o.display_name)}</span>`).join('')}
              <div class="muted small" id="rotNote">Rotated: last season’s final pick moves to first.</div></div>` : ''}
            <ol class="order-list" id="order"></ol>
            <div class="row"><button class="btn sm" id="useRot">↻ Use rotation</button><button class="btn sm" id="shuffle">🎲 Randomize</button></div>
          </div>
          <div class="panel" id="poPanel" hidden>
            <h2>Playoff rounds</h2>
            <p class="muted small">Pick the rounds this draft covers. Home games are chosen by round and game number — with home-ice advantage: games 1, 2, 5, 7; without: 3, 4, 6. Dates and opponents can be filled in later.</p>
            <div id="poRounds"></div>
            <div id="poSummary" class="small"></div>
          </div>
          <div class="panel" id="schedPanel">
            <h2>Schedule</h2>
            <div class="field"><label>Source</label>
              <select id="src">
                ${files.map(f => `<option value="bundled:${esc(f)}">${esc(f.replace(/\.csv$/, '').replace(/_/g, ' '))} (official)</option>`).join('')}
                <option value="csv">Paste / upload CSV</option>
                <option value="none">Enter games by hand</option>
                <option value="sample">Sample schedule (placeholder)</option>
              </select>
            </div>
            <div id="sampleOpts" class="field" hidden><label>Season starts (year)</label><input type="number" id="sYear" value="${y}"></div>
            <div id="csvOpts" hidden>
              <p class="muted small">Needs <code>Date</code> and <code>Team</code>/<code>Opponent</code> columns; <code>Time</code>, <code>Type</code>, <code>Price</code>, <code>Notes</code> optional. Away games (“@ …”) are skipped.</p>
              <input type="file" id="csvFile" accept=".csv,text/csv" style="margin-bottom:8px">
              <textarea id="csv" placeholder="Type,Date,Team,Time,Price&#10;Pre-Season,24-Sep-26,Ottawa Senators,7:00 PM,$150"></textarea>
            </div>
            <button class="btn" id="preview">Load schedule</button>
            <p class="error" id="schedErr"></p>
            <div id="schedSummary" class="small"></div>
          </div>
        </div>
        <div class="panel" id="gamesPanel">
          <div class="row spread"><h2 style="margin:0">Games (<span id="gCount">0</span>)</h2><span class="muted small">Review, remove, or add games before creating the draft.</span></div>
          <div class="table-wrap"><table class="games-table">
            <thead><tr><th>Date</th><th>Time</th><th>Opponent</th><th>Type</th><th>Price (pair)</th><th>Notes</th><th></th></tr></thead>
            <tbody id="gRows"></tbody>
            <tfoot><tr>
              <td><input type="date" id="aDate"></td><td><input type="time" id="aTime" value="19:00"></td>
              <td><select id="aOpp">${teamOptions()}</select></td>
              <td><select id="aType"><option value="preseason">Preseason</option><option value="regular" selected>Regular</option><option value="playoff">Playoff</option></select></td>
              <td><input type="number" id="aPrice" min="0" placeholder="$ pair"></td><td><input type="text" id="aNotes" placeholder="e.g. Rd 1 Gm 2"></td>
              <td><button class="btn sm" id="addGame">Add</button></td></tr></tfoot>
          </table></div>
        </div>
        <div class="row"><button class="btn primary" id="create">Create draft</button><a class="btn" href="#/">Cancel</a><span class="error" id="createErr"></span></div>
      </div>`;

    const $ = s => $app.querySelector(s);
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    // --- playoff rounds: [{ round, include, home_ice, opponent, price }]; rounds 1-3 pairs, round 4 single seats
    const poRounds = [1, 2, 3, 4].map(r => ({ round: r, include: r <= 3, home_ice: true, opponent: 'TBD', price: '' }));
    let poTaken = {};  // round -> draft name already covering it this season
    let poPrior = null;  // earlier playoff draft this season, whose order can be reused
    let poOrderMode = 'reuse';
    const roundRange = rs => { const a = rs.map(r => r.round); return a.length === 1 ? `Round ${a[0]}` : a.every((r, i) => !i || r === a[i - 1] + 1) ? `Rounds ${a[0]}–${a.at(-1)}` : `Rounds ${a.join(', ')}`; };
    const setName = () => {
      const inc = poRounds.filter(r => r.include && !poTaken[r.round]);
      $('#dName').value = kind === 'playoff' ? `${$('#dSeason').value} Playoffs${inc.length ? ` — ${roundRange(inc)}` : ''}` : `${$('#dSeason').value} Season Draft`;
    };
    const loadPoTaken = async () => {
      poTaken = {};
      const season = $('#dSeason').value.trim();
      poPrior = await api('GET', `/api/drafts/playoff-prior?season=${encodeURIComponent(season)}`);
      const prior = (await api('GET', '/api/drafts')).filter(d => d.kind === 'playoff' && d.season === season && d.source !== 'import');
      for (const d of prior) (await api('GET', `/api/drafts/${d.id}`)).games.forEach(g => { if (g.round) poTaken[g.round] = d.name; });
      poRounds.forEach(r => { if (poTaken[r.round]) r.include = false; });
      if (!poRounds.some(r => r.include)) { const next = poRounds.find(r => !poTaken[r.round]); if (next) next.include = true; }
    };
    const renderPo = () => {
      $('#poRounds').innerHTML = `<table class="po-table"><thead><tr><th></th><th>Round</th><th>Home ice</th><th>Home games</th><th>Seats per pick</th><th>Opponent</th><th>Price (pair)</th></tr></thead><tbody>${poRounds.map((r, i) => {
        const taken = poTaken[r.round];
        return `<tr class="${r.include ? '' : 'off'}">
          <td><input type="checkbox" data-po-inc="${i}" ${r.include ? 'checked' : ''} ${taken ? 'disabled' : ''}></td>
          <td><b>Round ${r.round}</b>${r.round === 4 ? ' <span class="muted small">Final</span>' : ''}${taken ? `<div class="muted small">in “${esc(taken)}”</div>` : ''}</td>
          <td><select data-po-hi="${i}"><option value="1" ${r.home_ice ? 'selected' : ''}>Yes — 4 games</option><option value="0" ${r.home_ice ? '' : 'selected'}>No — 3 games</option></select></td>
          <td>${(r.home_ice ? [1, 2, 5, 7] : [3, 4, 6]).map(n => `G${n}`).join(' ')}</td>
          <td>${r.round === 4 ? '<span class="pill live" style="background:#2b2340;color:#c9b6ff">1 seat</span>' : '<span class="pill setup">pair</span>'}</td>
          <td><select data-po-opp="${i}">${teamOptions(r.opponent)}</select></td>
          <td><input type="number" min="0" data-po-price="${i}" value="${esc(r.price)}" placeholder="$" style="width:90px"></td></tr>`; }).join('')}</tbody></table>`;
      const q = sel => $app.querySelectorAll(sel);
      q('[data-po-inc]').forEach(el => (el.onchange = () => { poRounds[el.dataset.poInc].include = el.checked; setName(); renderPo(); }));
      q('[data-po-hi]').forEach(el => (el.onchange = () => { poRounds[el.dataset.poHi].home_ice = el.value === '1'; renderPo(); }));
      q('[data-po-opp]').forEach(el => (el.onchange = () => { poRounds[el.dataset.poOpp].opponent = el.value; }));
      q('[data-po-price]').forEach(el => (el.oninput = () => { poRounds[el.dataset.poPrice].price = el.value; }));
      renderSummary();
    };
    const nextSeason = `${y}-${String(y + 1).slice(2)}`;
    const syncKind = async () => {
      // Playoffs belong to the season just drafted; a new season draft is for the next one.
      if (kind === 'playoff' && rot.previous && $('#dSeason').value === nextSeason) $('#dSeason').value = rot.previous.season;
      if (kind === 'season' && rot.previous && $('#dSeason').value === rot.previous.season) $('#dSeason').value = nextSeason;
      $('#poPanel').hidden = kind !== 'playoff'; $('#schedPanel').hidden = kind === 'playoff'; $('#gamesPanel').hidden = kind === 'playoff';
      if (kind === 'playoff') { await loadPoTaken(); renderPo(); }
      renderOrder();
      setName(); renderOrder(); renderSummary();
    };
    $('#dSeason').oninput = () => { setName(); if (kind === 'playoff') syncKind(); };
    $('#dKind').onchange = () => { kind = $('#dKind').value; syncKind(); };
    setName();
    $('#dMode').onchange = () => { if ($('#dMode').value === 'async') $('#dWarn').value = 0; };

    const rotationFor = ids => [...rot.suggested.filter(id => ids.includes(id)), ...ids.filter(id => !rot.suggested.includes(id))];
    const renderWho = () => {
      $('#who').innerHTML = users.map(u => `<label><input type="checkbox" value="${u.id}" ${order.includes(u.id) ? 'checked' : ''}> ${avatar(u)} ${esc(u.display_name)}</label>`).join('');
      $('#who').querySelectorAll('input').forEach(cb => (cb.onchange = () => {
        const id = Number(cb.value);
        // Re-joining partners slot back into their rotation position.
        order = cb.checked ? rotationFor([...order, id]).filter(x => order.includes(x) || x === id) : order.filter(x => x !== id);
        renderOrder();
      }));
    };
    const renderOrder = () => {
      $('#shuffle').hidden = kind === 'playoff';
      $('#useRot').hidden = kind === 'playoff' || !rot.previous;
      const pv = $app.querySelector('.prev-order'); if (pv) pv.hidden = kind === 'playoff';
      if (kind === 'playoff') {
        $('#order').innerHTML = poPrior ? `
          <li class="po-choice"><label><input type="radio" name="poOrder" value="reuse" ${poOrderMode === 'reuse' ? 'checked' : ''}>
            Use the order from “${esc(poPrior.name)}”: <b>${poPrior.order.map(o => `${o.position}. ${esc(o.display_name)}`).join('  ')}</b></label></li>
          <li class="po-choice"><label><input type="radio" name="poOrder" value="random" ${poOrderMode === 'random' ? 'checked' : ''}>
            🎲 Draw a new random order <span class="muted">(drawn by the app when you create the draft)</span></label></li>`
          : `<li class="muted">🎲 The playoff order is drawn at random by the app when you create the draft. ${order.length} partners.</li>`;
        $app.querySelectorAll('[name=poOrder]').forEach(r => (r.onchange = () => { poOrderMode = r.value; }));
        renderSummary(); return;
      }
      $('#order').innerHTML = order.map((id, i) => `
        <li><span class="pos">${i + 1}</span>${avatar(byId[id])}<span class="name">${esc(byId[id].display_name)}</span>
        <button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>▼</button></li>`).join('')
        || '<li class="muted">Tick the partners taking part.</li>';
      $('#order').querySelectorAll('[data-up]').forEach(b => (b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; renderOrder(); }));
      $('#order').querySelectorAll('[data-down]').forEach(b => (b.onclick = () => { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; renderOrder(); }));
      renderSummary();
    };
    const renderSummary = () => {
      const n = order.length;
      if (kind === 'playoff') {
        const inc = poRounds.filter(r => r.include && !poTaken[r.round]);
        const nGames = inc.reduce((a, r) => a + (r.home_ice ? 4 : 3), 0);
        const picks = inc.reduce((a, r) => a + (r.home_ice ? 4 : 3) * (r.round === 4 ? 2 : 1), 0);
        $('#poSummary').innerHTML = inc.length ? `<p><b>${roundRange(inc)}</b>: ${nGames} home games → ${picks} picks${n ? ` → ${Math.floor(picks / n)} each${picks % n ? `, plus 1 extra for the first ${picks % n} in the order` : ''}` : ''}.</p>` : '<p class="error">Choose at least one round.</p>';
        return;
      }
      const picks = games.length;
      const months = {};
      games.forEach(g => { const d = parseDate(g.date); const k = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; months[k] = (months[k] || 0) + 1; });
      const types = {}; games.forEach(g => (types[g.type] = (types[g.type] || 0) + 1));
      $('#schedSummary').innerHTML = games.length ? `
        <p><b>${games.length} home games</b> (${Object.entries(types).map(([t, c]) => `${c} ${TYPE_LABEL[t].toLowerCase()}`).join(', ')})<br>${Object.entries(months).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
        ${n ? `<p class="muted">${picks} picks${kind === 'playoff' ? ' (2 seats per game)' : ''} → ${Math.floor(picks / n)} each${picks % n ? `, plus 1 extra for the first ${picks % n} in the order` : ' — an even split'}.</p>` : ''}
        ${$('#src').value === 'sample' ? '<p class="error">Sample data only — not the real Leafs schedule.</p>' : ''}` : '<p class="muted">No games yet.</p>';
    };
    const renderGames = () => {
      games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      $('#gCount').textContent = games.length;
      $('#gRows').innerHTML = games.map((g, i) => { const t = team(g.opponent); return `<tr>
        <td>${fmtGameDate(g)}, ${parseDate(g.date).getFullYear()}</td><td>${fmtTime(g.time)}</td><td class="with-logo">${logo(g.opponent, 'dark', 'xs')}${esc(t.city)} ${esc(t.name)}</td>
        <td>${TYPE_LABEL[g.type]}</td><td>${fmtMoney(g.price)}</td><td>${esc(g.notes)}</td>
        <td><button class="icon-btn" data-rm="${i}" title="Remove">✕</button></td></tr>`; }).join('');
      $('#gRows').querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { games.splice(+b.dataset.rm, 1); renderGames(); }));
      renderSummary();
    };
    renderWho(); renderOrder();
    $('#useRot').onclick = () => { order = rotationFor(order); renderOrder(); };
    $('#shuffle').onclick = () => { for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } renderOrder(); };
    $('#src').onchange = () => { const v = $('#src').value; $('#csvOpts').hidden = v !== 'csv'; $('#sampleOpts').hidden = v !== 'sample'; $('#preview').hidden = v === 'none'; };
    $('#src').onchange();
    $('#csvFile').onchange = async e => { const f = e.target.files[0]; if (f) $('#csv').value = await f.text(); };
    $('#addGame').onclick = () => {
      if (!$('#aDate').value) { toast('Pick a date', true); return; }
      games.push({ date: $('#aDate').value, time: $('#aTime').value || '19:00', opponent: $('#aOpp').value, type: $('#aType').value,
        price: $('#aPrice').value ? Number($('#aPrice').value) : null, notes: $('#aNotes').value });
      $('#aNotes').value = ''; renderGames();
    };

    const loadSchedule = async () => {
      $('#schedErr').textContent = '';
      const v = $('#src').value;
      try {
        const r = await api('POST', '/api/schedule/preview', v.startsWith('bundled:')
          ? { source: 'bundled', file: v.slice(8) } : { source: v, csv: $('#csv').value, season_start: $('#sYear').value });
        games = kind === 'playoff' ? r.games.map(g => ({ ...g, type: 'playoff' })) : r.games;
        renderGames();
        if (r.errors.length) $('#schedErr').innerHTML = r.errors.slice(0, 8).map(esc).join('<br>') + (r.errors.length > 8 ? `<br>…and ${r.errors.length - 8} more` : '');
      } catch (e) { $('#schedErr').textContent = e.message; }
    };
    $('#preview').onclick = loadSchedule;
    if (files.length) loadSchedule(); else { $('#src').value = 'sample'; $('#src').onchange(); loadSchedule(); }

    $('#create').onclick = async () => {
      try {
        const { id } = await api('POST', '/api/drafts', {
          name: $('#dName').value, season: $('#dSeason').value, kind, mode: $('#dMode').value, order_type: $('#dType').value,
          warn_secs: Math.round(Number($('#dWarn').value || 0) * 60), timeout_secs: Math.round(Number($('#dTO').value || 3) * 60), user_ids: order, games,
          rounds: poRounds.filter(r => r.include && !poTaken[r.round]).map(r => ({ round: r.round, home_ice: r.home_ice, opponent: r.opponent, price: r.price })),
          playoff_order: poPrior ? poOrderMode : 'random',
        });
        toast('Draft created'); location.hash = `#/board/${id}`;
      } catch (e) { $('#createErr').textContent = e.message; }
    };
  }

  // ------------------------------------------------------------ import past draft
  async function viewImport() {
    if (!state.me.is_admin) { location.hash = '#/'; return; }
    const seq = routeSeq;
    const users = await api('GET', '/api/users');
    if (seq !== routeSeq) return;
    $app.innerHTML = `
      <div class="page">
        <p><a href="#/history">← History</a></p>
        <h1>Import past drafts</h1>
        <div class="panel" id="bundled"><p class="muted">Loading bundled history…</p></div>
        <h2>Import a single draft from CSV</h2>
        <div class="grid2">
          <div class="panel">
            <div class="field"><label>Draft type</label><select id="iKind"><option value="season">Season</option><option value="playoff">Playoffs (single seats)</option></select></div>
            <div class="field"><label>Season</label><input type="text" id="iSeason" placeholder="2025-26"></div>
            <div class="field"><label>Name</label><input type="text" id="iName" placeholder="2025-26 Season Draft"></div>
            <div class="field"><label>Order</label><select id="iType"><option value="snake">Snake</option><option value="linear">Linear</option></select></div>
            <div class="field"><label>CSV file</label><input type="file" id="iFile" accept=".csv,text/csv"></div>
            <textarea id="iCsv" placeholder="Pick,Partner,Date,Team,Time,Price&#10;1,Mark,7-Oct-25,Montreal Canadiens,7:00 PM,$404&#10;2,Dave,11-Oct-25,Ottawa Senators,7:00 PM,$304"></textarea>
            <p class="error" id="iErr"></p>
            <button class="btn primary" id="iGo">Import</button>
          </div>
          <div class="panel">
            <h2>Format</h2>
            <p class="small">One row per pick, in the order they were made (or with a <code>Pick</code> number column).</p>
            <ul class="small">
              <li><b>Partner</b> — must match a username or display name: ${users.map(u => `<code>${esc(u.display_name)}</code>`).join(', ')}</li>
              <li><b>Date</b> and <b>Team</b> (or Opponent) — required</li>
              <li><b>Pick</b>, <b>Time</b>, <b>Price</b>, <b>Type</b>, <b>Seconds</b> (time taken, e.g. <code>1:42</code>) — optional</li>
            </ul>
            <p class="small muted">Round 1’s order is taken from the first pick by each partner. Every partner in the file needs an account first. Imported drafts can be deleted and re-imported.</p>
          </div>
        </div>
      </div>`;
    const $ = s => $app.querySelector(s);
    renderBundled(users);
    $('#iSeason').oninput = () => { $('#iName').value = `${$('#iSeason').value} ${$('#iKind').value === 'playoff' ? 'Playoff' : 'Season'} Draft`; };
    $('#iFile').onchange = async e => { const f = e.target.files[0]; if (f) $('#iCsv').value = await f.text(); };
    $('#iGo').onclick = async () => {
      $('#iErr').textContent = '';
      try {
        const r = await api('POST', '/api/drafts/import', { name: $('#iName').value, season: $('#iSeason').value, kind: $('#iKind').value, order_type: $('#iType').value, csv: $('#iCsv').value });
        toast(`Imported ${r.picks} picks`); location.hash = `#/history/${r.id}`;
      } catch (e) { $('#iErr').innerHTML = esc(e.message) + (e.details ? '<br>' + e.details.slice(0, 10).map(esc).join('<br>') : '') + (e.unmatched ? '<br>Partner names must match a username or display name.' : ''); }
    };
  }

  async function renderBundled(users) {
    const el = $app.querySelector('#bundled');
    let data;
    try { data = await api('GET', '/api/history/bundled'); } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    if (!data.seasons.length) { el.innerHTML = '<p class="muted">No bundled history found (history/manifest.json).</p>'; return; }
    const guess = n => users.find(u => [u.username, u.display_name].some(x => x.toLowerCase() === n.toLowerCase()))?.id || '';
    el.innerHTML = `
      <h2>Ticket Tracker history</h2>
      <p class="small muted">${data.seasons.length} seasons converted from your workbook. Match each spreadsheet name to a partner’s account, choose seasons, and import.</p>
      <div class="row" style="margin-bottom:12px">${data.partner_names.map(n => `
        <div class="field" style="min-width:180px"><label>“${esc(n)}” is…</label>
          <select data-alias="${esc(n)}"><option value="">— choose account —</option>${users.map(u => `<option value="${u.id}" ${guess(n) === u.id ? 'selected' : ''}>${esc(u.display_name)} (@${esc(u.username)})</option>`).join('')}</select></div>`).join('')}</div>
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="bAll" checked></th><th>Season</th><th>Games</th><th>Order (round 1)</th><th>Pick sequence</th><th>Notes</th><th></th></tr></thead>
        <tbody>${data.seasons.map(m => `<tr>
          <td><input type="checkbox" data-season="${esc(m.season)}" ${m.imported ? '' : 'checked'}></td>
          <td><b>${esc(m.season)}</b></td><td>${m.picks}${m.unassigned ? ` <span class="muted">+${m.unassigned} not drafted</span>` : ''}</td>
          <td>${m.order.map(esc).join(' → ')}</td><td>${m.pick_order_recorded ? '✓ recorded' : '<span class="muted">not recorded</span>'}</td>
          <td class="small muted">${[m.freebie ? `Freebie: ${esc(m.freebie)}` : '', ...(m.report || []).map(esc)].filter(Boolean).join('<br>')}</td>
          <td>${m.imported ? '<span class="pill complete">imported</span>' : ''}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="bGo">Import selected</button>
        <label class="toggle" style="display:flex;gap:6px;margin:0;color:var(--text)"><input type="checkbox" id="bReplace"> Re-import seasons already imported</label>
        <span class="error" id="bErr"></span></div>`;
    const q = sel => el.querySelector(sel);
    q('#bAll').onchange = () => el.querySelectorAll('[data-season]').forEach(c => (c.checked = q('#bAll').checked));
    q('#bGo').onclick = async () => {
      const aliases = {};
      for (const sel of el.querySelectorAll('[data-alias]')) {
        if (!sel.value) { q('#bErr').textContent = `Choose an account for “${sel.dataset.alias}” (partners need to sign up first).`; return; }
        aliases[sel.dataset.alias] = Number(sel.value);
      }
      const seasons = [...el.querySelectorAll('[data-season]:checked')].map(c => c.dataset.season);
      if (!seasons.length) { q('#bErr').textContent = 'Pick at least one season.'; return; }
      q('#bGo').disabled = true; q('#bErr').textContent = '';
      try {
        const r = await api('POST', '/api/history/bundled', { seasons, aliases, replace: q('#bReplace').checked });
        const ok = r.results.filter(x => x.id).length, skipped = r.results.filter(x => x.skipped).length, bad = r.results.filter(x => x.error);
        toast(`Imported ${ok} season${ok === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already imported` : ''}`, !!bad.length);
        if (bad.length) q('#bErr').innerHTML = bad.map(b => `${esc(b.season)}: ${esc(b.error)}`).join('<br>');
        else location.hash = '#/history';
      } catch (e) { q('#bErr').textContent = e.message; }
      q('#bGo').disabled = false;
    };
  }

  // ------------------------------------------------------------ the draft board
  async function viewBoard(id) {
    const seq = routeSeq;
    let s = await api('GET', `/api/drafts/${id}`);
    if (seq !== routeSeq) return;
    let clockBase = 0, clockT0 = 0, warnedFor = null;
    let online = [];  // user ids with this board open (live presence)
    let tip = null;   // my private suggested pick (from my profile preferences)
    let skew = 0;     // server clock minus this device's clock, for the time-out countdown
    let toRefreshing = false;
    let selected = null;
    const f = loadFilters();

    function loadFilters() {
      const d = { team: '', dows: [], type: '', show: [], q: '' };
      try { const v = { ...d, ...JSON.parse(localStorage.getItem('boardFilters') || '{}') }; if (!Array.isArray(v.show)) v.show = []; return v; } catch { return d; }
    }
    function saveFilters() { try { localStorage.setItem('boardFilters', JSON.stringify(f)); } catch { /* storage unavailable */ } }

    $app.innerHTML = `
      <div class="board-page">
        <div class="board-top" id="boardTop">
        <div class="timeout-banner" id="toBanner" hidden></div>
        <div class="scoreboard">
          <div class="sb-cell">
            <div class="clock-ctrls">
              <button class="icon-btn" id="pauseBtn" title="Pause / resume clock">❚❚</button>
              <button class="icon-btn" id="undoBtn" title="Undo last pick (commissioner)">↶</button>
              <button class="icon-btn" id="nudgeBtn" title="Email a reminder to whoever is on the clock">✉</button>
              <button class="icon-btn" id="toBtn" title="Call a time out">⏱</button>
              <button class="icon-btn" id="ctrlBtn" title="Commissioner controls" hidden>⚙</button>
            </div>
            <div><div class="clock" id="clock">00:00</div><div class="clock-sub" id="clockSub">time on the clock</div></div>
          </div>
          <div class="sb-cell">
            <div class="rp"><div class="n" id="rnd">–</div><div class="l">Round</div></div>
            <div class="rp"><div class="n" id="pk">–</div><div class="l">Pick</div></div>
          </div>
          <div class="sb-cell onclock" id="onclock"></div>
          <button class="icon-btn phone-only more-btn" id="moreBtn" aria-label="More actions">⋯</button>
        </div>
        <div class="phone-line phone-only" id="phoneLine"></div>
        <div class="toolbar">
          <input type="text" class="search" id="fQ" placeholder="🔍  Search team, date, note…">
          <button class="btn sm phone-only" id="filterBtn">Filters <span class="badge" id="filterCount" hidden></span></button>
          <div class="filter-group" id="filterGroup">
          <select id="fTeam"><option value="">All opponents</option>${[...new Set(s.games.map(g => g.opponent))].map(team).sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name)).map(t => `<option value="${t.abbr}">${esc(t.city)} ${esc(t.name)}</option>`).join('')}</select>
          <select id="fType" hidden><option value="">All game types</option><option value="preseason">Preseason</option><option value="regular">Regular season</option><option value="playoff">Playoffs</option></select>
          <div class="dow-chips" id="fDow">${DOW.map((d, i) => `<button data-dow="${i}" title="${d}">${d}</button>`).join('')}</div>
          <div class="dow-chips show-chips" id="fShow" title="Show games that match any selected option">
            <span class="k">Show</span><button data-show="avail">Available</button><button data-show="mine">My games</button><button data-show="others">Taken by others</button></div>
          <div class="row phone-only" style="width:100%;justify-content:space-between"><button class="btn sm" id="fClear2">Clear all</button><button class="btn primary sm" id="filterDone">Done</button></div>
          <button class="btn sm desktop-only" id="fClear">Clear</button>
          </div>
          <span class="spacer"></span>
          <button class="btn sm" id="addGameBtn" hidden>Games…</button>
          <button class="btn go" id="draftBtn" disabled>Draft game</button>
        </div>
        <div class="suggest" id="suggest" hidden></div>
        <div class="banner"><span id="banner"></span>
          <div class="presence" id="presence"></div>
</div>
        </div>
        <div class="board" id="board"></div>
        <div class="ticker"><div class="tag">🍁 PICKS</div><div class="track"><div class="scroll" id="ticker"></div></div></div>
      </div>`;
    const $ = sel => $app.querySelector(sel);

    // filters
    $('#fTeam').value = f.team; $('#fType').value = f.type; $('#fQ').value = f.q;
    const syncDow = () => {
      $('#fDow').querySelectorAll('button').forEach(b => b.classList.toggle('on', f.dows.includes(+b.dataset.dow)));
      $('#fShow').querySelectorAll('button').forEach(b => b.classList.toggle('on', f.show.includes(b.dataset.show)));
    };
    syncDow();
    $('#fShow').onclick = e => {
      const b = e.target.closest('[data-show]'); if (!b) return;
      const v = b.dataset.show;
      f.show = f.show.includes(v) ? f.show.filter(x => x !== v) : [...f.show, v];
      saveFilters(); syncDow(); renderBoard();
    };
    $('#fTeam').onchange = () => { f.team = $('#fTeam').value; saveFilters(); renderBoard(); };
    $('#fType').onchange = () => { f.type = $('#fType').value; saveFilters(); renderBoard(); };
    $('#fQ').oninput = () => { f.q = $('#fQ').value; saveFilters(); renderBoard(); };
    $('#fDow').onclick = e => {
      const b = e.target.closest('[data-dow]'); if (!b) return;
      const d = +b.dataset.dow;
      f.dows = f.dows.includes(d) ? f.dows.filter(x => x !== d) : [...f.dows, d];
      saveFilters(); syncDow(); renderBoard();
    };
    $('#filterBtn').onclick = () => $('.toolbar').classList.toggle('filters-open');
    $('#filterDone').onclick = () => $('.toolbar').classList.remove('filters-open');
    $('#fClear2').onclick = () => $('#fClear').click();
    $('#moreBtn').onclick = () => {
      const d = s.draft;
      const canPause = d.status === 'live' && (state.me.is_admin || s.on_clock?.user_id === state.me.id);
      modal(`<h2>Draft actions</h2><div class="ctrl-list">
        ${d.timeout && (d.timeout.by === state.me.id || state.me.is_admin) ? `<button class="btn go" data-to="end">▶ ${d.timeout.by === state.me.id ? 'Time in' : 'End time out'}</button>` : ''}
        ${d.status === 'live' && !d.timeout && (inDraft() || state.me.is_admin) ? '<button class="btn" data-to="start">⏱ Call a time out</button>' : ''}
        ${canPause && !d.timeout ? `<button class="btn" data-m="pauseBtn">${d.paused_at ? '▶ Resume clock' : '❚❚ Pause clock'}</button>` : ''}
        ${d.status === 'live' ? '<button class="btn" data-m="nudgeBtn">✉ Email a reminder to whoever is on the clock</button>' : ''}
        ${state.me.is_admin && d.source !== 'import' ? '<button class="btn" data-m="ctrlBtn">⚙ Commissioner controls</button>' : ''}
        ${state.me.is_admin && d.status !== 'complete' ? '<button class="btn" data-m="addGameBtn">📅 Games…</button>' : ''}
        <a class="btn" href="#/history/${d.id}">📊 Results so far</a>
        </div><div class="row" style="margin-top:12px"><button class="btn" data-close>Close</button></div>`, ($m, close) => {
        $m.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => { close(); $('#' + b.dataset.m).click(); }));
        $m.querySelectorAll('[data-to]').forEach(b => (b.onclick = () => { close(); b.dataset.to === 'start' ? $('#toBtn').click() : timeout('end'); }));
      });
    };
    $('#fClear').onclick = () => {
      Object.assign(f, { team: '', dows: [], type: '', show: [], q: '' }); saveFilters();
      $('#fTeam').value = ''; $('#fType').value = ''; $('#fQ').value = ''; syncDow(); renderBoard();
    };

    const myTurn = () => s.draft.status === 'live' && !s.draft.timeout && s.on_clock && (s.on_clock.user_id === state.me.id || state.me.is_admin);
    const inDraft = () => s.order.some(o => o.user_id === state.me.id);
    const toLeft = () => (s.draft.timeout ? Math.max(0, s.draft.timeout.ends_at - (Date.now() + skew)) / 1000 : 0);

    function renderHeader() {
      const d = s.draft;
      clockBase = d.elapsed_ms; clockT0 = performance.now();
      const users = usersOf(s);
      $('#pauseBtn').disabled = d.status !== 'live' || !(state.me.is_admin || s.on_clock?.user_id === state.me.id);
      $('#ctrlBtn').hidden = !state.me.is_admin || d.source === 'import';
      skew = s.server_time - Date.now();
      $('#toBtn').disabled = d.status !== 'live' || !!d.timeout || !(inDraft() || state.me.is_admin);
      if (d.timeout) selected = null;
      renderTimeout();
      $('#pauseBtn').textContent = d.paused_at ? '▶' : '❚❚';
      $('#undoBtn').disabled = !state.me.is_admin || !s.picks.length || d.status === 'setup' || d.source === 'import';
      $('#nudgeBtn').disabled = d.status !== 'live';
      $('#addGameBtn').hidden = !(state.me.is_admin && d.status !== 'complete');
      $('#fType').hidden = new Set(s.games.map(g => g.type)).size < 2;
      $('#fDow').hidden = !s.games.some(g => g.date);
      renderPresence();
      $('#rnd').textContent = s.on_clock ? s.on_clock.round : d.status === 'complete' ? '✓' : '–';
      $('#pk').textContent = s.on_clock ? s.on_clock.pick_in_round : '–';
      $('#banner').innerHTML = `${esc(d.name)} <span class="muted">· ${s.picks.length}/${d.total_picks} picks${anySingle(s) ? (s.games.every(g => g.single) ? ' (single seats)' : ' (Final by single seat)') : ''}${d.mode === 'async' ? ' · drafting by email' : ''}${d.status === 'setup' ? ' · not started' : ''}${d.status === 'complete' ? ' · complete' : ''}</span>`;

      let html = '';
      const mine = s.on_clock?.user_id === state.me.id;
      document.title = mine ? `🍁 YOUR PICK — ${BASE_TITLE}` : BASE_TITLE;
      if (s.on_clock) {
        const u = users[s.on_clock.user_id];
        html = `<div style="min-width:0;flex:1">
          <div class="who">${avatar(u, 'lg')}<div style="min-width:0">
            ${mine ? '<div class="yours">YOU’RE ON THE CLOCK</div>' : '<div class="yours" style="color:var(--muted)">ON THE CLOCK</div>'}
            <div class="name">${esc(u.display_name)}</div></div></div>
          <div class="nextup"><b>Next up:</b>${s.upcoming.slice(0, 4).map(p => `<span>${esc(users[p.user_id].display_name)}</span>`).join('') || '<span>—</span>'}</div>
        </div>`;
      } else if (d.status === 'setup') {
        html = `<div><div class="name" style="font-family:var(--cond);font-size:2rem;font-weight:800">DRAFT NOT STARTED</div>
          <div class="nextup"><b>Order:</b>${s.order.map(o => `<span>${o.position}. ${esc(o.display_name)}</span>`).join('')}</div>
          ${state.me.is_admin ? '<div class="row" style="margin-top:8px"><button class="btn go" id="startBtn">Start draft</button><button class="btn" id="editOrderBtn">Edit partners &amp; order</button></div>' : ''}</div>`;
      } else {
        html = `<div><div class="name" style="font-family:var(--cond);font-size:2.4rem;font-weight:800">DRAFT COMPLETE 🏒</div>
          <div class="row" style="margin-top:6px"><a class="btn primary" href="#/history/${d.id}">View results</a><a class="btn" href="#/trades">Trades</a></div></div>`;
      }
      $('#onclock').innerHTML = html;
      $('#editOrderBtn')?.addEventListener('click', editOrder);
      $('#startBtn')?.addEventListener('click', async () => {
        try { s = await api('POST', `/api/drafts/${id}/start`); renderAll(); } catch (e) { toast(e.message, true); }
      });
      tickClock();
    }

    function renderTimeout() {
      const el = $('#toBanner'); if (!el) return;
      const t = s.draft.timeout;
      document.body.classList.toggle('in-timeout', !!t);
      if (!t) { el.hidden = true; return; }
      const mine = t.by === state.me.id;
      el.hidden = false;
      el.innerHTML = `<span class="ti">⏸ TIME OUT</span>
        <span class="tb">${mine ? 'You called a time out' : `${esc(t.by_name)} called a time out`} · <b id="toLeft">${fmtDur(toLeft())}</b> left
          <span class="tn"> · picks are paused — you can still browse and filter</span></span>
        <span class="spacer"></span>
        ${mine ? '<button class="btn go sm" id="toEnd">▶ Time in</button>' : state.me.is_admin ? '<button class="btn sm" id="toEnd">End time out</button>' : ''}`;
      $('#toEnd')?.addEventListener('click', () => timeout('end'));
    }
    async function timeout(action) {
      try { s = await api('POST', `/api/drafts/${id}/timeout`, { action }); renderAll(); }
      catch (e) { toast(e.message, true); }
    }

    function tickClock() {
      const d = s.draft;
      if (d.timeout) {
        const left = toLeft(); const el = $('#toLeft'); if (el) el.textContent = fmtDur(left);
        if (left <= 0 && !toRefreshing) { toRefreshing = true; setTimeout(() => refresh().finally(() => (toRefreshing = false)), 400); }
      }
      const running = d.status === 'live' && !d.paused_at;
      const ms = clockBase + (running ? performance.now() - clockT0 : 0);
      const el = $('#clock'); if (!el) return;
      el.textContent = d.status === 'live' ? fmtDur(ms / 1000) : '00:00';
      const warn = d.status === 'live' && d.warn_secs > 0 && ms / 1000 >= d.warn_secs;
      el.classList.toggle('paused', !!d.paused_at);
      el.classList.toggle('warn', warn && !d.paused_at);
      if (warn && s.on_clock && warnedFor !== s.on_clock.overall) {
        warnedFor = s.on_clock.overall;
        if (s.on_clock.user_id === state.me.id) { beep(); toast(`⏰ ${fmtDur(d.warn_secs)} on the clock — time to pick! (no limit)`); }
      }
      const times = s.picks.map(p => p.seconds_taken).filter(x => x != null);
      $('#clockSub').textContent = d.timeout ? 'time out' : d.paused_at ? 'clock paused' : warn ? `over ${fmtDur(d.warn_secs)} — no limit, just a nudge` :
        times.length ? `avg pick ${fmtDur(times.reduce((a, b) => a + b, 0) / times.length)}` : 'time on the clock';
    }

    function gameMatches(g, gp) {
      const d = gDate(g);
      if (f.team && g.opponent !== f.team) return false;
      if (f.type && g.type !== f.type) return false;
      if (f.dows.length && (!d || !f.dows.includes(d.getDay()))) return false;
      if (f.show.length) {
        // A game shows if it matches ANY selected option (a half-taken single-seat game can be both available and taken).
        const avail = gp.length < (g.single ? g.seats : 1);
        const mine = gp.some(p => p.owner_id === state.me.id);
        const others = gp.some(p => p.owner_id !== state.me.id);
        if (!((f.show.includes('avail') && avail) || (f.show.includes('mine') && mine) || (f.show.includes('others') && others))) return false;
      }
      if (f.q) {
        const t = team(g.opponent);
        const hay = `${t.abbr} ${t.city} ${t.name} ${fmtGameDate(g)} ${d ? MONTHS_LONG[d.getMonth()] : ''} ${g.round ? `round ${g.round} game ${g.game_no}` : ''} ${g.notes} ${TYPE_LABEL[g.type]}`.toLowerCase();
        if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    }

    function ownerLine(p, users) {
      const u = users[p.owner_id], drafter = users[p.user_id];
      const traded = p.owner_id !== p.user_id;
      return `<div class="by" style="--who:${esc(u.color)}"><span class="dot"></span>${esc(u.display_name)}${traded ? ` <span class="slot" title="Drafted by ${esc(drafter.display_name)}">⇄</span>` : ''}${p.seat ? `<span class="slot">S${p.seat}</span>` : ''}<span class="slot">${p.round}.${p.pick_in_round}</span></div>`;
    }

    function updateFilterCount() {
      const n = (f.team ? 1 : 0) + (f.type ? 1 : 0) + f.dows.length + f.show.length;
      $('#filterCount').textContent = n; $('#filterCount').hidden = !n;
    }

    function renderBoard() {
      updateFilterCount();
      const picksByGame = {};
      s.picks.forEach(p => (picksByGame[p.game_id] ||= []).push(p));
      const users = usersOf(s);
      const months = new Map();
      s.games.forEach(g => {
        let k, col;
        if (g.round) { k = `r${g.round}`; col = { label: `Round ${g.round}`, year: g.single ? 'single seats' : 'pairs', games: [] }; }
        else { const d = gDate(g); k = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`; col = { label: MONTHS_LONG[d.getMonth()], year: d.getFullYear(), games: [] }; }
        if (!months.has(k)) months.set(k, col);
        months.get(k).games.push(g);
      });
      const full = g => (picksByGame[g.id] || []).length >= (g.single ? g.seats : 1);
      if (selected && full(s.games.find(g => g.id === selected))) selected = null;
      $('#board').innerHTML = [...months.values()].map(m => {
        const cards = m.games.filter(g => gameMatches(g, picksByGame[g.id] || [])).map(g => {
          const t = team(g.opponent); const gp = picksByGame[g.id] || [];
          const badge = g.type === 'preseason' ? '<span class="tbadge">PRE</span>' : g.type === 'playoff' ? '<span class="tbadge">PO</span>' : '';
          if (full(g)) {
            const mine = gp.some(p => p.owner_id === state.me.id);
            return `<div class="card taken ${mine ? 'mine' : ''}" style="--who:${esc(users[gp[0].owner_id].color)}">
              <div class="top"><span>${badge}${fmtGameDate(g)}</span><span>${t.abbr}</span></div>
              <div class="opp">${logo(g.opponent, 'dark', 'sm muted-logo')}<span>${esc(t.name)}</span></div>
              ${gp.map(p => ownerLine(p, users)).join('')}
            </div>`;
          }
          const single = !!g.single;
          const left = single ? g.seats - gp.length : 0;
          if (s.draft.status === 'complete' && !gp.length) {
            return `<div class="card taken" style="--who:#555" title="${esc(g.notes)}">
              <div class="top"><span>${badge}${fmtGameDate(g)}</span><span>${t.abbr}</span></div>
              <div class="opp">${logo(g.opponent, 'dark', 'sm muted-logo')}<span>${esc(t.name)}</span></div><div class="by"><span class="slot" style="margin-left:0">${esc(g.notes || 'not drafted')}</span></div></div>`;
          }
          return `<button class="card tc ${t.color ? '' : 'TBD'} ${selected === g.id ? 'selected' : ''}" ${teamStyle(t)} data-game="${g.id}">
            <div class="top">${g.round ? `<span>${badge}Game ${g.game_no}</span><span>${g.date ? `${fmtDay(g)}${g.time ? ` · ${fmtTime(g.time)}` : ''}` : 'Date TBD'}</span>`
              : `<span>${badge}${fmtGameDate(g)}</span><span>${fmtTime(g.time)}</span>`}</div>
            <div class="city"><span>${esc(t.city)}${single ? ' <span class="tbadge" style="background:#4b2a8a">1 SEAT</span>' : ''}</span><span title="Price for the pair">${fmtMoney(g.price)}</span></div>
            <div class="opp">${logo(g.opponent, 'light', 'chip')}<span>${esc(t.name)}</span></div>
            ${g.notes ? `<div class="note">★ ${esc(g.notes)}</div>` : ''}
            ${single && gp.length ? `<div class="seats">${left} seat${left === 1 ? '' : 's'} left</div>${gp.map(p => ownerLine(p, users)).join('')}` : ''}
            ${tip?.enabled && tip.top[0]?.game_id === g.id ? '<span class="tip" title="Your suggested pick">💡</span>' : ''}
          </button>`;
        }).join('');
        return `<section class="month"><div class="month-head">${m.label} <span>${m.year}</span></div>${cards || '<div class="empty-month">No games match</div>'}</section>`;
      }).join('') || '<p class="muted" style="padding:16px">No games in this draft yet.</p>';
      $('#draftBtn').disabled = !(selected && myTurn());
      const selG = s.games.find(g => g.id === selected);
      const label = myTurn() && s.on_clock.user_id !== state.me.id ? `Draft for ${users[s.on_clock.user_id].display_name}` : selG?.single ? 'Draft seat' : 'Draft game';
      // On phones the button floats at the bottom, so it names the game you tapped.
      $('#draftBtn').innerHTML = `${esc(label)}${selG ? `<span class="phone-only"> · ${esc(fmtGameDate(selG))} ${esc(team(selG.opponent).name)}</span>` : ''}`;
    }

    function renderTicker() {
      const users = usersOf(s);
      const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
      const recent = s.picks.slice(-15).reverse();
      const el = $('#ticker');
      if (!recent.length) { el.className = 'scroll still'; el.innerHTML = '<span>No picks yet — good luck, partners.</span>'; return; }
      el.className = 'scroll';
      el.innerHTML = recent.map(p => { const g = gameMap[p.game_id]; const t = team(g.opponent);
        return `<span><b>${p.round}.${p.pick_in_round}</b>${esc(users[p.user_id].display_name)} / ${fmtGameDate(g)} vs ${logo(g.opponent, 'light', 'xs')}${esc(t.name)}${seatLabel(p)}<span class="t">(${fmtDur(p.seconds_taken)})</span></span>`; }).join('');
    }

    function renderAll() { renderHeader(); renderBoard(); renderTicker(); setStick(); loadSuggestion(); }

    // --- suggested next pick: computed by the server for me only, from my private preferences
    async function loadSuggestion() {
      try { tip = await api('GET', `/api/drafts/${id}/suggestion`); } catch { tip = null; }
      if (seq !== routeSeq) return;  // left the board meanwhile
      renderSuggestion(); renderBoard(); setStick();
    }
    function renderSuggestion() {
      const el = $('#suggest'); if (!el) return;
      if (!tip?.enabled || !tip.top.length) { el.hidden = true; return; }
      const gm = gid => s.games.find(g => g.id === gid);
      const best = tip.top[0], g = gm(best.game_id); if (!g) { el.hidden = true; return; }
      const t = team(g.opponent);
      const good = best.reasons.filter(r => r.good).slice(0, 2).map(r => esc(r.text)).join(' · ');
      el.hidden = false;
      el.innerHTML = `<span class="k">💡<span class="lbl"> ${s.on_clock?.user_id === state.me.id ? 'Your pick — suggested' : 'Your next pick — suggested'}</span></span>
        <span class="g">${logo(g.opponent, 'dark', 'sm')}${esc(fmtGameDate(g))} · ${esc(t.name)}${g.price ? ` <span class="muted" style="font-weight:600">${fmtMoney(g.price)}</span>` : ''}</span>
        ${good ? `<span class="why">${good}</span>` : ''}
        ${tip.top.length > 1 ? `<span class="alts">Also: ${tip.top.slice(1).map(a => { const ag = gm(a.game_id); return ag ? `<button data-alt="${ag.id}">${esc(fmtGameDate(ag))} ${esc(team(ag.opponent).name)}</button>` : ''; }).join(', ')}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn sm" id="tipWhy">Why?</button><button class="btn sm go" id="tipSel">Select</button>`;
      const select = gid => { selected = gid; renderBoard(); $app.querySelector(`[data-game="${gid}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      $('#tipSel').onclick = () => select(best.game_id);
      el.querySelectorAll('[data-alt]').forEach(b => (b.onclick = () => select(+b.dataset.alt)));
      $('#tipWhy').onclick = () => modal(`<h2>💡 Your suggested picks</h2>
        <p class="muted small">Based on the preferences in your profile — only you can see this.${tip.picks_remaining ? ` You have ${tip.picks_remaining} pick${tip.picks_remaining === 1 ? '' : 's'} left.` : ''}</p>
        ${tip.top.map((a, i) => { const ag = gm(a.game_id); if (!ag) return ''; return `<div class="tip-item"><div class="row spread"><b class="with-logo">${logo(ag.opponent, 'dark', 'xs')}${i + 1}. ${esc(fmtGameDate(ag))} · ${esc(team(ag.opponent).city)} ${esc(team(ag.opponent).name)}</b>
          <button class="btn sm" data-pick="${ag.id}">Select</button></div>
          <ul>${a.reasons.map(r => `<li class="${r.good ? 'good' : 'bad'}">${r.good ? '✓' : '✗'} ${esc(r.text)}</li>`).join('') || '<li class="muted">Nothing stands out either way — earliest good fit.</li>'}</ul></div>`; }).join('')}
        <div class="row"><a class="btn" href="#/profile">Edit preferences</a><button class="btn" data-close>Close</button></div>`, ($m, close) => {
        $m.querySelectorAll('[data-pick]').forEach(b => (b.onclick = () => { close(); select(+b.dataset.pick); }));
      });
    }
    // Month/round headings stick just below the board's sticky header on phones.
    function setStick() { const h = $('#boardTop')?.offsetHeight || 0; document.documentElement.style.setProperty('--board-top', `${h}px`); }
    window.addEventListener('resize', setStick);
    renderAll();

    // interactions
    $('#board').onclick = e => {
      const c = e.target.closest('[data-game]'); if (!c) return;
      if (s.draft.timeout) { toast(`⏸ Time out — picks are paused (${fmtDur(toLeft())} left)`); return; }
      const gid = +c.dataset.game;
      selected = selected === gid ? null : gid;
      renderBoard();
    };
    $('#board').ondblclick = e => { const c = e.target.closest('[data-game]'); if (c && !s.draft.timeout) { selected = +c.dataset.game; renderBoard(); confirmPick(); } };
    $('#draftBtn').onclick = confirmPick;
    $('#toBtn').onclick = () => {
      if (!confirm(`Call a time out? The clock stops and nobody can pick for up to ${fmtDur(s.draft.timeout_secs)}.`)) return;
      timeout('start');
    };

    function confirmPick() {
      if (!selected || !myTurn()) return;
      const g = s.games.find(x => x.id === selected); const t = team(g.opponent);
      const forUser = usersOf(s)[s.on_clock.user_id];
      const behalf = s.on_clock.user_id !== state.me.id;
      const taken = s.picks.filter(p => p.game_id === g.id);
      modal(`
        <div class="muted small">ROUND ${s.on_clock.round} · PICK ${s.on_clock.pick_in_round} · ${behalf ? `ON BEHALF OF ${esc(forUser.display_name.toUpperCase())}` : 'YOUR PICK'}</div>
        <div class="big row" style="gap:12px">${logo(g.opponent, 'dark', 'lg')}<span>${esc(t.city)} ${esc(t.name)}</span></div>
        <p>${g.round ? `Round ${g.round}, Game ${g.game_no}${g.date ? ` · ${fmtDay(g)}` : ' · date TBD'}` : fmtGameDate(g)}${g.time ? ` · ${fmtTime(g.time)}` : ''}${g.price ? ` · ${fmtMoney(g.price)} for the pair${g.single ? ` (${fmtMoney(g.price / g.seats)}/seat)` : ''}` : ''}${g.notes ? ` · ${esc(g.notes)}` : ''}</p>
        ${g.single ? `<p class="muted">One seat (seat ${taken.length + 1} of ${g.seats})${taken.length ? ` — the other is held by ${esc(usersOf(s)[taken[0].owner_id].display_name)}` : ''}.</p>` : ''}
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
    async function control(action, confirmText) {
      if (confirmText && !confirm(confirmText)) return;
      try { s = await api('POST', `/api/drafts/${id}/control`, { action }); warnedFor = null; renderAll(); toast('Done'); }
      catch (e) { toast(e.message, true); }
    }
    $('#ctrlBtn').onclick = () => {
      const d = s.draft, live = d.status === 'live';
      modal(`
        <h2>Commissioner controls</h2>
        <p class="muted small">${esc(d.name)} · ${d.status}${d.paused_at ? ' (paused)' : ''} · ${s.picks.length}/${d.total_picks} picks</p>
        <div class="ctrl-list">
          ${d.timeout ? `<button class="btn go" data-c="endto">▶ End time out <span class="muted">(called by ${esc(d.timeout.by_name)})</span></button>` : ''}
          <button class="btn" data-c="pause" ${live && !d.timeout ? '' : 'disabled'}>${d.paused_at && !d.timeout ? '▶ Resume clock' : '❚❚ Pause clock'}</button>
          <button class="btn" data-c="reset_clock" ${live ? '' : 'disabled'}>⟲ Restart this pick’s clock <span class="muted">(back to 0:00)</span></button>
          <button class="btn" data-c="undo" ${s.picks.length && d.status !== 'setup' ? '' : 'disabled'}>↶ Undo last pick</button>
          <button class="btn danger" data-c="restart" ${d.status !== 'setup' ? '' : 'disabled'}>⏮ Restart draft <span class="muted">(clear all picks, start again at pick 1)</span></button>
          <button class="btn danger" data-c="reset" ${d.status !== 'setup' ? '' : 'disabled'}>⟳ Reset to setup <span class="muted">(clear picks, edit partners &amp; order)</span></button>
          <button class="btn" data-c="order" ${d.status === 'setup' ? '' : 'disabled'}>👥 Edit partners &amp; order</button>
        </div>
        <h3 style="margin-top:14px">Settings</h3>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1"><label>Time-out length (minutes)</label><input type="number" id="setTO" min="0.5" max="30" step="0.5" value="${d.timeout_secs / 60}"></div>
          <div class="field" style="flex:1"><label>Clock warning (minutes, 0 = none)</label><input type="number" id="setWarn" min="0" step="0.5" value="${d.warn_secs / 60}"></div>
          <div class="field"><button class="btn" id="setSave">Save</button></div>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn" data-close>Close</button></div>`, ($m, close) => {
        $m.querySelector('#setSave').onclick = async () => {
          try {
            s = await api('PUT', `/api/drafts/${id}/settings`, { timeout_secs: Math.round(Number($m.querySelector('#setTO').value) * 60), warn_secs: Math.round(Number($m.querySelector('#setWarn').value) * 60) });
            renderAll(); toast(`Saved — time outs last up to ${fmtDur(s.draft.timeout_secs)}`);
          } catch (e) { toast(e.message, true); }
        };
        $m.querySelectorAll('[data-c]').forEach(b => (b.onclick = async () => {
          const c = b.dataset.c; close();
          const traded = d.status === 'complete' ? ' Any trades made from this draft are deleted too.' : '';
          if (c === 'endto') timeout('end');
          else if (c === 'pause') $('#pauseBtn').click();
          else if (c === 'undo') $('#undoBtn').click();
          else if (c === 'order') editOrder();
          else if (c === 'reset_clock') control(c);
          else if (c === 'restart') control(c, `Restart the draft? All ${s.picks.length} picks are cleared and the clock starts again at pick 1.${traded}`);
          else if (c === 'reset') control(c, `Reset the draft to setup? All ${s.picks.length} picks are cleared and the draft stops until you start it again.${traded}`);
        }));
      });
    };
    async function editOrder() {
      const all = (await api('GET', '/api/users')).filter(u => u.active);
      let order = s.order.map(o => o.user_id).filter(id => all.some(u => u.id === id));
      const playoff = s.draft.kind === 'playoff';
      const prior = playoff ? await api('GET', `/api/drafts/playoff-prior?season=${encodeURIComponent(s.draft.season)}&before=${id}`) : null;
      modal(`<h2>Partners &amp; order</h2>
        <div class="check-list" id="eoWho"></div>
        ${playoff ? (prior ? `<div class="po-choice"><label><input type="radio" name="eoMode" value="reuse" checked> Use the order from “${esc(prior.name)}”: <b>${prior.order.map(o => `${o.position}. ${esc(o.display_name)}`).join('  ')}</b></label></div>
            <div class="po-choice"><label><input type="radio" name="eoMode" value="random"> 🎲 Draw a new random order</label></div>`
          : '<p class="muted small">🎲 The playoff order is re-drawn at random when you save.</p>') : '<ol class="order-list" id="eoOrder"></ol>'}
        <div class="row" style="margin-top:10px"><button class="btn primary" id="eoSave">Save</button><button class="btn" data-close>Cancel</button></div>`, ($m, close) => {
        const byId = Object.fromEntries(all.map(u => [u.id, u]));
        const render = () => {
          $m.querySelector('#eoWho').innerHTML = all.map(u => `<label><input type="checkbox" value="${u.id}" ${order.includes(u.id) ? 'checked' : ''}> ${avatar(u)} ${esc(u.display_name)}</label>`).join('');
          $m.querySelectorAll('#eoWho input').forEach(cb => (cb.onchange = () => { const v = +cb.value; order = cb.checked ? [...order, v] : order.filter(x => x !== v); render(); }));
          const ol = $m.querySelector('#eoOrder'); if (!ol) return;
          ol.innerHTML = order.map((uid, i) => `<li><span class="pos">${i + 1}</span>${avatar(byId[uid])}<span class="name">${esc(byId[uid].display_name)}</span>
            <button class="icon-btn" data-up="${i}" ${i ? '' : 'disabled'}>▲</button><button class="icon-btn" data-down="${i}" ${i < order.length - 1 ? '' : 'disabled'}>▼</button></li>`).join('');
          ol.querySelectorAll('[data-up]').forEach(b => (b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; render(); }));
          ol.querySelectorAll('[data-down]').forEach(b => (b.onclick = () => { const i = +b.dataset.down; [order[i + 1], order[i]] = [order[i], order[i + 1]]; render(); }));
        };
        render();
        $m.querySelector('#eoSave').onclick = async () => {
          const mode = $m.querySelector('[name=eoMode]:checked')?.value || 'random';
          try { s = await api('PUT', `/api/drafts/${id}/order`, { user_ids: order, playoff_order: mode }); close(); renderAll(); toast('Partners & order saved'); }
          catch (e) { toast(e.message, true); }
        };
      });
    }
    $('#nudgeBtn').onclick = async () => {
      try { const r = await api('POST', `/api/drafts/${id}/nudge`); toast(r.mail_enabled ? 'Reminder email sent' : 'Email isn’t configured on the server yet — reminder logged only'); }
      catch (e) { toast(e.message, true); }
    };
    $('#addGameBtn').onclick = () => {
      const playoff = s.draft.kind === 'playoff';
      const taken = new Set(s.picks.map(p => p.game_id));
      modal(`<h2>Games</h2>
        <p class="muted small">Fill in dates, times, opponents and prices as they become known. Unpicked games can be removed before the draft starts.</p>
        <div class="table-wrap" style="max-height:50vh"><table class="games-table">
          <thead><tr><th>${playoff ? 'Game' : 'Date'}</th>${playoff ? '<th>Date</th>' : ''}<th>Time</th><th>Opponent</th><th>Price (pair)</th><th>Notes</th><th></th></tr></thead>
          <tbody>${s.games.slice().sort(gameSort).map(g => `<tr data-g="${g.id}">
            ${playoff ? `<td><b>R${g.round} G${g.game_no}</b>${g.single ? ' <span class="muted small">1 seat</span>' : ''}</td>` : ''}
            <td><input type="date" name="date" value="${esc(g.date)}"></td><td><input type="time" name="time" value="${esc(g.time)}"></td>
            <td><select name="opponent">${teamOptions(g.opponent)}</select></td><td><input type="number" name="price" min="0" value="${g.price ?? ''}"></td>
            <td><input type="text" name="notes" value="${esc(g.notes)}"></td>
            <td style="white-space:nowrap"><button class="btn sm" data-save="${g.id}">Save</button>${!taken.has(g.id) && s.draft.status === 'setup' ? ` <button class="icon-btn" data-del="${g.id}" title="Remove">✕</button>` : ''}</td></tr>`).join('')}</tbody>
        </table></div>
        ${s.draft.status !== 'complete' ? `<h3 style="margin-top:14px">Add a game</h3>
        <div class="row" style="align-items:flex-end">
          ${playoff ? `<div class="field"><label>Round</label><select id="nRound">${[1, 2, 3, 4].map(r => `<option>${r}</option>`).join('')}</select></div>
            <div class="field"><label>Game #</label><select id="nGame">${[1, 2, 3, 4, 5, 6, 7].map(n => `<option>${n}</option>`).join('')}</select></div>` : ''}
          <div class="field"><label>Date${playoff ? ' (optional)' : ''}</label><input type="date" id="nDate"></div>
          <div class="field"><label>Opponent</label><select id="nOpp">${teamOptions()}</select></div>
          <div class="field"><button class="btn" id="nAdd">Add</button></div></div>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn" data-close>Close</button></div>`, ($m, close) => {
        const val = (row, n) => row.querySelector(`[name=${n}]`).value;
        $m.querySelectorAll('[data-save]').forEach(b => (b.onclick = async () => {
          const row = b.closest('tr');
          try { s = await api('PUT', `/api/drafts/${id}/games/${b.dataset.save}`, { date: val(row, 'date'), time: val(row, 'time'), opponent: val(row, 'opponent'), price: val(row, 'price'), notes: val(row, 'notes') }); renderAll(); toast('Saved'); }
          catch (e) { toast(e.message, true); }
        }));
        $m.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => {
          try { s = await api('DELETE', `/api/drafts/${id}/games/${b.dataset.del}`); renderAll(); b.closest('tr').remove(); }
          catch (e) { toast(e.message, true); }
        }));
        $m.querySelector('#nAdd')?.addEventListener('click', async () => {
          const v = k => $m.querySelector(k)?.value;
          try {
            s = await api('POST', `/api/drafts/${id}/games`, { round: v('#nRound'), game_no: v('#nGame'), date: v('#nDate'), opponent: v('#nOpp'), type: playoff ? 'playoff' : 'regular' });
            renderAll(); close(); $('#addGameBtn').click();
          } catch (e) { toast(e.message, true); }
        });
      });
    };

    // who's in the draft room
    function renderPresence() {
      const el = $('#presence'); if (!el) return;
      const ids = s.order.map(o => o.user_id);
      const users = usersOf(s);
      const watchers = online.filter(uid => !ids.includes(uid));
      const line = $('#phoneLine');
      if (line) line.innerHTML = `${s.on_clock && s.upcoming.length ? `<span class="nx"><b>Next:</b> ${s.upcoming.slice(0, 3).map(p => esc(users[p.user_id].display_name)).join(' · ')}</span>` : `<span class="nx">${esc(s.draft.name)} · ${s.picks.length}/${s.draft.total_picks}</span>`}
        <span class="dots">${s.order.map(o => `<span class="who ${online.includes(o.user_id) ? 'on' : 'off'}" title="${esc(o.display_name)}${online.includes(o.user_id) ? ' is on the board' : ' is away'}">${avatar(users[o.user_id], 'xs')}</span>`).join('')}</span>`;
      el.innerHTML = `<span class="k">In the draft room</span>${s.order.map(o => {
        const on = online.includes(o.user_id);
        return `<span class="who ${on ? 'on' : 'off'}" title="${on ? 'Has the board open' : 'Not on the board right now'}">${avatar(users[o.user_id], 'xs')}${esc(o.display_name)}</span>`; }).join('')}${watchers.length ? `<span class="muted small">+${watchers.length} watching</span>` : ''}`;
    }

    // live updates
    async function refresh() {
      const prevCount = s.picks.length, prevTO = s.draft.timeout;
      try { s = await api('GET', `/api/drafts/${id}`); } catch { return; }
      renderAll();
      if (s.picks.length > prevCount && s.on_clock?.user_id === state.me.id) { toast('🍁 You’re on the clock!'); beep(); }
      if (!prevTO && s.draft.timeout && s.draft.timeout.by !== state.me.id) toast(`⏸ Time out called by ${s.draft.timeout.by_name}`);
      if (prevTO && !s.draft.timeout) toast('▶ Time in — the clock is running');
    }
    const stop = live(id, refresh, { presence: d => { online = d.online || []; renderPresence(); } });
    const timer = setInterval(tickClock, 250);
    const onKey = e => { if (e.key === 'Escape' && selected) { selected = null; renderBoard(); } };
    document.addEventListener('keydown', onKey);
    own(seq, () => { stop(); clearInterval(timer); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', setStick); });
  }

  // ------------------------------------------------------------ history
  async function viewHistoryIndex() {
    const seq = routeSeq;
    const [drafts, summary, users] = await Promise.all([api('GET', '/api/drafts'), api('GET', '/api/history/summary'), api('GET', '/api/users')]);
    if (seq !== routeSeq) return;
    const list = drafts.filter(d => d.status === 'complete' || d.pick_count > 0)
      .sort((a, b) => b.season.localeCompare(a.season) || b.id - a.id);
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const seasonRows = summary.filter(r => r.kind === 'season' && r.status === 'complete');
    const partnerIds = [...new Set(seasonRows.map(r => r.user_id))].sort((a, b) => (userMap[a]?.display_name || '').localeCompare(userMap[b]?.display_name || ''));
    const seasons = [...new Set(seasonRows.map(r => r.draft_id))];
    const cellOf = (draftId, uid) => seasonRows.find(r => r.draft_id === draftId && r.user_id === uid);
    const tot = uid => seasonRows.filter(r => r.user_id === uid).reduce((a, r) => ({ games: a.games + r.games, value: a.value + (r.value || 0), weekend: a.weekend + r.weekend, saturday: a.saturday + r.saturday }), { games: 0, value: 0, weekend: 0, saturday: 0 });
    $app.innerHTML = `
      <div class="page" style="max-width:1200px">
        <div class="row spread" style="margin-bottom:14px"><h1 style="margin:0">Draft history</h1>${state.me.is_admin ? '<a class="btn primary" href="#/import">Import past drafts</a>' : ''}</div>
        ${partnerIds.length ? `
        <div class="panel">
          <h2>All-time</h2>
          <div class="grid2" style="margin-bottom:14px">${partnerIds.map(uid => { const t = tot(uid); return `
            <div class="row" style="gap:12px">${avatar(userMap[uid], 'lg')}<div>
              <div style="font-family:var(--cond);font-size:1.4rem;font-weight:800">${esc(userMap[uid]?.display_name)}</div>
              <div class="stat-row" style="margin:2px 0 0">
                <div class="stat"><div class="v">${t.games}</div><div class="k">Games</div></div>
                <div class="stat"><div class="v">${t.saturday}</div><div class="k">Saturdays</div></div>
                <div class="stat"><div class="v">${t.weekend}</div><div class="k">Fri–Sun</div></div>
              </div></div></div>`; }).join('')}</div>
          <div class="table-wrap"><table class="season-table">
            <thead><tr><th>Season</th>${partnerIds.map(uid => `<th>${esc(userMap[uid]?.display_name)}</th>`).join('')}<th></th></tr></thead>
            <tbody>${seasons.map(id => { const d = drafts.find(x => x.id === id); return `<tr>
              <td><a href="#/history/${id}">${esc(d?.season || d?.name)}</a></td>
              ${partnerIds.map(uid => { const c = cellOf(id, uid); return `<td>${c ? `${c.games}${c.value ? ` <span class="muted">· ${fmtMoney(c.value)}</span>` : ''}` : '—'}</td>`; }).join('')}
              <td class="muted small">${d && !d.order_recorded ? 'order not recorded' : ''}</td></tr>`; }).join('')}</tbody>
          </table></div>
          <p class="muted small">Games held at the end of each season draft (after trades), with ticket value where prices were recorded.</p>
        </div>` : ''}
        <div class="panel">
          <h2>All drafts</h2>
          ${list.length ? list.map(d => `
            <div class="draft-item">
              <div><div class="title">${esc(d.name)} <span class="pill ${d.status}">${d.status}</span>${d.source === 'import' ? ' <span class="pill setup">imported</span>' : ''}</div>
              <div class="muted small">${esc(d.season)} · ${d.kind === 'playoff' ? 'playoffs' : 'season'} · ${d.pick_count} picks${d.completed_at ? ` · finished ${fmtWhen(d.completed_at)}` : ''}</div></div>
              <a class="btn primary" href="#/history/${d.id}">View results</a>
            </div>`).join('') : '<p class="muted">No drafts with picks yet.</p>'}
        </div>
      </div>`;
  }

  async function viewHistory(id) {
        const seq = routeSeq;
const [s, trades] = await Promise.all([api('GET', `/api/drafts/${id}`), api('GET', `/api/trades?draft_id=${id}`)]);
    if (seq !== routeSeq) return;
    const d = s.draft;
    const users = usersOf(s);
    const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
    const rounds = Math.max(0, ...s.picks.map(p => p.round));
    const pickAt = (r, uid) => s.picks.find(p => p.round === r && p.user_id === uid);
    const imported = d.source === 'import';
    const orderKnown = d.order_recorded !== 0;
    // The round grid only makes sense when each partner has at most one pick per round.
    const regular = orderKnown && new Set(s.picks.map(p => `${p.round}|${p.user_id}`)).size === s.picks.length;
    const undrafted = s.games.filter(g => !s.picks.some(p => p.game_id === g.id));
    const anyPrice = s.games.some(g => g.price);
    const accepted = trades.filter(t => t.status === 'accepted');
    const cell = p => {
      if (!p) return '<span class="muted">—</span>';
      const g = gameMap[p.game_id]; const t = team(g.opponent);
      return `<div class="rg-cell card tc ${t.color ? '' : 'TBD'}" ${teamStyle(t)}><div class="d">${fmtGameDate(g)}${seatLabel(p)}</div><div class="o">${logo(g.opponent, 'light', 'sm chip')}<span>${esc(t.name)}</span></div><div class="s">#${p.overall}${imported ? '' : ` · ${fmtDur(p.seconds_taken)}`}${g.price ? ` · ${fmtMoney(pickValue(p, g))}` : ''}</div></div>`;
    };
    const stats = uid => {
      const drafted = s.picks.filter(p => p.user_id === uid);
      const held = s.picks.filter(p => p.owner_id === uid);
      const secs = drafted.map(p => p.seconds_taken).filter(x => x != null);
      const weekend = held.filter(p => { const d = gDate(gameMap[p.game_id]); return d && [0, 5, 6].includes(d.getDay()); }).length;
      const total = secs.reduce((a, b) => a + b, 0);
      const value = held.reduce((a, p) => a + pickValue(p, gameMap[p.game_id]), 0);
      return { held, count: held.length, weekend, value, avg: secs.length ? total / secs.length : null, max: secs.length ? Math.max(...secs) : null };
    };
    const duration = d.completed_at && d.started_at ? (d.completed_at - d.started_at) / 1000 : null;

    $app.innerHTML = `
      <div class="page" style="max-width:1300px">
        <div class="row spread"><h1 style="margin:0">${esc(d.name)}</h1><a class="btn" href="#/board/${d.id}">Open board</a></div>
        <p class="muted">${esc(d.season)} · <span class="pill ${d.status}">${d.status}</span> · ${d.kind === 'playoff' ? 'playoffs, single seats' : 'season, pairs'} · ${d.order_type} order ·
          ${imported ? 'imported from spreadsheet' : d.started_at ? `started ${fmtWhen(d.started_at)}` : 'not started'}${duration ? ` · took ${fmtDur(duration)}` : ''}</p>

        ${d.notes ? `<div class="panel small" style="white-space:pre-line">${esc(d.notes)}</div>` : ''}
        <div class="panel">
          <h2>Draft order</h2>
          <div class="row">${s.order.map(o => `<div class="row" style="gap:8px"><b style="font-family:var(--cond);font-size:1.6rem;color:var(--clock)">${o.position}</b>${avatar(users[o.user_id])}<span>${esc(o.display_name)}</span></div>`).join('<span class="muted">→</span>')}</div>
        </div>

        <div class="grid2">
          ${s.order.map(o => { const st = stats(o.user_id); return `
            <div class="panel partner-col">
              <h3>${avatar(users[o.user_id])} ${esc(o.display_name)}</h3>
              <div class="stat-row">
                <div class="stat"><div class="v">${st.count}</div><div class="k">${anySingle(s) ? 'Picks' : 'Games'}</div></div>
                <div class="stat"><div class="v">${st.weekend}</div><div class="k">Fri–Sun</div></div>
                ${anyPrice ? `<div class="stat"><div class="v">${fmtMoney(st.value)}</div><div class="k">Value</div></div>` : ''}
                ${st.avg == null ? '' : `<div class="stat"><div class="v">${fmtDur(st.avg)}</div><div class="k">Avg pick</div></div>
                <div class="stat"><div class="v">${fmtDur(st.max)}</div><div class="k">Longest</div></div>`}
              </div>
              <ul class="mini-list">${st.held.slice().sort((a, b) => gameSort(gameMap[a.game_id], gameMap[b.game_id])).map(p => { const g = gameMap[p.game_id];
                return `<li><span class="with-logo">${logo(g.opponent, 'dark', 'xs')}${fmtGameDate(g)} · ${esc(team(g.opponent).name)}${seatLabel(p)}${p.owner_id !== p.user_id ? ` <span class="muted" title="Drafted by ${esc(users[p.user_id].display_name)}">⇄ via trade</span>` : ''}</span><span>${[orderKnown ? `#${p.overall}` : '', g.price ? fmtMoney(pickValue(p, g)) : ''].filter(Boolean).join(' · ')}</span></li>`; }).join('') || '<li class="muted">No picks</li>'}</ul>
            </div>`; }).join('')}
        </div>
        ${accepted.length ? `<p class="muted small">Holdings above include ${accepted.length} completed trade${accepted.length > 1 ? 's' : ''}; the round grid and log show the original draft.</p>` : ''}

        ${regular ? `<div class="panel">
          <h2>Results by round</h2>
          <div class="table-wrap"><table class="results-grid">
            <thead><tr><th class="rnd">Rd</th>${s.order.map(o => `<th>${esc(o.display_name)}</th>`).join('')}</tr></thead>
            <tbody>${Array.from({ length: rounds }, (_, i) => `<tr><td class="rnd">${i + 1}</td>${s.order.map(o => `<td>${cell(pickAt(i + 1, o.user_id))}</td>`).join('')}</tr>`).join('')
              || `<tr><td colspan="${s.order.length + 1}" class="muted">No picks yet</td></tr>`}</tbody>
          </table></div>
        </div>` : ''}

        <div class="panel">
          <h2>${orderKnown ? 'Pick log' : 'Games by date'}</h2>
          <div class="table-wrap"><table>
            <thead><tr>${orderKnown ? `<th>#</th>${regular ? '<th>Rd.Pick</th>' : ''}` : ''}<th>Partner</th><th>Game</th>${anyPrice ? '<th>Price</th>' : ''}${s.picks.some(p => p.seconds_taken != null) ? '<th>Time taken</th>' : ''}${imported ? '' : '<th>Picked at</th>'}</tr></thead>
            <tbody>${(orderKnown ? s.picks : s.picks.slice().sort((a, b) => gameSort(gameMap[a.game_id], gameMap[b.game_id]))).map(p => { const g = gameMap[p.game_id]; const t = team(g.opponent);
              return `<tr>${orderKnown ? `<td>${p.overall}</td>${regular ? `<td>${p.round}.${p.pick_in_round}</td>` : ''}` : ''}<td>${esc(users[p.user_id].display_name)}${p.made_by && p.made_by !== p.user_id ? ' <span class="muted small">(entered by commissioner)</span>' : ''}</td>
                <td class="with-logo">${logo(g.opponent, 'dark', 'xs')}${fmtGameDate(g)}${fmtYear(g)} · ${g.time ? `${fmtTime(g.time)} · ` : ''}${esc(t.city)} ${esc(t.name)}${seatLabel(p)}${g.notes ? ` <span class="muted small">${esc(g.notes)}</span>` : ''}${g.type !== 'regular' ? ` <span class="tbadge">${g.type === 'preseason' ? 'PRE' : 'PO'}</span>` : ''}</td>
                ${anyPrice ? `<td>${fmtMoney(pickValue(p, g))}</td>` : ''}${s.picks.some(x => x.seconds_taken != null) ? `<td>${fmtDur(p.seconds_taken)}</td>` : ''}${imported ? '' : `<td class="muted">${fmtWhen(p.picked_at)}</td>`}</tr>`; }).join('')}</tbody>
          </table></div>
        </div>
        ${undrafted.length && d.status === 'complete' ? `<div class="panel"><h2>Not drafted</h2><ul class="mini-list">${undrafted.map(g => `<li><span>${esc(gameName(g))}</span><span>${esc(g.notes)}</span></li>`).join('')}</ul></div>` : ''}
      </div>`;
  }

  // ------------------------------------------------------------ trades
  async function viewTrades() {
        const seq = routeSeq;
const [drafts, trades, users] = await Promise.all([api('GET', '/api/drafts'), api('GET', '/api/trades'), api('GET', '/api/users')]);
    if (seq !== routeSeq) return;
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const tradable = drafts.filter(d => d.status === 'complete');
    const draftName = Object.fromEntries(drafts.map(d => [d.id, d.name]));
    const today = torontoToday();
    const me = state.me.id;
    let draftId = Number(sessionStorage.getItem('tradeDraft')) || tradable[0]?.id;
    if (!tradable.some(d => d.id === draftId)) draftId = tradable[0]?.id;

    const itemList = items => items.map(i => `<li>${logo(i.opponent, 'dark', 'xs')}${esc(gameName(i))}${i.seat ? ` · seat ${i.seat}` : ''}${i.price ? ` <span class="muted">${fmtMoney(i.seat ? i.price / 2 : i.price)}</span>` : ''}</li>`).join('') || '<li class="muted">nothing</li>';
    const tradeCard = t => {
      const from = userMap[t.from_user], to = userMap[t.to_user];
      const incoming = t.to_user === me && t.status === 'pending';
      const outgoing = t.from_user === me && t.status === 'pending';
      return `<div class="trade">
        <div class="row spread"><div class="row" style="gap:8px">${avatar(from)} <b>${esc(from.display_name)}</b> <span class="muted">→</span> ${avatar(to)} <b>${esc(to.display_name)}</b></div>
          <span class="pill ${t.status === 'accepted' ? 'complete' : t.status === 'pending' ? 'live' : 'setup'}">${t.status}</span></div>
        <div class="muted small">${esc(draftName[t.draft_id])} · proposed ${fmtWhen(t.created_at)}${t.resolved_at ? ` · ${t.status} ${fmtWhen(t.resolved_at)}` : ''}</div>
        <div class="trade-sides">
          <div><div class="k">${esc(from.display_name)} gives</div><ul>${itemList(t.give)}</ul></div>
          <div><div class="k">${esc(to.display_name)} gives</div><ul>${itemList(t.get)}</ul></div>
        </div>
        ${t.message ? `<p class="small">“${esc(t.message)}”</p>` : ''}
        ${incoming ? `<div class="row"><button class="btn go sm" data-act="accept" data-id="${t.id}">Accept</button><button class="btn sm" data-act="decline" data-id="${t.id}">Decline</button></div>` : ''}
        ${outgoing ? `<button class="btn danger sm" data-act="cancel" data-id="${t.id}">Withdraw</button>` : ''}
      </div>`;
    };
    const pending = trades.filter(t => t.status === 'pending');
    const past = trades.filter(t => t.status !== 'pending');

    $app.innerHTML = `
      <div class="page">
        <h1>Trades</h1>
        <div class="panel">
          <h2>Propose a trade</h2>
          ${tradable.length ? `
          <div class="row" style="align-items:flex-end">
            <div class="field" style="flex:1;min-width:200px"><label>Draft</label><select id="tDraft">${tradable.map(d => `<option value="${d.id}" ${d.id === draftId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
            <div class="field" style="flex:1;min-width:160px"><label>Trade with</label><select id="tWith"></select></div>
          </div>
          <div class="grid2" id="tSides"></div>
          <div class="field"><label>Message (optional)</label><input type="text" id="tMsg" maxlength="500" placeholder="e.g. Swap my Tuesday for your Saturday?"></div>
          <div class="row"><button class="btn primary" id="tSend">Send request</button><span class="muted small" id="tSummary"></span></div>`
          : '<p class="muted">Trades open once a draft is complete.</p>'}
        </div>
        <div class="panel"><h2>Open requests</h2>${pending.map(tradeCard).join('') || '<p class="muted">None.</p>'}</div>
        <div class="panel"><h2>Trade history</h2>${past.map(tradeCard).join('') || '<p class="muted">No trades yet.</p>'}</div>
      </div>`;
    const $ = sel => $app.querySelector(sel);

    $app.querySelectorAll('[data-act]').forEach(b => (b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'accept' && !confirm('Accept this trade? The games change hands immediately.')) return;
      try { await api('POST', `/api/trades/${b.dataset.id}/${act}`); toast(`Trade ${act === 'cancel' ? 'withdrawn' : act + 'ed'}`); route(); }
      catch (e) { toast(e.message, true); }
    }));

    if (tradable.length) {
      let s;
      const loadDraft = async () => {
        sessionStorage.setItem('tradeDraft', draftId);
        s = await api('GET', `/api/drafts/${draftId}`);
        const partners = s.order.filter(o => o.user_id !== me);
        $('#tWith').innerHTML = partners.map(o => `<option value="${o.user_id}">${esc(o.display_name)}</option>`).join('');
        renderSides();
      };
      const renderSides = () => {
        const other = Number($('#tWith').value);
        const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
        const list = (owner, name) => {
          const ps = s.picks.filter(p => p.owner_id === owner && upcoming(gameMap[p.game_id], today))
            .sort((a, b) => gameSort(gameMap[a.game_id], gameMap[b.game_id]));
          return `<div><h3>${name}</h3><div class="check-list trade-pick">${ps.map(p => { const g = gameMap[p.game_id];
            return `<label><input type="checkbox" name="${owner === me ? 'give' : 'get'}" value="${p.id}"> ${logo(g.opponent, 'dark', 'xs')}${esc(gameName(g))}${seatLabel(p)} <span class="muted">${fmtMoney(pickValue(p, g))}</span></label>`; }).join('') || '<p class="muted">No upcoming games.</p>'}</div></div>`;
        };
        $('#tSides').innerHTML = list(me, 'You give') + list(other, `${esc(userMap[other]?.display_name)} gives`);
        $('#tSides').onchange = summarize; summarize();
      };
      const summarize = () => {
        const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
        const pickMap = Object.fromEntries(s.picks.map(p => [p.id, p]));
        const sum = name => [...$app.querySelectorAll(`input[name=${name}]:checked`)].reduce((a, c) => { const p = pickMap[c.value]; return a + pickValue(p, gameMap[p.game_id]); }, 0);
        const give = sum('give'), get = sum('get');
        $('#tSummary').textContent = give || get ? `Value: you give ${fmtMoney(give)}, you get ${fmtMoney(get)}` : '';
      };
      $('#tDraft').onchange = () => { draftId = Number($('#tDraft').value); loadDraft(); };
      $('#tWith').onchange = renderSides;
      $('#tSend').onclick = async () => {
        const ids = name => [...$app.querySelectorAll(`input[name=${name}]:checked`)].map(c => Number(c.value));
        try {
          await api('POST', '/api/trades', { draft_id: draftId, to_user: Number($('#tWith').value), give: ids('give'), get: ids('get'), message: $('#tMsg').value });
          toast('Trade request sent'); route();
        } catch (e) { toast(e.message, true); }
      };
      await loadDraft();
    }
    own(seq, live('trades', () => { if (location.hash !== '#/trades' || $app.querySelector('input:checked') || document.activeElement?.id === 'tMsg') { updateTradeBadge(); return; } route(); }));
  }

  // ------------------------------------------------------------ profile
  async function viewProfile() {
    const me = state.me;
    const seq = routeSeq;
    const drafts = await api('GET', '/api/drafts');
    if (seq !== routeSeq) return;
    $app.innerHTML = `
      <div class="page">
        <h1>Profile</h1>
        <div class="grid2">
          <form class="panel" id="pForm">
            <div class="row" style="margin-bottom:14px">${avatar(me, 'lg')}<div><div style="font-family:var(--cond);font-size:1.6rem;font-weight:800">${esc(me.display_name)}</div>
              <div class="muted small">@${esc(me.username)}${me.is_admin ? ' · Commissioner' : ''} · joined ${esc(me.created_at.slice(0, 10))}</div></div></div>
            <div class="field"><label>Display name</label><input type="text" name="display_name" value="${esc(me.display_name)}" maxlength="40"></div>
            <div class="field"><label>Email</label><input type="email" name="email" value="${esc(me.email || '')}"></div>
            <label class="toggle" style="display:flex;gap:8px;color:var(--text);margin-bottom:14px"><input type="checkbox" name="notify_email" ${me.notify_email ? 'checked' : ''}> Email me when I’m on the clock (email drafts) and about trades</label>
            ${state.mailEnabled ? '' : '<p class="muted small">Note: outgoing email isn’t configured on the server yet.</p>'}
            <div class="field"><label>Favourite Leaf (optional)</label><input type="text" name="favorite_player" value="${esc(me.favorite_player || '')}"></div>
            <div class="field"><label>Board colour</label><input type="color" name="color" value="${esc(me.color)}" style="width:70px;height:38px;border:0;background:none"></div>
            <p class="error" id="pErr"></p>
            <button class="btn primary">Save profile</button>
          </form>
          <form class="panel" id="pwForm">
            <h2>Change password</h2>
            <div class="field"><label>Current password</label><div class="pw-wrap"><input type="password" name="current" required autocomplete="current-password"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div></div>
            <div class="field"><label>New password</label><div class="pw-wrap"><input type="password" name="next" required minlength="6" autocomplete="new-password"><button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">Show</button></div></div>
            <p class="error" id="pwErr"></p>
            <button class="btn">Update password</button>
          </form>
        </div>
        <div class="panel" id="prefsPanel"><p class="muted">Loading preferences…</p></div>
        <div class="panel"><h2>My drafts</h2><div id="myDrafts" class="muted">Loading…</div></div>
      </div>`;
    const $ = sel => $app.querySelector(sel);
    $('#pForm').onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.notify_email = !!body.notify_email;
      try { const { user } = await api('PUT', '/api/me', body); state.me = user; toast('Profile saved'); route(); }
      catch (err) { $('#pErr').textContent = err.message; }
    };
    renderPrefs(seq);
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      try { await api('PUT', '/api/me/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Password updated'); }
      catch (err) { $('#pwErr').textContent = err.message; }
    };
    const rows = [];
    for (const d of drafts.filter(x => x.pick_count > 0)) {
      const s = await api('GET', `/api/drafts/${d.id}`);
      if (seq !== routeSeq) return;
      const mine = s.picks.filter(p => p.user_id === me.id);
      if (!mine.length) continue;
      const times = mine.map(p => p.seconds_taken).filter(x => x != null);
      const gameMap = Object.fromEntries(s.games.map(g => [g.id, g]));
      const value = s.picks.filter(p => p.owner_id === me.id).reduce((a, p) => a + pickValue(p, gameMap[p.game_id]), 0);
      rows.push(`<tr><td><a href="#/history/${d.id}">${esc(d.name)}</a></td><td>${s.picks.filter(p => p.owner_id === me.id).length}</td><td>${value ? fmtMoney(value) : '—'}</td>
        <td>${times.length ? fmtDur(times.reduce((a, b) => a + b, 0) / times.length) : '—'}</td><td>${s.order.find(o => o.user_id === me.id)?.position ?? '—'}</td></tr>`);
    }
    $('#myDrafts').innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Draft</th><th>Games held</th><th>Value</th><th>Avg pick time</th><th>Draft slot</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : 'No picks yet.';
  }

  // ------------------------------------------------------------ draft preferences (private)
  async function renderPrefs(seq) {
    const el = $app.querySelector('#prefsPanel');
    const { prefs: saved } = await api('GET', '/api/me/prefs');
    if (seq !== routeSeq || !el) return;
    const p = JSON.parse(JSON.stringify(saved));
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const seg = (name, value, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${value === v ? 'on' : ''} ${v}">${l}</button>`).join('')}</div>`;
    const render = () => {
      el.innerHTML = `
        <div class="row spread"><h2 style="margin:0">Draft preferences</h2><span class="pill setup">🔒 only you can see these</span></div>
        <p class="muted small">Used to suggest your next pick on the draft board. Everything is optional — leave it all blank and no suggestion is shown.</p>
        <div class="prefs-grid">
          <div>
            <h3>Days of the week</h3>
            <div class="day-prefs">${DAYS.map((d, i) => `<div class="day-row"><span>${d}</span>${seg(`day${i}`, p.days[i] || 'any', [['prefer', 'Prefer'], ['any', '—'], ['avoid', 'Avoid']])}</div>`).join('')}</div>
            <h3 style="margin-top:16px">Favourite opponents <span class="muted small">(up to 5, most important first)</span></h3>
            <ol class="order-list" id="oppList">${p.opponents.map((a, i) => { const t = team(a); return `<li><span class="pos">${i + 1}</span>${logo(a, 'dark', 'sm')}<span class="name">${esc(t.city)} ${esc(t.name)}</span>
              <button type="button" class="icon-btn" data-oup="${i}" ${i ? '' : 'disabled'}>▲</button><button type="button" class="icon-btn" data-odown="${i}" ${i < p.opponents.length - 1 ? '' : 'disabled'}>▼</button>
              <button type="button" class="icon-btn" data-orm="${i}" title="Remove">✕</button></li>`; }).join('') || '<li class="muted">None yet.</li>'}</ol>
            ${p.opponents.length < 5 ? `<div class="row"><select id="oppAdd" style="flex:1"><option value="">Add an opponent…</option>${state.teams.filter(t => !t.defunct && !p.opponents.includes(t.abbr)).map(t => `<option value="${t.abbr}">${esc(t.city)} ${esc(t.name)}</option>`).join('')}</select></div>` : ''}
          </div>
          <div>
            <h3>Ticket cost</h3>
            ${seg('cost', p.cost, [['high', 'Prioritize premium games'], ['any', 'No preference']])}
            <h3 style="margin-top:14px">Repeat opponents</h3>
            ${seg('repeats', p.repeats, [['prefer', 'Happy to repeat'], ['any', 'No preference'], ['avoid', 'Prefer variety']])}
            <p class="muted small" style="margin:4px 0 0">Do you like seeing the same team more than once in a season?</p>
            <h3>Preseason games</h3>
            ${seg('preseason', p.preseason, [['prefer', 'Prefer'], ['any', 'No preference'], ['avoid', 'Avoid']])}
            <h3 style="margin-top:14px">Start time</h3>
            ${seg('time', p.time, [['early', 'Earlier starts'], ['any', 'No preference'], ['evening', 'Evening (7 PM+)']])}
            <h3 style="margin-top:14px">Spread over the season</h3>
            <label class="toggle" style="display:flex;gap:8px;color:var(--text)"><input type="checkbox" id="spread" ${p.spread ? 'checked' : ''}> Even out my games per month across the season</label>
            <div class="field" style="margin-top:8px"><label>Keep at least this many days between my games (0 = no preference)</label><input type="number" min="0" max="14" id="minGap" value="${p.min_gap || 0}"></div>
            <h3>Dates to avoid</h3>
            <ul class="mini-list" id="avoidList">${p.avoid_dates.map((r, i) => `<li><span>${esc(r.label || 'Unavailable')}: ${esc(r.from)}${r.to !== r.from ? ` → ${esc(r.to)}` : ''}</span><button type="button" class="icon-btn" data-arm="${i}" title="Remove">✕</button></li>`).join('') || '<li class="muted">None.</li>'}</ul>
            <div class="row avoid-add"><input type="date" id="aFrom" title="From"><input type="date" id="aTo" title="To (optional)"><input type="text" id="aLabel" placeholder="Label, e.g. Florida trip"><button type="button" class="btn sm" id="aAdd">Add</button></div>
          </div>
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="prefsSave">Save preferences</button><button class="btn" id="prefsClear">Clear all</button><span class="muted small" id="prefsMsg"></span></div>`;
      const q = sel => el.querySelector(sel), qa = sel => el.querySelectorAll(sel);
      qa('[data-seg]').forEach(g => g.onclick = e => {
        const b = e.target.closest('[data-v]'); if (!b) return;
        const k = g.dataset.seg, v = b.dataset.v;
        if (k.startsWith('day')) { const d = k.slice(3); if (v === 'any') delete p.days[d]; else p.days[d] = v; }
        else p[k] = v;
        render();
      });
      const sync = () => { p.spread = q('#spread').checked; p.min_gap = q('#minGap').value; };
      q('#minGap').oninput = sync; q('#spread').onchange = sync;
      q('#oppAdd')?.addEventListener('change', e => { if (e.target.value) { sync(); p.opponents.push(e.target.value); render(); } });
      qa('[data-oup]').forEach(b => b.onclick = () => { sync(); const i = +b.dataset.oup; [p.opponents[i - 1], p.opponents[i]] = [p.opponents[i], p.opponents[i - 1]]; render(); });
      qa('[data-odown]').forEach(b => b.onclick = () => { sync(); const i = +b.dataset.odown; [p.opponents[i + 1], p.opponents[i]] = [p.opponents[i], p.opponents[i + 1]]; render(); });
      qa('[data-orm]').forEach(b => b.onclick = () => { sync(); p.opponents.splice(+b.dataset.orm, 1); render(); });
      qa('[data-arm]').forEach(b => b.onclick = () => { sync(); p.avoid_dates.splice(+b.dataset.arm, 1); render(); });
      q('#aAdd').onclick = () => {
        sync();
        const from = q('#aFrom').value, to = q('#aTo').value || from;
        if (!from) { toast('Pick a date', true); return; }
        p.avoid_dates.push({ from, to: to < from ? from : to, label: q('#aLabel').value }); render();
      };
      q('#prefsSave').onclick = async () => {
        sync();
        try { const r = await api('PUT', '/api/me/prefs', { prefs: p }); Object.assign(p, r.prefs); render(); toast(r.active ? 'Preferences saved — suggestions are on' : 'Saved — no preferences set, so no suggestions'); }
        catch (e) { toast(e.message, true); }
      };
      q('#prefsClear').onclick = async () => {
        if (!confirm('Clear all your draft preferences? Suggestions will be turned off.')) return;
        const r = await api('PUT', '/api/me/prefs', { prefs: {} }); Object.keys(p).forEach(k => delete p[k]); Object.assign(p, r.prefs); render(); toast('Preferences cleared');
      };
    };
    render();
  }

  // ------------------------------------------------------------ boot
  const menuBtn = document.getElementById('menuBtn');
  menuBtn.onclick = () => { const open = $nav.classList.toggle('menu-open'); menuBtn.setAttribute('aria-expanded', open); menuBtn.textContent = open ? '✕' : '☰'; };
  document.getElementById('mainNav').addEventListener('click', e => { if (e.target.closest('a, button')) { $nav.classList.remove('menu-open'); menuBtn.textContent = '☰'; } });
  // Show/hide toggle for every password box (markup: .pw-wrap > input + .pw-toggle).
  document.addEventListener('click', e => {
    const b = e.target.closest('.pw-toggle'); if (!b) return;
    const input = b.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = '#/login'; };
  window.addEventListener('hashchange', route);
  (async () => {
    const [{ user, mail_enabled, logo_url }, teams] = await Promise.all([api('GET', '/api/me'), fetch('/api/teams').then(r => r.json())]);
    state.me = user; state.mailEnabled = mail_enabled; state.logoUrl = logo_url || ''; state.teams = teams; state.teamMap = Object.fromEntries(teams.map(t => [t.abbr, t]));
    route();
  })();
})();
