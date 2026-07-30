const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const SECRET_PATTERNS = [
  {
    pattern: /(\b(?:app[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\b\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s,"'}]+/gi,
    replacement: "$1[REDACTED]",
  },
  { pattern: /(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, replacement: "$1[REDACTED]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED]" },
];

export function redactSensitiveText(value) {
  let text = String(value ?? "").replace(ANSI_PATTERN, "");
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function limitText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated]`;
}
