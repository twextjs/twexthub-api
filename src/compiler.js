import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_BYTES = 16384;

function validatedCompilerPath(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') return null;
  return resolved;
}

// The bundled compiler lives behind @twextjs/twext's package "exports" watch,
// so it cannot be imported by specifier; spawn it by absolute path instead.
// TWEXTHUB_COMPILER names a Node.js script to run in place of it, so the path is
// resolved here: the child runs with the project as its cwd, and the read grant
// below has to be absolute to reach a script outside that directory.
export function compilerCommand(config) {
  const command = config.compiler?.command;
  if (command == null) {
    return path.join(HERE, '..', 'node_modules', '@twextjs', 'twext', 'src', 'cli.js');
  }
  const custom = validatedCompilerPath(command);
  if (!custom) {
    throw new Error(
      'Invalid compiler.command: expected a non-empty .js, .mjs, or .cjs script path.',
    );
  }
  return custom;
}

// Uploaded project code runs in this child, so it gets an allowlist rather than
// the server's environment: the database URL and any other credential the host
// passes in stay here. `twext build` needs nothing else to do its job.
const ALLOWED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'];

export function compilerEnv(env = process.env) {
  const allowed = { NO_COLOR: '1' };
  for (const name of ALLOWED_ENV) {
    if (env[name] !== undefined) allowed[name] = env[name];
  }
  return allowed;
}

function tailWithinBytes(text, limit) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

// Quote a word for a POSIX shell. Single quotes make everything else literal,
// so a path with spaces or quotes arrives as one argv entry, intact.
function shellQuote(word) {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function capLog(text, dropped) {
  const bytes = Buffer.byteLength(text);
  if (dropped === 0 && bytes <= MAX_LOG_BYTES) return text;

  let truncated = dropped;
  while (true) {
    const marker = `… (${truncated} bytes cut) `;
    const tail = tailWithinBytes(text, MAX_LOG_BYTES - Buffer.byteLength(marker));
    const cut = dropped + bytes - Buffer.byteLength(tail);
    if (cut === truncated) return marker + tail;
    truncated = cut;
  }
}

// Compile an extracted project in place. Runs `twext build` in a child process
// with filesystem, address-space, and wall-time limits; returns the compiled bytes and
// the build log. `outFile` is forced so a twext.yml with outputPath cannot move
// the build outside the sandbox directory.
export function compileProject(
  config,
  projectDir,
  { outFile = null, limitShell = '/bin/sh' } = {},
) {
  return new Promise((resolve) => {
    let cli;
    try {
      cli = compilerCommand(config);
    } catch (error) {
      resolve({ ok: false, error: error.message, log: '', durationMs: 0 });
      return;
    }
    const output = outFile ?? path.join(projectDir, 'dist', 'extension.js');
    const memoryMb = config.compiler?.memoryMb ?? 192;
    const addressSpaceMb = config.compiler?.addressSpaceMb ?? 1536;
    const timeoutMs = config.compiler?.timeoutMs ?? 30_000;

    if (
      !Number.isSafeInteger(addressSpaceMb) ||
      addressSpaceMb < 1 ||
      !Number.isSafeInteger(addressSpaceMb * 1024)
    ) {
      resolve({
        ok: false,
        error: 'Invalid compiler address-space limit.',
        log: '',
        durationMs: 0,
      });
      return;
    }

    // The permission model denies reads outside the project and the registry's
    // own dependencies. Node's model does not gate outbound sockets, so egress
    // isolation is left to the deployment boundary (see docs/hosting.md).
    const args = [
      `--max-old-space-size=${memoryMb}`,
      '--permission',
      `--allow-fs-read=${projectDir}`,
      `--allow-fs-read=${path.join(HERE, '..', 'node_modules')}`,
      // Node reads the entrypoint implicitly from 24.2 on, and a substituted
      // compiler lives outside both paths above.
      `--allow-fs-read=${cli}`,
      `--allow-fs-write=${projectDir}`,
      cli,
      'build',
      '-o',
      output,
    ];

    const env = compilerEnv();

    // A build runs untrusted project code, so its output is bounded as it
    // arrives: truncating at the end would still let a chatty compiler grow
    // this process without limit. The tail is kept because that is where the
    // error is.
    let stdout = '';
    let stderr = '';
    let dropped = 0;
    const append = (current, chunk) => {
      const next = current + chunk;
      const bytes = Buffer.byteLength(next);
      if (bytes <= MAX_LOG_BYTES) return next;
      const tail = tailWithinBytes(next, MAX_LOG_BYTES);
      dropped += bytes - Buffer.byteLength(tail);
      return tail;
    };
    const log = () => capLog(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), dropped);
    let started = Date.now();

    // The shell applies RLIMIT_AS before exec. If it cannot set the limit, it
    // exits 125 without starting Node. The shell is replaced by the compiler,
    // so the timeout kills the process whose memory is restricted. The build
    // command is single-quoted into the script rather than passed as further
    // shell arguments, so no path reaches the shell unquoted.
    const command = [process.execPath, ...args].map(shellQuote).join(' ');
    const script = `ulimit -v "$1" || exit 125
[ "$(ulimit -v)" = "$1" ] || exit 125
exec ${command}`;

    const child = spawn(
      limitShell,
      ['-c', script, 'twexthub-build', String(addressSpaceMb * 1024)],
      {
        cwd: projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        error: `Could not start the compiler: ${error.message}`,
        log: log(),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', async (code, signal) => {
      if (code !== 0 || (signal && signal !== 'SIGTERM')) {
        const reason =
          code === 125
            ? 'Could not enforce the compiler address-space limit.'
            : signal
              ? `Terminated by ${signal}${signal === 'SIGKILL' ? ' (timed out or out of memory)' : ''}.`
              : `Compiler exited with code ${code}.`;
        resolve({
          ok: false,
          error: reason,
          log: log(),
          durationMs: Date.now() - started,
        });
        return;
      }
      try {
        const codeBuffer = await readFile(output);
        resolve({
          ok: true,
          code: codeBuffer,
          size: codeBuffer.length,
          log: log(),
          durationMs: Date.now() - started,
        });
      } catch (error) {
        resolve({
          ok: false,
          error: `The compiler reported success but produced no output: ${error.message}`,
          log: log(),
          durationMs: Date.now() - started,
        });
      }
    });
  });
}
