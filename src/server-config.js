import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fieldErrors, HttpError } from './errors.js';

/**
 * The settings an admin may change from the running instance, and nothing else.
 *
 * This is an allowlist on purpose. The configuration file also holds the
 * database URL, the API root, the port, and where the blob store lives, and a
 * form is a far easier way to break an instance than a hand-edited file: a wrong
 * database URL is an instance that will not start, and a changed apiRoot is one
 * that answers 404 on every route including the ones the admin is using to fix
 * it. Those stay in the file.
 *
 * A setting is hot when the running process reads it per request, and restart
 * otherwise. The response says which is which rather than pretending a save
 * always takes effect at once.
 */
export const EDITABLE_SETTINGS = [
  {
    key: 'publicBaseUrl',
    type: 'url',
    restartRequired: false,
    label: 'Public base URL',
    help: 'Used to build download, source, and profile image links.',
  },
  {
    key: 'auth.sessionTtlDays',
    type: 'number',
    min: 1,
    max: 365,
    restartRequired: true,
    label: 'Session lifetime (days)',
    help: 'Applies to new sessions; existing ones keep the expiry they were given.',
  },
  {
    key: 'pagination.defaultLimit',
    type: 'number',
    min: 1,
    max: 200,
    restartRequired: false,
    label: 'Default page size',
  },
  {
    key: 'pagination.maxLimit',
    type: 'number',
    min: 1,
    max: 500,
    restartRequired: false,
    label: 'Maximum page size',
  },
  {
    key: 'limits.maxBlobBytes',
    type: 'bytes',
    min: 1024,
    max: 512 * 1024 * 1024,
    restartRequired: false,
    label: 'Maximum release size',
    help: 'Applies to the next publish; versions already stored are unaffected.',
  },
  {
    key: 'limits.maxAccountBlobBytes',
    type: 'bytes',
    min: 1024,
    max: 2 * 1024 * 1024 * 1024,
    restartRequired: false,
    label: 'Maximum stored bytes per account',
  },
  {
    key: 'limits.maxSourceBytes',
    type: 'bytes',
    min: 1024,
    max: 64 * 1024 * 1024,
    restartRequired: true,
    label: 'Maximum source upload',
  },
  {
    key: 'limits.maxProfileImageBytes',
    type: 'bytes',
    min: 1024,
    max: 16 * 1024 * 1024,
    restartRequired: false,
    label: 'Maximum avatar or banner size',
  },
  {
    key: 'compiler.timeoutMs',
    type: 'number',
    min: 1000,
    max: 600000,
    restartRequired: false,
    label: 'Compiler timeout (ms)',
  },
  {
    key: 'compiler.memoryMb',
    type: 'number',
    min: 16,
    max: 4096,
    restartRequired: false,
    label: 'Compiler V8 heap (MB)',
  },
  {
    key: 'compiler.addressSpaceMb',
    type: 'number',
    min: 768,
    max: 16384,
    restartRequired: false,
    label: 'Compiler address space (MB)',
  },
  {
    key: 'compiler.minify',
    type: 'boolean',
    restartRequired: false,
    label: 'Minify compiled extensions',
    help: 'Applies to versions approved or published after the change.',
  },
  {
    key: 'logging.requests',
    type: 'boolean',
    restartRequired: true,
    label: 'Log every request',
  },
  {
    key: 'cors.allowedOrigins',
    type: 'origins',
    restartRequired: true,
    label: 'Allowed origins',
    help: 'A comma separated list, or * for any.',
  },
];

/** null where the platform has no mount table to read. */
// Whether this process is inside a container. The volume requirement is a
// statement about a container's writable layer, which is discarded when the
// instance is recreated; a host install writing to its own filesystem keeps
// the file, so treating a root-mounted path as temporary there would refuse a
// change that is perfectly safe to make.
function inContainer() {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

function readMountInfo() {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
}

function readAt(source, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), source);
}

function writeAt(target, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let node = target;
  for (const part of parts) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[last] = value;
}

/**
 * Whether the configuration file will still be there after the instance is
 * recreated.
 *
 * An admin who edits a file baked into a container image sees the change
 * disappear on the next deploy, and reasonably concludes the setting was never
 * applied. Rather than let that happen quietly, the file has to sit on a volume
 * or a bind mount.
 *
 * On Linux the mount table answers this: the root mount is the image's own
 * writable layer, and anything else that covers the file came from outside the
 * container. Where there is no mount table to read -- a macOS or Windows
 * development checkout -- the filesystem is the machine's own and is taken to
 * be persistent, so the writability check carries the decision alone.
 */
export function configStorage(
  configPath,
  { mountInfo = readMountInfo(), container = inContainer() } = {},
) {
  const resolved = path.resolve(configPath);
  try {
    accessSync(resolved, constants.W_OK);
  } catch {
    return {
      path: resolved,
      writable: false,
      persistent: false,
      reason: 'The configuration file is not writable by this process.',
    };
  }

  // No mount table on this platform; a local filesystem is the machine's own.
  if (mountInfo === null) return { path: resolved, writable: true, persistent: true, reason: null };

  let real;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }

  let deepest = '';
  for (const line of mountInfo.split('\n')) {
    const mountPoint = line.split(' ')[4];
    if (!mountPoint) continue;
    const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
    if (real === mountPoint || real.startsWith(prefix)) {
      if (mountPoint.length > deepest.length) deepest = mountPoint;
    }
  }

  if (container && (deepest === '' || deepest === '/')) {
    return {
      path: resolved,
      writable: true,
      persistent: false,
      reason:
        'The configuration file is inside the container, so a change to it is lost when the instance is recreated. Mount it as a volume to enable this.',
    };
  }
  return { path: resolved, writable: true, persistent: true, reason: null };
}

