import { tooManyRequests } from './errors.js';

function windowStartFor(now, windowMinutes) {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function makeRateLimiter(sql, config) {
  const limits = config.rateLimits;

  function secondsUntilReset(windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const remaining = windowStart.getTime() + windowMinutes * 60_000 - Date.now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  async function record(bucket, windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [{ count }] = await sql`
      INSERT INTO rate_limit_entries (bucket, window_start, count)
      VALUES (${bucket}, ${windowStart}, 1)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = rate_limit_entries.count + 1
      RETURNING count
    `;
    return Number(count);
  }

  async function loginCheck(bucket) {
    const max = limits.loginAttemptsPerWindow;
    const windowMinutes = limits.loginWindowMinutes;
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [existing] = await sql`
      SELECT count FROM rate_limit_entries
      WHERE bucket = ${bucket} AND window_start = ${windowStart}
    `;
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
      await sql`DELETE FROM rate_limit_entries WHERE window_start < ${cutoff}`;
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
