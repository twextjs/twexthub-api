import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export const WEBHOOK_EVENTS = Object.freeze([
  'version.published',
  'version.yanked',
  'version.deprecated',
  'version.rejected',
  'owners.invited',
  'owners.changed',
  'extension.transferred',
]);

// Index 0 is the initial attempt; the rest are retry delays.
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000];
const POLL_INTERVAL_MS = 15_000;
const DELIVERY_BATCH = 50;
const DELIVERY_TIMEOUT_MS = 10_000;
// How long a claimed row stays 'delivering' before another worker may take it.
// Comfortably past the attempt timeout so a slow-but-live request is never
// duplicated; it only covers a worker that died mid-attempt.
const DELIVERY_LEASE_MS = 60_000;
// Discord's edge is fronted by Cloudflare, which answers a request carrying no
// User-Agent at all with a 403 before the body is read, and other protected
// hosts do the same. Node does not send one on its own.
const USER_AGENT = 'TwextHub-Webhooks';

function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 192 && b === 168) return true;
    // Carrier-grade NAT and the benchmarking range are not RFC1918, but both
    // sit inside networks an operator runs for internal services, so a
    // delivery aimed at either is still an SSRF attempt.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return a >= 224; // multicast and reserved
  }
  if (version !== 6) return true;
  const norm = ip.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  // Fail closed on v4-mapped addresses; the embedded v4 may be private.
  if (norm.includes(':ffff:')) return true;
  const first = norm.split(':')[0];
  if (first.startsWith('fc') || first.startsWith('fd')) return true; // unique local fc00::/7
  if (first.startsWith('fe')) return true; // link-local fe80::/10 and reserved
  if (first === '2002' || first === '64') return true; // deprecated 6to4, nat64
  if (norm.startsWith('2001:0:')) return true; // teredo
  return false;
}