function coerce(setting, value) {
  // No editable setting is nullable, and the consumers of these keys read them
  // as the type the form advertises: userToObject calls replace on
  // publicBaseUrl, and the pagination and compiler keys are compared as numbers.
  // A null here would pass the form's own type check and then break every
  // request that touched it, so it is a field error like any other bad value.
  if (value === null || value === undefined) {
    throw fieldErrors([{ field: setting.key, message: 'A value is required.' }]);
  }
  switch (setting.type) {
    case 'number':
    case 'bytes': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw fieldErrors([{ field: setting.key, message: 'Must be a whole number.' }]);
      }
      if (setting.min !== undefined && n < setting.min) {
        throw fieldErrors([{ field: setting.key, message: `Must be at least ${setting.min}.` }]);
      }
      if (setting.max !== undefined && n > setting.max) {
        throw fieldErrors([{ field: setting.key, message: `Must be at most ${setting.max}.` }]);
      }
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw fieldErrors([{ field: setting.key, message: 'Must be true or false.' }]);
    case 'origins': {
      const list = Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      if (list.includes('*')) return '*';
      const origins = [];
      for (const origin of list) {
        // The list is compared against the Origin header by string equality, so
        // a value that does not serialize to exactly one origin can never match
        // one. URL.parse answers null for input it cannot parse instead of
        // throwing, and a parsed URL keeps its path and query, so both have to be
        // checked: "not a url" and "https://a.example/x" would otherwise be
        // stored and silently never match anything. Storing the serialized form
        // also drops a trailing slash the header would not carry.
        const parsed = URL.parse(origin);
        if (!parsed || parsed.origin === 'null' || parsed.origin !== origin.replace(/\/$/, '')) {
          throw fieldErrors([
            { field: setting.key, message: `"${origin}" is not an absolute origin.` },
          ]);
        }
        origins.push(parsed.origin);
      }
      return origins;
    }
    case 'url': {
      const text = String(value).trim();
      let parsed;
      try {
        parsed = new URL(text);
      } catch {
        throw fieldErrors([{ field: setting.key, message: 'Must be an absolute URL.' }]);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fieldErrors([{ field: setting.key, message: 'Must be an http or https URL.' }]);
      }
      return text;
    }
    default:
      return value;
  }
}

/** The editable settings as they stand, for the form to render. */
export function editableSettings(config) {
  return EDITABLE_SETTINGS.map((setting) => {
    const value = readAt(config, setting.key);
    return {
      key: setting.key,
      label: setting.label,
      help: setting.help ?? null,
      type: setting.type,
      min: setting.min ?? null,
      max: setting.max ?? null,
      restartRequired: setting.restartRequired,
      value: value === undefined ? null : value,
    };
  });
}

/**
 * Writes the submitted settings to the configuration file and applies the ones
 * the running process reads per request.
 *
 * The file is edited through the YAML document rather than re-serialised from
 * the merged object, so an admin's comments, key order, and anything the merged
 * defaults added stay in the file. Re-serialising would also write every default
 * into the file, which turns a small edit into a large diff an operator has to
 * read before the next deploy.
 */
export function applyServerConfig({ config, configPath, patch, mountInfo, container }) {
  const storage = configStorage(configPath, { mountInfo, container });
  if (!storage.persistent) {
    throw new HttpError(409, { title: 'Configuration is read-only', detail: storage.reason });
  }

  const changes = {};
  const errors = [];
  const document = YAML.parseDocument(readFileSync(storage.path, 'utf8'));
  if (document.contents === null) document.contents = document.createNode({});

  for (const setting of EDITABLE_SETTINGS) {
    if (!Object.hasOwn(patch, setting.key)) continue;
    let value;
    try {
      value = coerce(setting, patch[setting.key]);
    } catch (err) {
      errors.push(...(err.errors ?? []));
      continue;
    }
    const before = readAt(config, setting.key);
    if (before === value) continue;
    // setIn edits the parsed document, which is what keeps the comments and the
    // key order the operator wrote.
    document.setIn(setting.key.split('.'), value);
    changes[setting.key] = { before, after: value };
  }

  if (errors.length) throw fieldErrors(errors);
  if (Object.keys(changes).length === 0) return { changes: {}, restartRequired: [] };

  writeFileSync(storage.path, document.toString(), 'utf8');
  // Applied to the live object too, so a hot setting takes effect on the next
  // request rather than after a restart nobody may be planning.
  for (const [key, change] of Object.entries(changes)) writeAt(config, key, change.after);

  const restartRequired = Object.keys(changes).filter(
    (key) => EDITABLE_SETTINGS.find((setting) => setting.key === key)?.restartRequired,
  );
  return { changes, restartRequired };
}
