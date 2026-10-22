import { tooManyRequests } from './errors.js';

function windowStartFor(now, windowMinutes) {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function makeRateLimiter(db, config) {
  const limits = config.rateLimits;

  function secondsUntilReset(windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const remaining = windowStart.getTime() + windowMinutes * 60_000 - Date.now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  // One statement per bucket increment so concurrent requests cannot lose a
  // count between a read and a write. The upsert has to be raw: the `count`
  // column's new value is derived from its old one, which the typed upsert
  // cannot express without a read-modify-write race.
  async function record(bucket, windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [row] = await db.$queryRaw`
      INSERT INTO "RateLimitEntries" ("Bucket", "WindowStart", "Count")
      VALUES (${bucket}, ${windowStart}, 1)
      ON CONFLICT ("Bucket", "WindowStart")
      DO UPDATE SET "Count" = "RateLimitEntries"."Count" + 1
      RETURNING "Count"
    `;
    return Number(row.Count);
  }

  async function loginCheck(bucket) {
    const max = limits.loginAttemptsPerWindow;
    const windowMinutes = limits.loginWindowMinutes;
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const existing = await db.RateLimitEntries.findUnique({
      where: { Bucket_WindowStart: { Bucket: bucket, WindowStart: windowStart } },
      select: { Count: true },
    });
    if (existing && Number(existing.Count) >= max) {
      throw tooManyRequests(secondsUntilReset(windowMinutes));
    }
    return async () => {
      const count = await record(bucket, windowMinutes);
      if (count > max) throw tooManyRequests(secondsUntilReset(windowMinutes));
    };
  }

  async function signupCheck(bucket) {
    const max = limits.signupsPerIpPerWindow;
    const windowMinutes = limits.signupWindowMinutes;
    const count = await record(bucket, windowMinutes);
    if (count > max) throw tooManyRequests(secondsUntilReset(windowMinutes));
  }

  // Publish and download are throttled with plain count-and-reject windows:
  // every request counts (an attempt that fails validation is still work the
  // server did), and a null limit disables the bucket entirely.
  function windowedCheck(bucket, max, windowMinutes) {
    if (max === null || max === undefined) return async () => {};
    return async () => {
      const count = await record(bucket, windowMinutes);
      if (count > max) throw tooManyRequests(secondsUntilReset(windowMinutes));
    };
  }

  // `??` would swallow a configured null, which is how an operator turns a
  // bucket off, so the defaults only fill in an absent key.
  function publishCheck(bucket) {
    const max = limits.publishPerWindow === undefined ? 30 : limits.publishPerWindow;
    return windowedCheck(bucket, max, limits.publishWindowMinutes ?? 60);
  }

  function downloadCheck(bucket) {
    const max = limits.downloadsPerIpPerWindow === undefined ? 240 : limits.downloadsPerIpPerWindow;
    return windowedCheck(bucket, max, limits.downloadWindowMinutes ?? 5);
  }

  // Reports are counted per reporter rather than per address: the complaint is
  // about somebody else's account, so the rate that matters is the one at which
  // one account can fill the moderators' queue.
  function reportCheck(bucket) {
    const max = limits.reportsPerWindow === undefined ? 10 : limits.reportsPerWindow;
    return windowedCheck(bucket, max, limits.reportsWindowMinutes ?? 60);
  }

  const maxWindow = Math.max(
    limits.loginWindowMinutes,
    limits.signupWindowMinutes,
    limits.publishWindowMinutes ?? 60,
    limits.downloadWindowMinutes ?? 5,
    limits.reportsWindowMinutes ?? 60,
  );
  const cleanupInterval = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - maxWindow * 60_000);
      await db.RateLimitEntries.deleteMany({ where: { WindowStart: { lt: cutoff } } });
    } catch {
      // cleanup errors are non-fatal
    }
  }, 60_000);
  cleanupInterval.unref();

  return {
    loginCheck,
    signupCheck,
    publishCheck,
    downloadCheck,
    reportCheck,
    stop() {
      clearInterval(cleanupInterval);
    },
  };
}
