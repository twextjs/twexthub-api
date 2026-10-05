import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signupAndAccept,
  publishProject,
  followPages,
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

// Publishes several extensions under fresh namespaces. Returns their metadata
// for the assertions below.
async function seedExtensions() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const first = async (id, version, extra) => {
    await publishProject(app, ns, id, owner.token, {
      version,
      code: `// ${id}`,
      description: `desc ${id}`,
      ...extra,
    });
    const queue = await request(app)
      .get('/v1/versions?status=pending')
      .set(bearer(admin.token))
      .expect(200);
    const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
    await request(app)
      .patch(`/v1/@${ns}/${id}/versions/${entry.version}`)
      .set(bearer(admin.token))
      .send({ status: 'approved' })
      .expect(200);
  };
  const rest = async (id, version, extra) => {
    await publishProject(app, ns, id, owner.token, {
      version,
      code: `// ${id}`,
      description: `desc ${id}`,
      ...extra,
    });
  };

  // Publish order: minterm (Apache), alpaca (MIT), zoo (MIT) — alphabetical
  // name order differs from recency order.
  await first('minterm', '1.0.0', { license: 'Apache-2.0' });
  await rest('alpaca', '1.0.0');
  await rest('zoo', '1.0.0');
  return { ns, owner, admin };
}

async function downloadNs(sqlClient, ns, id) {
  await sqlClient`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, ip_hash)
    VALUES (${ns}, ${id}, '1.0.0', 'test', '10.0.0.9')
  `;
}

test('sort=downloads orders by cumulative downloads', async () => {
  const { ns } = await seedExtensions();
  // zoo gets the most downloads, alpaca none
  for (let i = 0; i < 3; i += 1) await downloadNs(sql, ns, 'zoo');
  await downloadNs(sql, ns, 'minterm');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const r = await request(app).get('/v1/extensions?sort=downloads').expect(200);
  const ids = r.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(ids, ['zoo', 'minterm', 'alpaca']);
  const zoo = r.body.data.find((e) => e.id === 'zoo');
  assert.equal(zoo.downloads, 3);
});

test('sort=name is alphabetical, sort=updated favors newest publication', async () => {
  const { ns } = await seedExtensions();

  const byName = await request(app).get('/v1/extensions?sort=name').expect(200);
  const nameIds = byName.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(nameIds, ['alpaca', 'minterm', 'zoo']);

  // minterm was published first (pending approval), zoo last
  const byUpdated = await request(app).get('/v1/extensions?sort=updated').expect(200);
  const updatedIds = byUpdated.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(updatedIds, ['zoo', 'alpaca', 'minterm']);
});

test('license filter narrows results and combines with search', async () => {
  await seedExtensions();

  const apache = await request(app).get('/v1/extensions?license=Apache-2.0').expect(200);
  assert.equal(apache.body.data.length, 1);
  assert.equal(apache.body.data[0].id, 'minterm');
  assert.equal(apache.body.data[0].license, undefined); // summaries carry no license field

  const mit = await request(app).get('/v1/search?query=desc&license=MIT').expect(200);
  assert.ok(mit.body.data.length >= 2);
  assert.ok(!mit.body.data.some((e) => e.id === 'minterm'));

  const both = await request(app).get('/v1/search?query=zoo&license=MIT').expect(200);
  assert.equal(both.body.data.length, 1);
  assert.equal(both.body.data[0].id, 'zoo');
});

test('unknown sort values are rejected with 400', async () => {
  const r = await request(app).get('/v1/extensions?sort=popular');
  assert.equal(r.status, 400);
});

test('paginating with sort=name walks every page', async () => {
  await seedExtensions();

  const { rows } = await followPages(app, '/v1/extensions?sort=name&limit=2');
  const seen = rows.map((e) => `${e.namespace}/${e.id}`);
  assert.ok(seen.length > 2, 'expected more than one page');
  assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
});

test('paginating with sort=downloads walks every page', async () => {
  const { ns } = await seedExtensions();
  for (let i = 0; i < 3; i += 1) await downloadNs(sql, ns, 'zoo');
  await downloadNs(sql, ns, 'minterm');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const { rows } = await followPages(app, '/v1/extensions?sort=downloads&limit=2');
  assert.deepEqual(
    rows.map((e) => e.id),
    ['zoo', 'minterm', 'alpaca'],
  );
});

