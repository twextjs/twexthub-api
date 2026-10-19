import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { Prisma } from '../prisma/generated/client/index.js';
import { conflict, notFound } from './errors.js';

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
//
// `lookupFn` is the seam a test uses to answer every name with a fixed public
// address, so URL validation keeps its rules without touching live DNS.
export async function resolvePublicWebhookTarget(rawUrl, lookupFn = lookup) {
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
    addresses = await lookupFn(host, { all: true });
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

// The client returns int8 columns as BigInt, and these rows go straight into a
// JSON response, which refuses one. The ids were strings before the conversion
// and clients compare them as strings, so they stay strings.
function withStringId(row) {
  return { ...row, id: row.id.toString() };
}

export class WebhookInputError extends Error {
  constructor(fields) {
    super(fields.map((f) => f.message).join('; '));
    this.name = 'WebhookInputError';
    this.fields = fields;
  }
}

// `resolveTarget` validates a URL the way `create` must -- throwing on anything
// a delivery would refuse. It defaults to the real resolver, which performs live
// DNS; a test injects a deterministic one so creation never depends on the
// network. The delivery worker keeps its own seam on attemptDelivery.
export function makeWebhooks({ db, resolveTarget = assertPublicWebhookUrl }) {
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
      await resolveTarget(input.url);
    } catch (error) {
      throw new WebhookInputError([{ field: 'url', message: error.message }]);
    }
    const secret = newWebhookSecret();
    const row = await db.Webhooks.create({
      data: {
        Namespace: namespace,
        ExtensionId: extensionId,
        Url: input.url,
        Secret: secret,
        Events: input.events,
        Active: input.active !== false,
      },
      select: {
        Id: true,
        Namespace: true,
        ExtensionId: true,
        Url: true,
        Events: true,
        Active: true,
        CreatedAt: true,
      },
    });
    return {
      id: row.Id.toString(),
      namespace: row.Namespace,
      extension_id: row.ExtensionId,
      url: row.Url,
      events: row.Events,
      active: row.Active,
      created_at: row.CreatedAt,
      secret,
    };
  }

  async function list(namespace, extensionId) {
    const rows = await db.Webhooks.findMany({
      where: { Namespace: namespace, ExtensionId: extensionId ?? null },
      select: {
        Id: true,
        Namespace: true,
        ExtensionId: true,
        Url: true,
        Events: true,
        Active: true,
        LastDeliveryStatus: true,
        LastDeliveryAt: true,
        CreatedAt: true,
      },
      orderBy: { CreatedAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.Id.toString(),
      namespace: row.Namespace,
      extension_id: row.ExtensionId,
      url: row.Url,
      events: row.Events,
      active: row.Active,
      last_delivery_status: row.LastDeliveryStatus,
      last_delivery_at: row.LastDeliveryAt,
      created_at: row.CreatedAt,
    }));
  }

  async function remove(namespace, extensionId, id) {
    const { count } = await db.Webhooks.deleteMany({
      where: { Id: id, Namespace: namespace, ExtensionId: extensionId ?? null },
    });
    return count > 0;
  }

  // The hook a delivery log belongs to, or null when the id names one in
  // another collection or namespace. `remove` refuses the same mismatches with
  // the same clause, so an id means the same thing wherever it is passed.
  async function scopedWebhook(namespace, extensionId, id) {
    const row = await db.Webhooks.findFirst({
      where: { Id: id, Namespace: namespace, ExtensionId: extensionId ?? null },
      select: { Id: true },
    });
    return row ?? null;
  }

  // A hook's log, newest first. The body and its signature stay out of it: the
  // payload is the same object and all a UI can render, while the raw bytes and
  // the HMAC over them only mean something to the receiver verifying them.
  async function listDeliveries(namespace, extensionId, webhookId, { limit, cursor, back }) {
    if (!(await scopedWebhook(namespace, extensionId, webhookId))) {
      throw notFound('No such webhook.');
    }
    const keyset = cursor
      ? back
        ? Prisma.sql`AND "Id" > ${cursor.i}`
        : Prisma.sql`AND "Id" < ${cursor.i}`
      : Prisma.empty;
    const rows = await db.$queryRaw`
      SELECT "Id" AS id, "Event" AS event, "Payload" AS payload, "Attempt" AS attempt,
             "MaxAttempts" AS max_attempts, "Status" AS status, "NextAttemptAt" AS next_attempt_at,
             "LastError" AS last_error, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at
      FROM "WebhookDeliveries"
      WHERE "WebhookId" = ${webhookId}
        ${keyset}
      ORDER BY "Id" ${back ? Prisma.raw('ASC') : Prisma.raw('DESC')}
      LIMIT ${limit + 1}
    `;
    return rows.map(withStringId);
  }

  // Queue a delivery's signed body again. This inserts rather than resets the
  // row, so the failed attempt it re-runs stays in the log beside the retry.
  // Body and signature are copied verbatim because they were signed with a
  // secret that does not change.
  async function redeliver(namespace, extensionId, webhookId, deliveryId) {
    return await db.$transaction(async (tx) => {
      // Lock the original row before reading its status, so a worker cannot
      // finish the attempt between the check and the copy.
      const [delivery] = await tx.$queryRaw`
        SELECT d."Status" AS status
        FROM "WebhookDeliveries" d
        JOIN "Webhooks" w ON w."Id" = d."WebhookId"
        WHERE d."Id" = ${deliveryId} AND d."WebhookId" = ${webhookId}
          AND w."Namespace" = ${namespace}
          AND w."ExtensionId" IS NOT DISTINCT FROM ${extensionId}
        FOR UPDATE OF d
      `;
      if (!delivery) throw notFound('No such delivery.');
      // A delivery still queued or in flight is already on its way out; a second
      // copy now would put the receiver through it twice.
      if (delivery.status !== 'delivered' && delivery.status !== 'failed') {
        throw conflict('That delivery has not finished yet.');
      }
      // Body and signature are copied verbatim: they were signed with a secret
      // that does not change, and jsonb round-tripping would reorder the payload.
      const [row] = await tx.$queryRaw`
        INSERT INTO "WebhookDeliveries" ("WebhookId", "Event", "Payload", "Body", "Signature", "MaxAttempts")
        SELECT "WebhookId", "Event", "Payload", "Body", "Signature", "MaxAttempts"
        FROM "WebhookDeliveries" WHERE "Id" = ${deliveryId}
        RETURNING "Id" AS id, "Event" AS event, "Payload" AS payload, "Attempt" AS attempt,
                  "MaxAttempts" AS max_attempts, "Status" AS status, "NextAttemptAt" AS next_attempt_at,
                  "LastError" AS last_error, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at
      `;
      return withStringId(row);
    });
  }

  async function scheduleFor(namespace, extensionId, event, basePayload) {
    try {
      // A namespace-wide hook (extension_id IS NULL) is scheduled alongside the
      // hook registered for this exact extension, so one publish feeds both
      // without either having to be registered twice.
      const hooks = await db.Webhooks.findMany({
        where: {
          Namespace: namespace,
          OR: [{ ExtensionId: extensionId }, { ExtensionId: null }],
          Active: true,
          Events: { has: event },
        },
      });
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
        const signature = signWebhookPayload(hook.Secret, body);
        await db.WebhookDeliveries.create({
          data: {
            WebhookId: hook.Id,
            Event: event,
            Payload: payload,
            Body: body,
            Signature: signature,
          },
        });
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
        await deliverDue(db);
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

  return { create, list, remove, listDeliveries, redeliver, scheduleFor, worker };
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
export async function claimDue(db, now = Date.now(), limit = DELIVERY_BATCH) {
  return await db.$queryRaw`
    WITH claimable AS (
      SELECT d."Id"
      FROM "WebhookDeliveries" d
      WHERE (d."Status" IN ('pending', 'retrying')
             AND (d."NextAttemptAt" IS NULL OR d."NextAttemptAt" <= ${new Date(now).toISOString()}))
         OR (d."Status" = 'delivering' AND d."NextAttemptAt" <= ${new Date(now).toISOString()})
      ORDER BY d."NextAttemptAt" NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "WebhookDeliveries" d
    SET "Status" = 'delivering',
        "NextAttemptAt" = ${new Date(now + DELIVERY_LEASE_MS).toISOString()},
        "UpdatedAt" = now()
    FROM claimable, "Webhooks" w
    WHERE d."Id" = claimable."Id" AND w."Id" = d."WebhookId"
    RETURNING d.*, w."Url" AS "Url", w."Active" AS "Active"
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
export async function deliverDue(db) {
  const results = [];
  for (let sent = 0; sent < DELIVERY_BATCH; sent += 1) {
    const claimedAt = Date.now();
    const [delivery] = await claimDue(db, claimedAt, 1);
    if (!delivery) break;
    // The attempt stamps its own retry deadline off the clock when it finishes,
    // so the claim time is not carried into it.
    results.push(await attemptDelivery(db, delivery));
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
          'X-TwextHub-Event': delivery.Event,
          'X-TwextHub-Signature': delivery.Signature,
          'X-TwextHub-Delivery': String(delivery.Id),
          'Content-Length': Buffer.byteLength(delivery.Body),
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
    req.end(delivery.Body);
  });
}

// `resolveTarget` is a seam for the test receiver, which listens on loopback;
// the worker always resolves and validates for real.
export async function attemptDelivery(db, delivery, resolveTarget = resolvePublicWebhookTarget) {
  const attempt = delivery.Attempt + 1;
  let error = null;
  let ok = false;
  try {
    // The name passed the check at registration, but DNS answers change, so
    // every attempt resolves it again and connects to the address that answer
    // produced.
    const target = await resolveTarget(delivery.Url);
    const res = await postToTarget(target, delivery);
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e.message;
  }

  const retrying = !ok && attempt < delivery.MaxAttempts;
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
  await db.WebhookDeliveries.updateMany({
    where: {
      Id: delivery.Id,
      Status: 'delivering',
      NextAttemptAt: delivery.NextAttemptAt,
    },
    data: {
      Status: ok ? 'delivered' : retrying ? 'retrying' : 'failed',
      Attempt: attempt,
      LastError: ok ? null : error,
      NextAttemptAt: retrying ? new Date(completedAt + delay) : null,
      UpdatedAt: new Date(),
    },
  }).catch(() => {});
  if (ok || retrying) {
    await db.Webhooks.updateMany({
      where: { Id: delivery.WebhookId },
      data: {
        LastDeliveryStatus: ok ? 'ok' : 'error',
        LastDeliveryAt: new Date(),
      },
    }).catch(() => {});
  }
  return { id: delivery.Id, ok, retrying, error };
}