// Validate a webhook URL and return it together with the address it resolved
// to. The address is what a delivery connects to: resolving the name and then
// connecting by name would leave room for a second answer to point somewhere
// else, so callers carry this one through instead of the name.
export async function resolvePublicWebhookTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL.');
  }
  // Private destinations are already refused, so there is no local receiver for
  // plain http to serve: the scheme can be https and nothing else.
  if (url.protocol !== 'https:') {
    throw new Error('Webhook URL must use https.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') {
    throw new Error('Localhost is not a valid webhook target.');
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error('Webhook URL must resolve to a public (non-private) address.');
    }
    return { url, address: host, family: isIP(host) };
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('Webhook URL host could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Webhook URL must resolve to a public (non-private) address.');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function assertPublicWebhookUrl(rawUrl) {
  return (await resolvePublicWebhookTarget(rawUrl)).url;
}

export function newWebhookSecret() {
  return randomBytes(24).toString('base64url');
}

export function signWebhookPayload(secret, body) {
  // The secret is 24 random bytes from newWebhookSecret, so it is used as the
  // HMAC key directly; deriving it first would only slow every delivery down.
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function isValidWebhookEvent(event) {
  return typeof event === 'string' && WEBHOOK_EVENTS.includes(event);
}

// One line per event, in the same register as the notification messages in
// notify.js. A namespace is at most 40 characters and an extension id at most
// 64, so the longest line here stays well inside Discord's 2000 character
// ceiling on `content`.
export function renderWebhookMessage(event, namespace, id, payload) {
  const ref = `@${namespace}/${id}`;
  switch (event) {
    case 'version.published':
      return `${ref} ${payload.version} was published.`;
    case 'version.yanked':
      return `${ref} ${payload.version} was yanked.`;
    case 'version.deprecated':
      return `${ref} ${payload.version} was deprecated.`;
    case 'version.rejected':
      return `${ref} ${payload.version} was rejected.`;
    case 'owners.invited':
      return payload.withdrawn
        ? `${payload.withdrawn} is no longer invited to own ${ref}.`
        : `${payload.invited} was invited to own ${ref}.`;
    case 'owners.changed':
      return payload.added
        ? `${payload.added} was added as an owner of ${ref}.`
        : `${payload.removed} was removed as an owner of ${ref}.`;
    case 'extension.transferred':
      return `Moved from @${payload.from}/${payload.id} to @${payload.to}/${payload.id}.`;
    default:
      throw new Error(`No message rendered for event ${event}.`);
  }
}

export class WebhookInputError extends Error {
  constructor(fields) {
    super(fields.map((f) => f.message).join('; '));
    this.name = 'WebhookInputError';
    this.fields = fields;
  }
}

export function makeWebhooks({ sql }) {
  // One hook per extension, or one for a whole namespace when extensionId is
  // null. `IS NOT DISTINCT FROM` matches null to null, so the per-extension and
  // per-organization queries are the same query with a different argument
  // rather than two that could drift apart.
  async function create(namespace, extensionId, input) {
    const errors = [];
    if (
      !Array.isArray(input.events) ||
      input.events.length === 0 ||
      !input.events.every(isValidWebhookEvent)
    ) {
      errors.push({
        field: 'events',
        message: 'Must be a non-empty array of supported events.',
      });
    }
    if (typeof input.url !== 'string' || input.url.length === 0) {
      errors.push({ field: 'url', message: 'URL is required.' });
    }
    if (errors.length > 0) throw new WebhookInputError(errors);
    try {
      await assertPublicWebhookUrl(input.url);
    } catch (error) {
      throw new WebhookInputError([{ field: 'url', message: error.message }]);
    }
    const secret = newWebhookSecret();
    const [row] = await sql`
      INSERT INTO webhooks (namespace, extension_id, url, secret, events, active)
      VALUES (${namespace}, ${extensionId}, ${input.url}, ${secret},
              ${input.events}, ${input.active !== false})
      RETURNING id, namespace, extension_id, url, events, active, created_at
    `;
    return { ...row, secret };
  }

  async function list(namespace, extensionId) {
    return await sql`
      SELECT id, namespace, extension_id, url, events, active,
             last_delivery_status, last_delivery_at, created_at
      FROM webhooks
      WHERE namespace = ${namespace} AND extension_id IS NOT DISTINCT FROM ${extensionId}
      ORDER BY created_at DESC
    `;
  }

  async function remove(namespace, extensionId, id) {
    const [deleted] = await sql`
      DELETE FROM webhooks
      WHERE id = ${id} AND namespace = ${namespace}
        AND extension_id IS NOT DISTINCT FROM ${extensionId}
      RETURNING 1
    `;
    return Boolean(deleted);
  }

  async function scheduleFor(namespace, extensionId, event, basePayload) {
    try {
      // A namespace-wide hook (extension_id IS NULL) is scheduled alongside the
      // hook registered for this exact extension, so one publish feeds both
      // without either having to be registered twice.
      const hooks = await sql`
        SELECT * FROM webhooks
        WHERE namespace = ${namespace}
          AND (extension_id = ${extensionId} OR extension_id IS NULL)
          AND active AND ${event} = ANY (events)
      `;
      for (const hook of hooks) {
        const message = renderWebhookMessage(event, namespace, extensionId, basePayload);
        const payload = {
          event,
          namespace,
          id: extensionId,
          ...basePayload,
          message,
          // A Discord endpoint reads `content` and a Slack one reads `text`;
          // both ignore every other key, so repeating the line under each name
          // is what lets either accept a delivery unmodified. Nothing here
          // inspects the destination -- the hub still does not know which
          // provider a URL points at.
          content: message,
          text: message,
          // A namespace may be `everyone` or `here`, and the message opens with
          // @namespace, so Discord would read one namespace as a mass ping. It
          // honours an empty parse list, and Slack ignores the key.
          allowed_mentions: { parse: [] },
        };
        // Sign these exact bytes and store them with the delivery: jsonb
        // round-trips reorder keys, so re-serializing at delivery time would
        // produce a body that no longer matches the signature.
        const body = JSON.stringify(payload);
        const signature = signWebhookPayload(hook.secret, body);
        await sql`
          INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
          VALUES (${hook.id}, ${event}, ${sql.json(payload)}, ${body}, ${signature})
        `;
      }
    } catch (error) {
      console.error('webhook scheduling failed:', error);
    }
  }

  function worker() {
    let timer = null;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await deliverDue(sql);
      } catch (error) {
        console.error('webhook delivery worker failed:', error);
      } finally {
        running = false;
      }
    };
    return {
      start() {
        timer = setInterval(tick, POLL_INTERVAL_MS);
        timer.unref?.();
        void tick();
        return this;
      },
      async stop() {
        if (timer) clearInterval(timer);
        while (running) await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
  }

  return { create, list, remove, scheduleFor, worker };
}

// Take ownership of the deliveries that are due, up to a batch. Returns them
// with the webhook's url attached, already flipped to 'delivering'.
//
// Selecting due rows and only then updating them left two windows for a second
// worker -- a second hub process, or the next poll of this one while an attempt
// is still in flight -- to read the same row and POST the same body twice. The
// claim takes the rows under FOR UPDATE SKIP LOCKED and parks them as
// 'delivering' with the lease in next_attempt_at, so a concurrent claim skips
// them and a worker that dies mid-attempt has its rows picked up once the lease
// runs out.
export async function claimDue(sql, now = Date.now(), limit = DELIVERY_BATCH) {
  return await sql`
    WITH claimable AS (
      SELECT d.id
      FROM webhook_deliveries d
      WHERE (d.status IN ('pending', 'retrying')
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${new Date(now).toISOString()}))
         OR (d.status = 'delivering' AND d.next_attempt_at <= ${new Date(now).toISOString()})
      ORDER BY d.next_attempt_at NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE webhook_deliveries d
    SET status = 'delivering',
        next_attempt_at = ${new Date(now + DELIVERY_LEASE_MS).toISOString()},
        updated_at = now()
    FROM claimable, webhooks w
    WHERE d.id = claimable.id AND w.id = d.webhook_id
    RETURNING d.*, w.url, w.active
  `;
}

// Deliver what is due, up to a batch, claiming each row immediately before its
// attempt rather than claiming the batch up front.
//
// One claim for the whole batch starts every lease in it at the same instant,
// and the attempts then run one at a time at up to DELIVERY_TIMEOUT_MS each. A
// full batch therefore outlives DELIVERY_LEASE_MS several times over, and the
// rows at the tail of it become re-claimable by a peer -- or by this worker's own
// next poll -- while this pass is still working towards them, so the same body
// would be POSTed twice. Claiming one row at a time keeps every lease fresh for
// the whole of its own attempt.
export async function deliverDue(sql) {
  const results = [];
  for (let sent = 0; sent < DELIVERY_BATCH; sent += 1) {
    const claimedAt = Date.now();
    const [delivery] = await claimDue(sql, claimedAt, 1);
    if (!delivery) break;
    // The attempt stamps its own retry deadline off the clock when it finishes,
    // so the claim time is not carried into it.
    results.push(await attemptDelivery(sql, delivery));
  }
  return results;
}

// POST the body to an address that has already been checked. The socket is
// pinned with `lookup`, so the request goes to the address the check approved
// and TLS still validates the hostname it was registered under.
function postToTarget(target, delivery) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      target.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-TwextHub-Event': delivery.event,
          'X-TwextHub-Signature': delivery.signature,
          'X-TwextHub-Delivery': String(delivery.id),
          'Content-Length': Buffer.byteLength(delivery.body),
        },
        // Undefined outside the test receiver, which supplies the CA for its
        // self-signed certificate; the default trust store applies otherwise.
        ca: target.ca,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      },
    );
    req.setTimeout(DELIVERY_TIMEOUT_MS, () => {
      req.destroy(new Error(`Delivery timed out after ${DELIVERY_TIMEOUT_MS} ms.`));
    });
    req.on('error', reject);
    req.end(delivery.body);
  });
}

