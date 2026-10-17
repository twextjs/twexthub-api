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
      INSERT INTO rate_limit_entries (bucket, window_start, count)
      VALUES (${bucket}, ${windowStart}, 1)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = rate_limit_entries.count + 1
      RETURNING count
    `;
    return Number(row.count);
  }

  async function loginCheck(bucket) {
    const max = limits.loginAttemptsPerWindow;
    const windowMinutes = limits.loginWindowMinutes;
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const existing = await db.rate_limit_entries.findUnique({
      where: { bucket_window_start: { bucket, window_start: windowStart } },
      select: { count: true },
    });
    if (existing && Number(existing.count) >= max) {
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

  const maxWindow = Math.max(
    limits.loginWindowMinutes,
    limits.signupWindowMinutes,
    limits.publishWindowMinutes ?? 60,
    limits.downloadWindowMinutes ?? 5,
  );
  const cleanupInterval = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - maxWindow * 60_000);
      await db.rate_limit_entries.deleteMany({ where: { window_start: { lt: cutoff } } });
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
    stop() {
      clearInterval(cleanupInterval);
    },
  };
}
