// REQUIREMENTS §13 items 1, 3 (backup commissioners) and 12: accounts, roles, partner management, password reset.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, league, rejects } = require('./helpers');

let server, admin, clients, ids;
before(async () => {
  server = await startServer();
  ({ admin, clients, ids } = await league(server, ['quinn', 'abela', 'pope'], { emails: true }));
});
after(() => server?.stop());

test('first sign-up becomes the commissioner; later sign-ups are partners', () => {
  assert.equal(admin.user.is_admin, true);
  assert.equal(clients.abela.user.is_admin, false);
  assert.equal(clients.pope.user.is_admin, false);
});

test('sign-up needs the invite code, a valid username and a 6+ character password', async () => {
  const c = server.client();
  await rejects(c.register('stranger', { invite_code: 'wrong' }), 403, /invite code/i);
  await rejects(c.register('x', {}), 400, /Username/);
  await rejects(c.register('shortpw', { password: '123' }), 400, /6 characters/);
  await rejects(c.register('ABELA', {}), 409, /taken/);
});

test('login, /api/me and logout', async () => {
  const c = server.client();
  await rejects(c.login('abela', 'nope'), 401);
  await c.login('abela');
  assert.equal((await c.get('/api/me')).user.username, 'abela');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).user, null);
  await rejects(c.get('/api/drafts'), 401);
});

test('partners cannot use commissioner routes', async () => {
  await rejects(clients.abela.post('/api/drafts', {}), 403, /Commissioner only/);
  await rejects(clients.abela.put(`/api/users/${ids.pope}`, { active: false }), 403);
  await rejects(clients.abela.post(`/api/users/${ids.pope}/reset-link`), 403);
});

test('an inactive partner cannot log in, and their open sessions end', async () => {
  const c = server.client();
  await c.register('temp');
  await admin.put(`/api/users/${c.user.id}`, { active: false });
  await rejects(c.get('/api/drafts'), 401);
  await rejects(server.client().login('temp'), 403, /deactivated/);
  await admin.put(`/api/users/${c.user.id}`, { active: true });
  await server.client().login('temp');
  await admin.del(`/api/users/${c.user.id}`);
});

test('backup commissioners: promote, demote, and the last commissioner is always kept', async () => {
  await rejects(admin.put(`/api/users/${ids.quinn}`, { is_admin: false }), 400, /at least one active commissioner/);
  await rejects(admin.put(`/api/users/${ids.quinn}`, { active: false }), 400);
  await admin.put(`/api/users/${ids.abela}`, { is_admin: true });
  const abela = server.client(); await abela.login('abela');
  assert.equal((await abela.get('/api/me')).user.is_admin, true);
  // The backup has full powers, including demoting the original commissioner…
  await abela.put(`/api/users/${ids.quinn}`, { is_admin: false });
  // …but not themselves once they are the only one left.
  await rejects(abela.put(`/api/users/${ids.abela}`, { is_admin: false }), 400, /at least one/);
  await abela.put(`/api/users/${ids.quinn}`, { is_admin: true });
  await admin.put(`/api/users/${ids.abela}`, { is_admin: false });
});

test('commissioners cannot deactivate or delete themselves', async () => {
  await admin.put(`/api/users/${ids.abela}`, { is_admin: true });
  await rejects(admin.put(`/api/users/${ids.quinn}`, { active: false }), 400, /your own account/);
  await rejects(admin.del(`/api/users/${ids.quinn}`), 400, /your own profile/);
  await admin.put(`/api/users/${ids.abela}`, { is_admin: false });
});

test('commissioner reset link: works once, within the time limit, and logs the partner out elsewhere', async () => {
  const pope = server.client(); await pope.login('pope');
  const { link, hours } = await admin.post(`/api/users/${ids.pope}/reset-link`);
  assert.equal(hours, 2);
  const token = link.split('/reset/')[1];
  assert.ok(token);
  const fresh = server.client();
  await fresh.post('/api/password/reset', { token, password: 'newpass1' });
  assert.equal((await fresh.get('/api/me')).user.username, 'pope');
  await rejects(pope.get('/api/drafts'), 401);                                                          // old session ended
  await rejects(server.client().post('/api/password/reset', { token, password: 'again12' }), 400, /invalid or has expired/); // single use
  await server.client().login('pope', 'newpass1');
  await fresh.put('/api/me/password', { current: 'newpass1', next: 'password1' });
});

test('forgot password: same answer for unknown accounts; emails a link to known ones', async () => {
  const anon = server.client();
  assert.equal((await anon.post('/api/password/forgot', { login: 'nobody' })).ok, true);
  await anon.post('/api/password/forgot', { login: 'abela@example.test' });
  const m = /to=abela@example\.test subject="[^"]*Reset[^"]*"[\s\S]*?#\/reset\/([\w-]+)/.exec(server.log());
  assert.ok(m, 'reset email should be logged when SMTP is not configured');
  await anon.post('/api/password/reset', { token: m[1], password: 'password1' });
  await clients.abela.login('abela');   // a reset logs the partner out everywhere
});

test('profile updates validate the colour', async () => {
  await rejects(clients.abela.put('/api/me', { color: 'blue' }), 400, /hex/);
  const { user } = await clients.abela.put('/api/me', { display_name: 'Abela', color: '#112233', email: 'abela@example.test' });
  assert.equal(user.color, '#112233');
  assert.equal(user.display_name, 'Abela');
});

test('deleting a partner with no history removes them completely', async () => {
  const c = server.client();
  await c.register('leaver');
  const r = await admin.del(`/api/users/${c.user.id}`);
  assert.equal(r.kept_history, false);
  const users = await admin.get('/api/users');
  assert.ok(!users.some(u => u.username === 'leaver'));
});
