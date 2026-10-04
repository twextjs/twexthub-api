import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishAndApprove(adminToken, owner, id, code = `// ${id}`) {
  const ns = owner.user.namespace;
  await publishProject(app, ns, id, owner.token, { code });
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/1.0.0`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

test('admin metrics renders Prometheus text with registry counters and telemetry', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  await publishAndApprove(admin.token, owner, 'hello');

  // A request first, so the telemetry counters have something to show.
  await request(app).get('/v1/stats').expect(200);

  const res = await request(app).get('/v1/admin/metrics').set(bearer(admin.token)).expect(200);
  assert.match(res.headers['content-type'], /text\/plain/);

  const body = res.text;
  assert.match(body, /^# HELP twexthub_versions_total /m);
  assert.match(body, /^twexthub_versions_total\{status="published"\} 1$/m);
  assert.match(body, /^twexthub_users_total \d+$/m);
  assert.match(body, /^twexthub_downloads_total \d+$/m);
  assert.match(body, /^twexthub_storage_bytes\{kind="blob"\} \d+$/m);
  assert.match(body, /^twexthub_storage_integrity_errors 0$/m);
  // The route label carries the apiRoot prefix.
  assert.match(
    body,
    /^twexthub_http_requests_total\{method="GET",route="\/v1\/stats",status="200"\} \d+$/m,
  );
  assert.match(
    body,
    /^twexthub_http_request_duration_seconds_count\{method="GET",route="\/v1\/stats"\} \d+$/m,
  );
  assert.match(body, /^twexthub_process_uptime_seconds \d+$/m);
});

test('admin metrics is admin-only and counts unmatched paths without leaking them', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const peer = await signupAndAccept(app, uniqNs());

  await request(app).get('/v1/admin/metrics').set(bearer(peer.token)).expect(403);
  await request(app).get('/v1/admin/metrics').expect(401);

  // A 404 hit records under the "unmatched" route label, not the raw path.
  await request(app).get('/v1/definitely-not-a-route').expect(404);
  const res = await request(app).get('/v1/admin/metrics').set(bearer(admin.token)).expect(200);
  assert.match(
    res.text,
    /^twexthub_http_requests_total\{method="GET",route="unmatched",status="404"\} \d+$/m,
  );
  assert.ok(!res.text.includes('definitely-not-a-route'), 'raw paths stay out of the exposition');
});