// `resolveTarget` is a seam for the test receiver, which listens on loopback;
// the worker always resolves and validates for real.
export async function attemptDelivery(sql, delivery, resolveTarget = resolvePublicWebhookTarget) {
  const attempt = delivery.attempt + 1;
  let error = null;
  let ok = false;
  try {
    // The name passed the check at registration, but DNS answers change, so
    // every attempt resolves it again and connects to the address that answer
    // produced.
    const target = await resolveTarget(delivery.url);
    const res = await postToTarget(target, delivery);
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e.message;
  }

  const retrying = !ok && attempt < delivery.max_attempts;
  const delay = ok ? 0 : (RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1));
  // Read the clock here, where the attempt is over, rather than reusing the
  // claim's: the delay is a wait that starts when the attempt ends. An attempt
  // can take up to DELIVERY_TIMEOUT_MS, so a deadline measured from the claim
  // lands before a slow attempt has finished -- a first retry waits 5s while the
  // attempt before it may have spent 10s, which leaves the row already due the
  // moment it is written and spends the backoff on nothing.
  const completedAt = Date.now();
  // Only the claim holder writes the outcome. The lease deadline the claim
  // stamped is the holder's proof: if the lease ran out and a peer re-claimed
  // the row, its deadline has moved on, so a late result from the original
  // attempt is dropped instead of overwriting the newer attempt's work.
  await sql`
    UPDATE webhook_deliveries
    SET status = ${ok ? 'delivered' : retrying ? 'retrying' : 'failed'},
        attempt = ${attempt},
        last_error = ${ok ? null : error},
        next_attempt_at = ${retrying ? new Date(completedAt + delay).toISOString() : null},
        updated_at = now()
    WHERE id = ${delivery.id}
      AND status = 'delivering'
      AND next_attempt_at = ${delivery.next_attempt_at}
  `.catch(() => {});
  if (ok || retrying) {
    await sql`
      UPDATE webhooks
      SET last_delivery_status = ${ok ? 'ok' : 'error'},
          last_delivery_at = now()
      WHERE id = ${delivery.webhook_id}
    `.catch(() => {});
  }
  return { id: delivery.id, ok, retrying, error };
}
