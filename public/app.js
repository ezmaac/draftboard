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
  const fmtGameDate = g => { const d = parseDate(g.date); return `${DOW[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
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
  const gameName = g => { const t = team(g.opponent); return `${fmtGameDate(g)} · ${t.city} ${t.name}`; };
  const pickSeats = s => s.draft.seat_mode === 'single';
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

  function live(key, fn) {
    const es = new EventSource(`/api/events/${key}`);
    es.addEventListener('update', fn);
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
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></div>
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
        <div class="field"><label>New password</label><input type="password" name="password" required minlength="6" autocomplete="new-password"></div>
        <div class="field"><label>Confirm new password</label><input type="password" name="confirm" required minlength="6" autocomplete="new-password"></div>
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
          <p class="muted small">Inactive partners can’t log in and aren’t offered for new drafts; their history stays. New partners join with the invite code.</p>
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
              <option value="playoff">Playoff draft — one seat per pick</option></select>
            </div>
            <div class="field"><label>Draft name</label><input type="text" id="dName"></div>
            <div class="field"><label>Season</label><input type="text" id="dSeason" value="${y}-${String(y + 1).slice(2)}"></div>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1"><label>Order</label>
                <select id="dType"><option value="snake">Snake (1-2-3, 3-2-1)</option><option value="linear">Linear (1-2-3, 1-2-3)</option></select></div>
              <div class="field" style="flex:1"><label>How you’ll draft</label>
                <select id="dMode"><option value="live">Live — together, now</option><option value="async">By email — over a few days</option></select></div>
            </div>
            <div class="field"><label>Clock warning after (minutes, 0 = none — never a hard limit)</label><input type="number" id="dWarn" value="2" min="0" step="0.5"></div>
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
          <div class="panel">
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
        <div class="panel">
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
    const setName = () => { $('#dName').value = `${$('#dSeason').value} ${kind === 'playoff' ? 'Playoff' : 'Season'} Draft`; };
    setName();
    $('#dSeason').oninput = setName;
    $('#dKind').onchange = () => {
      kind = $('#dKind').value; setName();
      if (kind === 'playoff') { $('#src').value = 'none'; $('#aType').value = 'playoff'; $('#src').onchange(); games = []; renderGames(); }
      else $('#aType').value = 'regular';
      renderOrder();
      renderSummary();
    };
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
        $('#order').innerHTML = `<li class="muted">🎲 Playoff order is drawn at random by the app when you create the draft — ${order.length} partners.</li>`;
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
      const picks = kind === 'playoff' ? games.length * 2 : games.length;
      const n = order.length;
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
          warn_secs: Math.round(Number($('#dWarn').value || 0) * 60), user_ids: order, games,
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
    let selected = null;
    const f = loadFilters();

    function loadFilters() {
      const d = { team: '', dows: [], type: '', hideTaken: false, mine: false, q: '' };
      try { return { ...d, ...JSON.parse(localStorage.getItem('boardFilters') || '{}') }; } catch { return d; }
    }
    function saveFilters() { try { localStorage.setItem('boardFilters', JSON.stringify(f)); } catch { /* storage unavailable */ } }

    $app.innerHTML = `
      <div class="board-page">
        <div class="scoreboard">
          <div class="sb-cell">
            <div class="clock-ctrls">
              <button class="icon-btn" id="pauseBtn" title="Pause / resume clock">❚❚</button>
              <button class="icon-btn" id="undoBtn" title="Undo last pick (commissioner)">↶</button>
              <button class="icon-btn" id="nudgeBtn" title="Email a reminder to whoever is on the clock">✉</button>
              <button class="icon-btn" id="ctrlBtn" title="Commissioner controls" hidden>⚙</button>
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
          <select id="fTeam"><option value="">All opponents</option>${[...new Set(s.games.map(g => g.opponent))].map(team).sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name)).map(t => `<option value="${t.abbr}">${esc(t.city)} ${esc(t.name)}</option>`).join('')}</select>
          <select id="fType" hidden><option value="">All game types</option><option value="preseason">Preseason</option><option value="regular">Regular season</option><option value="playoff">Playoffs</option></select>
          <div class="dow-chips" id="fDow">${DOW.map((d, i) => `<button data-dow="${i}" title="${d}">${d}</button>`).join('')}</div>
          <label class="toggle"><input type="checkbox" id="fHide"> Available only</label>
          <label class="toggle"><input type="checkbox" id="fMine"> My games</label>
          <input type="text" class="search" id="fQ" placeholder="🔍  Search team, date, note…">
          <button class="btn sm" id="fClear">Clear</button>
          <span class="spacer"></span>
          <button class="btn sm" id="addGameBtn" hidden>+ Game</button>
          <button class="btn go" id="draftBtn" disabled>Draft game</button>
        </div>
        <div class="banner"><span id="banner"></span>
          <div class="legend" style="justify-content:center;margin-top:2px"><span><i style="background:var(--atl)"></i>Atlantic</span><span><i style="background:var(--met)"></i>Metropolitan</span><span><i style="background:var(--cen)"></i>Central</span><span><i style="background:var(--pac)"></i>Pacific</span></div></div>
        <div class="board" id="board"></div>
        <div class="ticker"><div class="tag">🍁 PICKS</div><div class="track"><div class="scroll" id="ticker"></div></div></div>
      </div>`;
    const $ = sel => $app.querySelector(sel);

    // filters
    $('#fTeam').value = f.team; $('#fType').value = f.type; $('#fHide').checked = f.hideTaken; $('#fMine').checked = f.mine; $('#fQ').value = f.q;
    const syncDow = () => $('#fDow').querySelectorAll('button').forEach(b => b.classList.toggle('on', f.dows.includes(+b.dataset.dow)));
    syncDow();
    $('#fTeam').onchange = () => { f.team = $('#fTeam').value; saveFilters(); renderBoard(); };
    $('#fType').onchange = () => { f.type = $('#fType').value; saveFilters(); renderBoard(); };
    $('#fHide').onchange = () => { f.hideTaken = $('#fHide').checked; saveFilters(); renderBoard(); };
    $('#fMine').onchange = () => { f.mine = $('#fMine').checked; saveFilters(); renderBoard(); };
    $('#fQ').oninput = () => { f.q = $('#fQ').value; saveFilters(); renderBoard(); };
    $('#fDow').onclick = e => {
      const b = e.target.closest('[data-dow]'); if (!b) return;
      const d = +b.dataset.dow;
      f.dows = f.dows.includes(d) ? f.dows.filter(x => x !== d) : [...f.dows, d];
      saveFilters(); syncDow(); renderBoard();
    };
    $('#fClear').onclick = () => {
      Object.assign(f, { team: '', dows: [], type: '', hideTaken: false, mine: false, q: '' }); saveFilters();
      $('#fTeam').value = ''; $('#fType').value = ''; $('#fHide').checked = false; $('#fMine').checked = false; $('#fQ').value = ''; syncDow(); renderBoard();
    };

    const myTurn = () => s.draft.status === 'live' && s.on_clock && (s.on_clock.user_id === state.me.id || state.me.is_admin);

    function renderHeader() {
      const d = s.draft;
      clockBase = d.elapsed_ms; clockT0 = performance.now();
      const users = usersOf(s);
      $('#pauseBtn').disabled = d.status !== 'live' || !(state.me.is_admin || s.on_clock?.user_id === state.me.id);
      $('#ctrlBtn').hidden = !state.me.is_admin || d.source === 'import';
      $('#pauseBtn').textContent = d.paused_at ? '▶' : '❚❚';
      $('#undoBtn').disabled = !state.me.is_admin || !s.picks.length || d.status === 'setup' || d.source === 'import';
      $('#nudgeBtn').disabled = d.status !== 'live';
      $('#addGameBtn').hidden = !(state.me.is_admin && d.status !== 'complete');
      $('#fType').hidden = new Set(s.games.map(g => g.type)).size < 2;
      $('#rnd').textContent = s.on_clock ? s.on_clock.round : d.status === 'complete' ? '✓' : '–';
      $('#pk').textContent = s.on_clock ? s.on_clock.pick_in_round : '–';
      $('#banner').innerHTML = `${esc(d.name)} <span class="muted">· ${s.picks.length}/${d.total_picks} picks${pickSeats(s) ? ' (single seats)' : ''}${d.mode === 'async' ? ' · drafting by email' : ''}${d.status === 'setup' ? ' · not started' : ''}${d.status === 'complete' ? ' · complete' : ''}</span>`;

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

    function tickClock() {
      const d = s.draft;
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
      $('#clockSub').textContent = d.paused_at ? 'clock paused' : warn ? `over ${fmtDur(d.warn_secs)} — no limit, just a nudge` :
        times.length ? `avg pick ${fmtDur(times.reduce((a, b) => a + b, 0) / times.length)}` : 'time on the clock';
    }

    function gameMatches(g, gp) {
      const d = parseDate(g.date);
      if (f.team && g.opponent !== f.team) return false;
      if (f.type && g.type !== f.type) return false;
      if (f.dows.length && !f.dows.includes(d.getDay())) return false;
      if (f.mine && !gp.some(p => p.owner_id === state.me.id)) return false;
      if (f.hideTaken && gp.length >= (pickSeats(s) ? g.seats : 1)) return false;
      if (f.q) {
        const t = team(g.opponent);
        const hay = `${t.abbr} ${t.city} ${t.name} ${fmtGameDate(g)} ${MONTHS_LONG[d.getMonth()]} ${g.notes} ${TYPE_LABEL[g.type]}`.toLowerCase();
        if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    }

    function ownerLine(p, users) {
      const u = users[p.owner_id], drafter = users[p.user_id];
      const traded = p.owner_id !== p.user_id;
      return `<div class="by" style="--who:${esc(u.color)}"><span class="dot"></span>${esc(u.display_name)}${traded ? ` <span class="slot" title="Drafted by ${esc(drafter.display_name)}">⇄</span>` : ''}${p.seat ? `<span class="slot">S${p.seat}</span>` : ''}<span class="slot">${p.round}.${p.pick_in_round}</span></div>`;
    }

    function renderBoard() {
      const picksByGame = {};
      s.picks.forEach(p => (picksByGame[p.game_id] ||= []).push(p));
      const users = usersOf(s);
      const single = pickSeats(s);
      const months = new Map();
      s.games.forEach(g => {
        const d = parseDate(g.date); const k = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
        if (!months.has(k)) months.set(k, { label: MONTHS_LONG[d.getMonth()], year: d.getFullYear(), games: [] });
        months.get(k).games.push(g);
      });
      const full = g => (picksByGame[g.id] || []).length >= (single ? g.seats : 1);
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
          const left = single ? g.seats - gp.length : 0;
          if (s.draft.status === 'complete' && !gp.length) {
            return `<div class="card taken" style="--who:#555" title="${esc(g.notes)}">
              <div class="top"><span>${badge}${fmtGameDate(g)}</span><span>${t.abbr}</span></div>
              <div class="opp">${logo(g.opponent, 'dark', 'sm muted-logo')}<span>${esc(t.name)}</span></div><div class="by"><span class="slot" style="margin-left:0">${esc(g.notes || 'not drafted')}</span></div></div>`;
          }
          return `<button class="card ${t.div} ${selected === g.id ? 'selected' : ''}" data-game="${g.id}">
            <div class="top"><span>${badge}${fmtGameDate(g)}</span><span>${fmtTime(g.time)}</span></div>
            <div class="city"><span>${esc(t.city)}</span><span title="Price for the pair">${fmtMoney(g.price)}</span></div>
            <div class="opp">${logo(g.opponent, 'light')}<span>${esc(t.name)}</span></div>
            ${g.notes ? `<div class="note">★ ${esc(g.notes)}</div>` : ''}
            ${single && gp.length ? `<div class="seats">${left} seat${left === 1 ? '' : 's'} left</div>${gp.map(p => ownerLine(p, users)).join('')}` : ''}
          </button>`;
        }).join('');
        return `<section class="month"><div class="month-head">${m.label} <span>${m.year}</span></div>${cards || '<div class="empty-month">No games match</div>'}</section>`;
      }).join('') || '<p class="muted" style="padding:16px">No games in this draft yet.</p>';
      $('#draftBtn').disabled = !(selected && myTurn());
      $('#draftBtn').textContent = myTurn() && s.on_clock.user_id !== state.me.id ? `Draft for ${users[s.on_clock.user_id].display_name}` : single ? 'Draft seat' : 'Draft game';
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
      const forUser = usersOf(s)[s.on_clock.user_id];
      const behalf = s.on_clock.user_id !== state.me.id;
      const taken = s.picks.filter(p => p.game_id === g.id);
      modal(`
        <div class="muted small">ROUND ${s.on_clock.round} · PICK ${s.on_clock.pick_in_round} · ${behalf ? `ON BEHALF OF ${esc(forUser.display_name.toUpperCase())}` : 'YOUR PICK'}</div>
        <div class="big row" style="gap:12px">${logo(g.opponent, 'dark', 'lg')}<span>${esc(t.city)} ${esc(t.name)}</span></div>
        <p>${fmtGameDate(g)} · ${fmtTime(g.time)}${g.price ? ` · ${fmtMoney(g.price)} for the pair${pickSeats(s) ? ` (${fmtMoney(g.price / g.seats)}/seat)` : ''}` : ''}${g.notes ? ` · ${esc(g.notes)}` : ''}</p>
        ${pickSeats(s) ? `<p class="muted">One seat (seat ${taken.length + 1} of ${g.seats})${taken.length ? ` — the other is held by ${esc(usersOf(s)[taken[0].owner_id].display_name)}` : ''}.</p>` : ''}
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
          <button class="btn" data-c="pause" ${live ? '' : 'disabled'}>${d.paused_at ? '▶ Resume clock' : '❚❚ Pause clock'}</button>
          <button class="btn" data-c="reset_clock" ${live ? '' : 'disabled'}>⟲ Restart this pick’s clock <span class="muted">(back to 0:00)</span></button>
          <button class="btn" data-c="undo" ${s.picks.length && d.status !== 'setup' ? '' : 'disabled'}>↶ Undo last pick</button>
          <button class="btn danger" data-c="restart" ${d.status !== 'setup' ? '' : 'disabled'}>⏮ Restart draft <span class="muted">(clear all picks, start again at pick 1)</span></button>
          <button class="btn danger" data-c="reset" ${d.status !== 'setup' ? '' : 'disabled'}>⟳ Reset to setup <span class="muted">(clear picks, edit partners &amp; order)</span></button>
          <button class="btn" data-c="order" ${d.status === 'setup' ? '' : 'disabled'}>👥 Edit partners &amp; order</button>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn" data-close>Close</button></div>`, ($m, close) => {
        $m.querySelectorAll('[data-c]').forEach(b => (b.onclick = async () => {
          const c = b.dataset.c; close();
          const traded = d.status === 'complete' ? ' Any trades made from this draft are deleted too.' : '';
          if (c === 'pause') $('#pauseBtn').click();
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
      modal(`<h2>Partners &amp; order</h2>
        <div class="check-list" id="eoWho"></div>
        ${playoff ? '<p class="muted small">🎲 The playoff order is re-drawn at random when you save.</p>' : '<ol class="order-list" id="eoOrder"></ol>'}
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
          try { s = await api('PUT', `/api/drafts/${id}/order`, { user_ids: order }); close(); renderAll(); toast('Partners & order saved'); }
          catch (e) { toast(e.message, true); }
        };
      });
    }
    $('#nudgeBtn').onclick = async () => {
      try { const r = await api('POST', `/api/drafts/${id}/nudge`); toast(r.mail_enabled ? 'Reminder email sent' : 'Email isn’t configured on the server yet — reminder logged only'); }
      catch (e) { toast(e.message, true); }
    };
    $('#addGameBtn').onclick = () => modal(`
      <h2>Add a game</h2>
      <div class="field"><label>Date</label><input type="date" id="mDate"></div>
      <div class="row"><div class="field" style="flex:1"><label>Time</label><input type="time" id="mTime" value="19:00"></div>
        <div class="field" style="flex:1"><label>Price (pair)</label><input type="number" id="mPrice" min="0"></div></div>
      <div class="field"><label>Opponent</label><select id="mOpp">${teamOptions()}</select></div>
      <div class="field"><label>Type</label><select id="mType"><option value="regular">Regular season</option><option value="preseason">Preseason</option><option value="playoff" ${s.draft.kind === 'playoff' ? 'selected' : ''}>Playoff</option></select></div>
      <div class="field"><label>Notes</label><input type="text" id="mNotes" placeholder="e.g. Rd 1 Gm 2"></div>
      <div class="row"><button class="btn primary" id="mAdd">Add game</button><button class="btn" data-close>Cancel</button></div>`,
      ($m, close) => {
        $m.querySelector('#mAdd').onclick = async () => {
          const v = k => $m.querySelector(k).value;
          try { s = await api('POST', `/api/drafts/${id}/games`, { date: v('#mDate'), time: v('#mTime'), price: v('#mPrice'), opponent: v('#mOpp'), type: v('#mType'), notes: v('#mNotes') }); close(); renderAll(); }
          catch (e) { toast(e.message, true); }
        };
      });

    // live updates
    async function refresh() {
      const prevCount = s.picks.length;
      try { s = await api('GET', `/api/drafts/${id}`); } catch { return; }
      renderAll();
      if (s.picks.length > prevCount && s.on_clock?.user_id === state.me.id) { toast('🍁 You’re on the clock!'); beep(); }
    }
    const stop = live(id, refresh);
    const timer = setInterval(tickClock, 250);
    const onKey = e => { if (e.key === 'Escape' && selected) { selected = null; renderBoard(); } };
    document.addEventListener('keydown', onKey);
    own(seq, () => { stop(); clearInterval(timer); document.removeEventListener('keydown', onKey); });
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
      return `<div class="rg-cell card ${t.div}" style="cursor:default"><div class="d">${fmtGameDate(g)}${seatLabel(p)}</div><div class="o">${logo(g.opponent, 'light', 'sm')}<span>${esc(t.name)}</span></div><div class="s">#${p.overall}${imported ? '' : ` · ${fmtDur(p.seconds_taken)}`}${g.price ? ` · ${fmtMoney(pickValue(p, g))}` : ''}</div></div>`;
    };
    const stats = uid => {
      const drafted = s.picks.filter(p => p.user_id === uid);
      const held = s.picks.filter(p => p.owner_id === uid);
      const secs = drafted.map(p => p.seconds_taken).filter(x => x != null);
      const weekend = held.filter(p => [0, 5, 6].includes(parseDate(gameMap[p.game_id].date).getDay())).length;
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
                <div class="stat"><div class="v">${st.count}</div><div class="k">${pickSeats(s) ? 'Seats' : 'Games'}</div></div>
                <div class="stat"><div class="v">${st.weekend}</div><div class="k">Fri–Sun</div></div>
                ${anyPrice ? `<div class="stat"><div class="v">${fmtMoney(st.value)}</div><div class="k">Value</div></div>` : ''}
                ${st.avg == null ? '' : `<div class="stat"><div class="v">${fmtDur(st.avg)}</div><div class="k">Avg pick</div></div>
                <div class="stat"><div class="v">${fmtDur(st.max)}</div><div class="k">Longest</div></div>`}
              </div>
              <ul class="mini-list">${st.held.slice().sort((a, b) => gameMap[a.game_id].date.localeCompare(gameMap[b.game_id].date)).map(p => { const g = gameMap[p.game_id];
                return `<li><span class="with-logo">${logo(g.opponent, 'dark', 'xs')}${fmtGameDate(g)} · ${esc(team(g.opponent).name)}${seatLabel(p)}${p.owner_id !== p.user_id ? ` <span class="muted" title="Drafted by ${esc(users[p.user_id].display_name)}">⇄ via trade</span>` : ''}</span><span>${orderKnown ? `#${p.overall}` : ''}${p.seconds_taken != null ? ` · ${fmtDur(p.seconds_taken)}` : ''}</span></li>`; }).join('') || '<li class="muted">No picks</li>'}</ul>
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
            <tbody>${(orderKnown ? s.picks : s.picks.slice().sort((a, b) => gameMap[a.game_id].date.localeCompare(gameMap[b.game_id].date))).map(p => { const g = gameMap[p.game_id]; const t = team(g.opponent);
              return `<tr>${orderKnown ? `<td>${p.overall}</td>${regular ? `<td>${p.round}.${p.pick_in_round}</td>` : ''}` : ''}<td>${esc(users[p.user_id].display_name)}${p.made_by && p.made_by !== p.user_id ? ' <span class="muted small">(entered by commissioner)</span>' : ''}</td>
                <td class="with-logo">${logo(g.opponent, 'dark', 'xs')}${fmtGameDate(g)}, ${parseDate(g.date).getFullYear()} · ${g.time ? `${fmtTime(g.time)} · ` : ''}${esc(t.city)} ${esc(t.name)}${seatLabel(p)}${g.notes ? ` <span class="muted small">${esc(g.notes)}</span>` : ''}${g.type !== 'regular' ? ` <span class="tbadge">${g.type === 'preseason' ? 'PRE' : 'PO'}</span>` : ''}</td>
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
          const ps = s.picks.filter(p => p.owner_id === owner && gameMap[p.game_id].date >= today)
            .sort((a, b) => gameMap[a.game_id].date.localeCompare(gameMap[b.game_id].date));
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
      const body = Object.fromEntries(new FormData(e.target));
      body.notify_email = !!body.notify_email;
      try { const { user } = await api('PUT', '/api/me', body); state.me = user; toast('Profile saved'); route(); }
      catch (err) { $('#pErr').textContent = err.message; }
    };
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

  // ------------------------------------------------------------ boot
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = '#/login'; };
  window.addEventListener('hashchange', route);
  (async () => {
    const [{ user, mail_enabled, logo_url }, teams] = await Promise.all([api('GET', '/api/me'), fetch('/api/teams').then(r => r.json())]);
    state.me = user; state.mailEnabled = mail_enabled; state.logoUrl = logo_url || ''; state.teams = teams; state.teamMap = Object.fromEntries(teams.map(t => [t.abbr, t]));
    route();
  })();
})();