test('paginating a tied sort key keeps every row', async () => {
  // Nothing has been downloaded, so all three extensions tie on the sort key
  // and the (namespace, id) tiebreaker alone orders the result.
  const { ns } = await seedExtensions();

  const { rows } = await followPages(app, '/v1/extensions?sort=downloads&limit=1');
  const seen = rows.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(seen, ['alpaca', 'minterm', 'zoo']);
});

test('badge splits into one-fact endpoints that are each far narrower', async () => {
  const { ns } = await seedExtensions();
  await downloadNs(sql, ns, 'zoo');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const svgWidth = (markup) => Number(markup.match(/^<svg[^>]*\bwidth="([\d.]+)"/)[1]);
  const get = async (path) => {
    const r = await request(app).get(path).expect(200);
    assert.match(r.headers['content-type'], /image\/svg\+xml/);
    return r.text ?? r.body.toString('utf8');
  };
  // The renderer emits flat text nodes with escaped content, so the text is
  // captured rather than sanitized out of a matched element. Nested markup now
  // fails the assertion instead of being silently stripped away.
  const texts = (markup) =>
    [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);

  // The left pill names the fact and the right pill is a bare value, so the unit
  // lives in the label and there is no pluralisation to get wrong.
  const version = await get(`/v1/badge/@${ns}/zoo/version`);
  assert.deepEqual(texts(version), ['version', 'v1.0.0']);

  const downloads = await get(`/v1/badge/@${ns}/zoo/downloads`);
  assert.deepEqual(texts(downloads), ['downloads', '1']);

  const license = await get(`/v1/badge/@${ns}/zoo/license`);
  assert.deepEqual(texts(license), ['license', 'MIT']);

  // This is the point of the split: the combined badge is the sum of the three
  // and is much too wide to sit in a README, while each fact alone is not. The
  // download count is set to a realistic figure first, because a badge whose
  // message reads "1 download" flatters the combined width -- the digits and the
  // word "downloads" are most of what makes it long.
  await sql`UPDATE extension_daily_downloads SET total_downloads = 48213
            WHERE namespace = ${ns} AND extension_id = 'zoo'`;
  const combined = await get(`/v1/badge/@${ns}/zoo`);
  const combinedWidth = svgWidth(combined);
  for (const [name, markup] of [
    ['version', version],
    ['downloads', downloads],
    ['license', license],
  ]) {
    assert.ok(
      svgWidth(markup) < combinedWidth / 2,
      `${name} badge is ${svgWidth(markup)}px, not meaningfully narrower than the combined ${combinedWidth}px`,
    );
  }

  // The per-package colour is shared across the set, so three badges for one
  // extension read as a row rather than as three unrelated colours.
  const fillOf = (markup) => markup.match(/<rect x="[\d.]+"[^>]*fill="(#[0-9a-f]{6})"/)[1];
  const fill = fillOf(version);
  assert.equal(fillOf(downloads), fill, 'downloads badge is a different colour');
  assert.equal(fillOf(license), fill, 'license badge is a different colour');
  assert.equal(fillOf(combined), fill, 'combined badge is a different colour');

  // The label is still overridable, and defaults to the fact rather than the id.
  const relabelled = await get(`/v1/badge/@${ns}/zoo/license?label=${encodeURIComponent('terms')}`);
  assert.deepEqual(texts(relabelled), ['terms', 'MIT']);

  // An unknown trailing segment is a 404, not a silent fallback to the combined
  // badge: answering a different question than the one asked is worse than 404.
  const unknown = await request(app).get(`/v1/badge/@${ns}/zoo/maintainer`);
  assert.equal(unknown.status, 404);
  const unknownPkg = await request(app).get(`/v1/badge/@${ns}/nonexistent/version`);
  assert.equal(unknownPkg.status, 404);
});

