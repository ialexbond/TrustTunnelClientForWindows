export function deobfuscate(value: string): string {
  if (value.startsWith("b64:")) {
    try { return decodeURIComponent(escape(atob(value.slice(4)))); } catch { return value; }
  }
  return value;
}

export function obfuscate(value: string): string {
  return "b64:" + btoa(unescape(encodeURIComponent(value)));
}
