import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { tooManyRequests } from './errors.js';

// express-rate-limit provides the middleware shape CodeQL's missing-rate-limiting
// query recognizes, while the app's own DB-backed buckets (login, signup,
// publish, download) keep their precise per-account/per-IP windows in
// rate-limit.js. This global limiter is the coarse DoS backstop.
export function makeHttpRateLimiter(config) {
  // The window and cap come from the config, and a config that omits them hands
  // express-rate-limit a NaN: it logs one validation error and runs anyway, with
  // the window clamped to 1ms and the limit silently at its default — a DoS
  // backstop that neither backstops nor says so. Refusing to build the app is
  // the honest failure, and the only way a hand-assembled config (the production
  // loader always fills these from DEFAULTS) gets caught at boot.
  const { routesPerIpPerWindow, routeWindowMinutes } = config.rateLimits ?? {};
  const positive = (v) => Number.isInteger(v) && v > 0;
  if (!positive(routesPerIpPerWindow) || !positive(routeWindowMinutes)) {
    throw new Error(
      'rateLimits.routesPerIpPerWindow and rateLimits.routeWindowMinutes must be positive integers; the coarse per-IP limiter cannot run without them',
    );
  }

  // `rate-limit` v8 uses `ipKeyGenerator` for fixed-width IPv4/IPv6 subnet
  // keying, which fails with a runtime error on unknown value types. `req.ip`
  // is always a string in Express 5, so validate before delegating.
  function ipKey(req) {
    if (typeof req.ip !== 'string' || req.ip.length === 0) {
      return 'unknown-address';
    }
    return ipKeyGenerator(req.ip);
  }

  const middleware = rateLimit({
    windowMs: config.rateLimits.routeWindowMinutes * 60_000,
    limit: config.rateLimits.routesPerIpPerWindow,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: ipKey,
    skip: (req) => {
      const ip = req.ip;
      return (
        typeof ip === 'string' && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
      );
    },
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
      const error = tooManyRequests(retryAfter);
      res.status(error.status).set('Retry-After', String(retryAfter)).json({
        title: error.title,
        status: error.status,
        detail: error.detail,
      });
    },
  });
  return middleware;
}