test('badge renders an SVG with version, downloads, and license', async () => {
  const { ns } = await seedExtensions();
  await downloadNs(sql, ns, 'zoo');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const r = await request(app).get(`/v1/badge/@${ns}/zoo`).expect(200);
  assert.match(r.headers['content-type'], /image\/svg\+xml/);
  const svg = r.text ?? r.body.toString('utf8');
  assert.match(svg, /<svg /);
  assert.match(svg, /zoo/);
  assert.match(svg, /v1\.0\.0/);
  assert.match(svg, /1 download/);
  assert.match(svg, /MIT/);

  const svgWidth = (markup) => Number(markup.match(/^<svg[^>]*\bwidth="([\d.]+)"/)[1]);

  // A viewBox lets the badge scale by re-laying out rather than pixel-doubling,
  // and the font stack leads with the face the widths were measured from.
  assert.equal(svg.match(/viewBox="([^"]+)"/)[1], `0 0 ${svgWidth(svg)} 20`);
  assert.match(svg, /font-family="DejaVu Sans,/);

  // The badge widens to fit its text; a long label is not clipped, and nothing
  // in the markup is given a negative width.
  const longLabel = 'a-really-quite-long-extension-name';
  const wide = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent(longLabel)}`)
    .expect(200);
  const wideSvg = wide.text ?? wide.body.toString('utf8');
  assert.ok(
    svgWidth(wideSvg) > svgWidth(svg),
    `expected a wider badge, got ${svgWidth(wideSvg)} vs ${svgWidth(svg)}`,
  );
  assert.ok(wideSvg.includes(longLabel), 'the label is not truncated');
  for (const [, value] of wideSvg.matchAll(/\bwidth="(-?[\d.]+)"/g)) {
    assert.ok(Number(value) >= 0, `negative width in badge: ${value}`);
  }

  // Pills are sized from glyph advances, so eight wide letters take visibly
  // more room than eight narrow ones and neither is padded to a flat estimate.
  const pillWidth = (markup) =>
    Number(markup.match(/<rect width="([\d.]+)" height="20" fill="#555"/)[1]);
  const wideGlyphs = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent('WWWWMMMM')}`)
    .expect(200);
  const narrow = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent('iiii')}`)
    .expect(200);
  const widePill = pillWidth(wideGlyphs.text ?? wideGlyphs.body.toString('utf8'));
  const narrowPill = pillWidth(narrow.text ?? narrow.body.toString('utf8'));
  assert.ok(widePill > narrowPill * 3, `wide ${widePill} vs narrow ${narrowPill}`);

  // A one-character label still has to sit inside a real gutter, so the
  // padding cannot quietly decay to zero.
  const tiny = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent('i')}`)
    .expect(200);
  assert.ok(
    pillWidth(tiny.text ?? tiny.body.toString('utf8')) >= 16,
    'the label pill keeps its padding',
  );

  // The label is caller-supplied and the badge is sized to fit it, so a long
  // ?label= still has to stop somewhere rather than ask for a huge SVG. The cap
  // is on the label pill; the right-hand pill holds the server's own text.
  const huge = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent('W'.repeat(4000))}`)
    .expect(200);
  const hugeSvg = huge.text ?? huge.body.toString('utf8');
  const hugePill = pillWidth(hugeSvg);
  assert.ok(hugePill > 0 && hugePill <= 320, `runaway label pill is bounded, got ${hugePill}`);
  assert.ok(hugeSvg.length < 4000, 'the response stays small');

  // East Asian glyphs are one em wide, not proportional. Measuring them at the
  // mean ASCII advance under-counts by ~40% and pushes the text out past its own
  // pill, so they get the em instead. Five of them need 55px of text, and the
  // 16px gutter has to be there on top of that.
  const cjk = await request(app)
    .get(`/v1/badge/@${ns}/zoo?label=${encodeURIComponent('扩展工具包')}`)
    .expect(200);
  const cjkPill = pillWidth(cjk.text ?? cjk.body.toString('utf8'));
  assert.ok(
    cjkPill >= 5 * 11 + 16,
    `five full-width glyphs need 55px plus the gutter, got ${cjkPill}`,
  );

  const missing = await request(app).get(`/v1/badge/@${ns}/nonexistent`);
  assert.equal(missing.status, 404);
});

test('badge colour is derived per package, stays put, and stays readable', async () => {
  const { ns } = await seedExtensions();
  const body = (r) => r.text ?? r.body.toString('utf8');
  // The right pill's fill, and the text drawn on top of it. The first <text> is
  // the left pill, whose fill is always white, so the pill colour has to be
  // paired with the second one.
  const paint = (markup) => {
    const fills = [
      ...markup.matchAll(/<rect x="[\d.]+" width="[\d.]+" height="20" fill="#([0-9a-f]{6})"/g),
    ];
    const texts = [...markup.matchAll(/<text x="[\d.]+" y="14" fill="#([0-9a-f]{6})"/g)];
    assert.equal(fills.length, 1, 'expected exactly one right-hand pill');
    assert.equal(texts.length, 2, 'expected both text runs to carry their own fill');
    return { background: `#${fills[0][1]}`, foreground: `#${texts[1][1]}` };
  };
  const luminance = (hex) => {
    const channel = (offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };

  const zoo = body(await request(app).get(`/v1/badge/@${ns}/zoo`).expect(200));
  const alpaca = body(await request(app).get(`/v1/badge/@${ns}/alpaca`).expect(200));

  // Same package, twice: identical bytes. A badge is cached publicly for five
  // minutes, so a per-request colour would make the cached and fresh responses
  // disagree.
  assert.equal(zoo, body(await request(app).get(`/v1/badge/@${ns}/zoo`).expect(200)));

  // The label is caller-supplied, so the colour must not be seeded from it --
  // otherwise anyone could repaint anyone's badge with a query string.
  const relabelled = body(
    await request(app).get(`/v1/badge/@${ns}/zoo?label=something-else`).expect(200),
  );
  assert.equal(paint(relabelled).background, paint(zoo).background, 'colour follows ?label=');

  // Every colour has to clear the WCAG AA threshold against its own text, which
  // is why the fill and the text are chosen together.
  for (const [name, markup] of [
    ['zoo', zoo],
    ['alpaca', alpaca],
  ]) {
    const { background, foreground } = paint(markup);
    const ratio = contrast(background, foreground);
    assert.ok(ratio >= 4.5, `${name} ${background} on ${foreground} is only ${ratio.toFixed(2)}:1`);
  }

  // Packages that share a license must not all come out the same colour, or the
  // derivation is not doing anything. Measured over a sample rather than
  // pairwise: the colour space is finite, so two specific packages can collide by
  // chance, and a test that bet on a particular pair would be flaky.
  const names = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
  ];
  const owner = await sql`SELECT owner_id FROM versions WHERE namespace = ${ns} LIMIT 1`;
  for (const name of names) {
    await sql`INSERT INTO versions (owner_id, namespace, extension_id, version, status, name,
                                   license, description, blob_path, published_at)
               VALUES (${owner[0].owner_id}, ${ns}, ${name}, '1.0.0', 'published', ${name},
                       'MIT', '', ${`badge/${name}.tgz`}, now())`;
  }
  const colours = new Set();
  for (const name of names) {
    const markup = body(await request(app).get(`/v1/badge/@${ns}/${name}`).expect(200));
    assert.match(markup, /MIT/, `${name} is a different licence colour`);
    const { background, foreground } = paint(markup);
    const ratio = contrast(background, foreground);
    assert.ok(ratio >= 4.5, `${name} ${background} on ${foreground} is only ${ratio.toFixed(2)}:1`);
    colours.add(background);
  }
  assert.ok(
    colours.size >= names.length - 2,
    `expected a spread of colours, got ${colours.size} across ${names.length} MIT packages`,
  );
});

test('feed.atom lists the latest publishes as entries', async () => {
  const { ns } = await seedExtensions();

  const r = await request(app).get('/v1/feed.atom').expect(200);
  assert.match(r.headers['content-type'], /application\/atom\+xml/);
  const xml = r.text ?? r.body.toString('utf8');
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  // Entry ids are tag URIs, not feed titles; the feed title is the product name.
  assert.match(xml, /<title>TwextHub/);
  assert.match(xml, /<title>zoo v1\.0\.0<\/title>/);
  assert.match(xml, new RegExp(`tag:twexthub,\\d{4}-\\d{2}-\\d{2}:@${ns}/zoo-1.0.0`));
  assert.match(xml, /<updated>\d{4}-\d{2}-\d{2}T/);
  // one entry per extension, newest publish first
  const entries = xml.match(/<entry>/g) ?? [];
  assert.equal(entries.length, 3);
  const zooPos = xml.indexOf(`@${ns}/zoo-1.0.0`);
  const alpacaPos = xml.indexOf(`@${ns}/alpaca-1.0.0`);
  assert.ok(zooPos < alpacaPos, 'zoo published after alpaca so it comes first');
});
