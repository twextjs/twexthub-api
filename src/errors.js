export class HttpError extends Error {
  constructor(status, { title, detail, errors, retryAfter, extra } = {}) {
    if (typeof status === 'string') {
      super(status);
      this.status = 500;
      this.title = status;
    } else {
      const defaultTitle = defaultTitles[status] ?? 'Error';
      super(detail ?? title ?? defaultTitle);
      this.status = status;
      this.title = title ?? defaultTitle;
      this.detail = detail;
      this.errors = errors;
      this.retryAfter = retryAfter;
      if (extra) Object.assign(this, extra);
    }
  }

  toJSON() {
    const body = {
      type: 'about:blank',
      title: this.title,
      status: this.status,
    };
    if (this.detail) body.detail = this.detail;
    if (this.errors) body.errors = this.errors;
    if (this.buildLog) body.buildLog = this.buildLog;
    if (this.buildError) body.buildError = this.buildError;
    return body;
  }
}

const defaultTitles = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export function fieldErrors(errors) {
  return new HttpError(422, {
    title: 'Validation Error',
    detail: 'One or more fields failed validation.',
    errors,
  });
}

export function unauthorized(detail = 'Missing or invalid bearer token') {
  return new HttpError(401, { title: 'Unauthorized', detail });
}

export function forbidden(detail = 'You are not allowed to perform this action.') {
  return new HttpError(403, { title: 'Forbidden', detail });
}

export function notFound(detail = 'Not found.') {
  return new HttpError(404, { title: 'Not Found', detail });
}

export function conflict(detail = 'Resource already exists.') {
  return new HttpError(409, { title: 'Conflict', detail });
}

export function payloadTooLarge(detail = 'Request body is too large.') {
  return new HttpError(413, { title: 'Payload Too Large', detail });
}

export function unsupportedMediaType(detail = 'Unsupported media type.') {
  return new HttpError(415, { title: 'Unsupported Media Type', detail });
}

export function tooManyRequests(retryAfterSeconds) {
  return new HttpError(429, {
    title: 'Too Many Requests',
    detail: 'Rate limit exceeded. Try again later.',
    retryAfter: retryAfterSeconds,
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) {
    if (error.retryAfter) res.set('Retry-After', String(Math.ceil(error.retryAfter)));
    return res.status(error.status).type('application/problem+json').json(error.toJSON());
  }
  if (error.type === 'entity.parse.failed') {
    return res
      .status(400)
      .type('application/problem+json')
      .json(new HttpError(400, { title: 'Bad Request', detail: 'Invalid JSON body.' }).toJSON());
  }
  if (error.type === 'entity.too.large') {
    return res
      .status(413)
      .type('application/problem+json')
      .json(new HttpError(413, { title: 'Payload Too Large' }).toJSON());
  }
  const status = error?.status ?? error?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).type('application/problem+json').json(new HttpError(status).toJSON());
  }
  console.error({ message: error?.message, code: error?.code, stack: error?.stack });
  return res
    .status(500)
    .type('application/problem+json')
    .json(new HttpError(500, { title: 'Internal Server Error' }).toJSON());
}
