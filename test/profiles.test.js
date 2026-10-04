import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  acceptTerms,
  signupAndAccept,
  signup,
  FIXTURE_PASSWORD,
} from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('profile fields round-trip through PATCH and the public user', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const patched = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({
      bio: 'I make Twexts.',
      website: 'https://example.com/~dev',
      github: 'octocat',
      avatarUrl: 'https://cdn.example.com/a.png',
      bannerUrl: 'https://cdn.example.com/b.png',
    })
    .expect(200);
  assert.equal(patched.body.bio, 'I make Twexts.');
  assert.equal(patched.body.website, 'https://example.com/~dev');
  assert.equal(patched.body.github, 'octocat');
  assert.equal(patched.body.avatarUrl, 'https://cdn.example.com/a.png');
  assert.equal(patched.body.bannerUrl, 'https://cdn.example.com/b.png');

  // The public view exposes them too.
  const pub = await request(app).get(`/v1/users/${ns}`).expect(200);
  assert.equal(pub.body.bio, 'I make Twexts.');
  assert.equal(pub.body.github, 'octocat');
});

test('profile validation rejects bad URLs, long bios, and malformed github names', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const bad = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({
      bio: 'x'.repeat(281),
      website: 'javascript:alert(1)',
      github: 'not a name!',
    });
  assert.equal(bad.status, 422);
  const fields = bad.body.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['bio', 'github', 'website']);

  const longUrl = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ avatarUrl: `https://example.com/${'a'.repeat(400)}` });
  assert.equal(longUrl.status, 422);
});

test('profile fields can be cleared with null', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;
  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ bio: 'hello', website: 'https://example.com' })
    .expect(200);
  const cleared = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ bio: null, website: null })
    .expect(200);
  assert.equal(cleared.body.bio, '');
  assert.equal(cleared.body.website, null);
});

test('avatar serves a deterministic identicon and honors avatar_url', async () => {
  const a = await signupAndAccept(app, 'identicon-a');
  const b = await signupAndAccept(app, 'identicon-b');

  const first = await request(app).get(`/v1/users/identicon-a/avatar`).expect(200);
  assert.match(first.headers['content-type'], /image\/svg\+xml/);
  const art = first.text ?? first.body.toString('utf8');
  assert.match(art, /<svg /);
  assert.match(art, /<rect/);

  const again = await request(app).get(`/v1/users/identicon-a/avatar`).expect(200);
  assert.equal(again.text ?? again.body.toString('utf8'), art, 'same namespace, same identicon');

  const other = await request(app).get(`/v1/users/identicon-b/avatar`).expect(200);
  const otherArt = other.text ?? other.body.toString('utf8');
  assert.notEqual(otherArt, art, 'different namespaces get different art');

  void a;
  void b;

  // A user with an avatar_url redirects to it.
  const { user, token } = await signupAndAccept(app, uniqNs());
  await request(app)
    .patch(`/v1/users/${user.namespace}`)
    .set(bearer(token))
    .send({ avatarUrl: 'https://cdn.example.com/me.png' })
    .expect(200);
  const res = await request(app).get(`/v1/users/${user.namespace}/avatar`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://cdn.example.com/me.png');
});

test('password-only change still skips the terms gate', async () => {
  // A user who has not accepted terms can still rotate their password. The
  // currentPassword is the fixture password: without it the very first signup
  // (the bootstrap admin) is what answers here, and admins are exempt from the
  // check, so the test would not exercise the ordinary path.
  const r = await signup(app, uniqNs());
  assert.equal(r.status, 201);
  const patched = await request(app)
    .patch(`/v1/users/${r.body.user.namespace}`)
    .set(bearer(r.body.token))
    .send({ password: 'newpassword1', currentPassword: FIXTURE_PASSWORD });
  assert.equal(patched.status, 200);
});

test('a password change does not carry a profile or role edit past the terms gate', async () => {
  // The exemption is for the password alone. Attaching any other field used to
  // waive the gate for the whole request.
  const admin = await signup(app, uniqNs());
  assert.equal(admin.status, 201);
  const r = await signup(app, uniqNs());
  assert.equal(r.status, 201);
  const ns = r.body.user.namespace;

  const gated = [
    {
      field: 'bio',
      body: { password: 'newpassword1', currentPassword: FIXTURE_PASSWORD, bio: 'sneaky' },
    },
    {
      field: 'displayName',
      body: {
        password: 'newpassword1',
        currentPassword: FIXTURE_PASSWORD,
        displayName: 'new name',
      },
    },
    {
      field: 'role',
      body: { password: 'newpassword1', currentPassword: FIXTURE_PASSWORD, role: 'admin' },
    },
  ];
  for (const { field, body } of gated) {
    // A fresh token each time: a successful password change revokes the session.
    const fresh = await signup(app, uniqNs());
    assert.equal(fresh.status, 201);
    const patched = await request(app)
      .patch(`/v1/users/${fresh.body.user.namespace}`)
      .set(bearer(fresh.body.token))
      .send(body);
    assert.equal(patched.status, 403, `${field} should stay behind the terms gate`);
  }

  // Accepting the terms is itself exempt from the gate, but only on its own:
  // riding it in with a profile edit would be the same smuggling.
  const acceptancePlusEdit = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(r.body.token))
    .send({ termsAcceptedVersion: 1, bio: 'sneaky' });
  assert.equal(acceptancePlusEdit.status, 403);

  // The control: bio on its own is refused too, so the 403s above are the gate
  // and not a validation error.
  const bioOnly = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(r.body.token))
    .send({ bio: 'sneaky' });
  assert.equal(bioOnly.status, 403);

  // Once the terms are accepted, the same combined update goes through.
  await acceptTerms(app, ns, r.body.token);
  const allowed = await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(r.body.token))
    .send({ password: 'newpassword1', currentPassword: FIXTURE_PASSWORD, bio: 'fine now' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.bio, 'fine now');
});
