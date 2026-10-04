// The profile fields an account and an organization both carry. The two
// collections validate and write them identically, so the rules live here
// rather than in either route: two copies of a 280-character bio limit is one
// too many to keep in step.

const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_BIO_LENGTH = 280;
const MAX_URL_LENGTH = 400;
const GITHUB_USERNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const URL_FIELDS = ['website', 'avatarUrl', 'bannerUrl'];

// A bare /^https?:\/\// prefix accepts "https://" with no host and anything the
// URL parser would reject, so parse it and check what came back.
function isHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname.length > 0;
}

// One error per field present on the body. An absent field is not an error, so
// the caller can hand a whole request body over and get back only what it got
// wrong.
export function profileFieldErrors(body) {
  const errors = [];
  if (
    body.displayName !== undefined &&
    (typeof body.displayName !== 'string' || body.displayName.length > MAX_DISPLAY_NAME_LENGTH)
  ) {
    errors.push({
      field: 'displayName',
      message: `Must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    });
  }
  if (
    body.bio !== undefined &&
    body.bio !== null &&
    (typeof body.bio !== 'string' || body.bio.length > MAX_BIO_LENGTH)
  ) {
    errors.push({
      field: 'bio',
      message: `Must be a string of at most ${MAX_BIO_LENGTH} characters, or null.`,
    });
  }
  for (const field of URL_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !isHttpUrl(value)) {
      errors.push({
        field,
        message: `Must be an http(s) URL of at most ${MAX_URL_LENGTH} characters, or null to clear.`,
      });
    }
  }
  if (body.github !== undefined && body.github !== null) {
    if (typeof body.github !== 'string' || !GITHUB_USERNAME.test(body.github)) {
      errors.push({ field: 'github', message: 'Must be a GitHub username, or null to clear.' });
    }
  }
  return errors;
}

// The columns to write, for the caller that already knows which fields arrived.
// A null is a value here, not an absence: `bio: null` clears the bio and
// `website: null` drops the link, and the caller cannot tell those apart from an
// omitted field without looking at the body again.
export function profilePatch(body) {
  const patch = {};
  const columns = [];
  const set = (column, value) => {
    patch[column] = value;
    columns.push(column);
  };
  if (body.displayName !== undefined) set('display_name', body.displayName);
  if (body.bio !== undefined) set('bio', body.bio ?? '');
  if (body.website !== undefined) set('website', body.website);
  if (body.github !== undefined) set('github', body.github);
  // A URL is recorded whether or not the profile also has an upload. The upload
  // stays the face of the profile and this is the fallback, so clearing the
  // link later never silently discards a file that is still served, and
  // uploading a file never discards a link.
  if (body.avatarUrl !== undefined) set('avatar_url', body.avatarUrl);
  if (body.bannerUrl !== undefined) set('banner_url', body.bannerUrl);
  return { patch, columns };
}
