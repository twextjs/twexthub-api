import { minify } from 'terser';

// `twext build` emits one self-contained IIFE, so a standard pass over it is
// safe: Terser mangles bindings but not property names, which keeps block
// opcodes, the "opcode"/"blockType" keys, and the handler method names it
// dispatches to. Function and class names are kept too, since an extension can
// read them back. The pass is capped so a publish cannot hand the server an
// arbitrarily large parse; callers fall back to the original bytes on failure.
export const MINIFY_INPUT_MAX_BYTES = 4 * 1024 * 1024;

export async function minifyCode(buffer, { maxBytes = MINIFY_INPUT_MAX_BYTES } = {}) {
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      error: `Input is ${buffer.length} bytes; the minify limit is ${maxBytes}.`,
    };
  }
  let result;
  try {
    result = await minify(buffer.toString('utf8'), {
      ecma: 2020,
      compress: { passes: 2 },
      mangle: { keep_fnames: true, keep_classnames: true },
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (typeof result.code !== 'string' || result.code.length === 0) {
    return { ok: false, error: 'The minifier produced no output.' };
  }
  // Minifying an already-tiny file can make it longer; there is no point
  // storing that, so the input wins the tie.
  const code = Buffer.from(result.code);
  if (code.length >= buffer.length) return { ok: true, code: buffer, changed: false };
  return { ok: true, code, changed: true };
}
