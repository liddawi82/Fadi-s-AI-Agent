// Plain, readable logs. Railway shows these live under the Deploy Logs tab,
// which is where you look when something isn't working.

const stamp = () => new Date().toISOString().slice(11, 19);

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/AC[0-9a-f]{30,}/g, 'AC***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '***-uuid');
}

function emit(stream, tag, args) {
  const parts = args.map((a) =>
    typeof a === 'string' ? redact(a) : redact(JSON.stringify(a))
  );
  stream(`${stamp()} ${tag} ${parts.join(' ')}`);
}

export const log = {
  info: (...args) => emit(console.log, '·', args),
  warn: (...args) => emit(console.warn, '!', args),
  error: (...args) => emit(console.error, '✗', args),
  ok: (...args) => emit(console.log, '✓', args),
};
