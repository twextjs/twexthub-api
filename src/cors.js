const ALLOW_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE';
const ALLOW_HEADERS = 'Authorization,Content-Type';
const MAX_AGE = '86400';

export function makeCors({ allowedOrigins = '*' } = {}) {
  const allowAny = allowedOrigins === '*';
  const origins = allowAny ? null : new Set(allowedOrigins);

  return function cors(req, res, next) {
    if (!allowAny) res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (!origin || (!allowAny && !origins.has(origin))) return next();

    res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);

    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE);
      res.status(204).end();
      return;
    }
    next();
  };
}
