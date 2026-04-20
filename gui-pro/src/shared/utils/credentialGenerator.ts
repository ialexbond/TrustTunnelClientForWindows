/**
 * Credential generator utilities.
 * Uses crypto.getRandomValues() for secure randomness — never Math.random().
 * Charset constraints match the VPN form onChange filters in AddUserForm and UsersSection.
 */

const ADJECTIVES = [
  "bold", "bright", "calm", "cool", "dark", "fast", "free", "gold",
  "hard", "keen", "kind", "lazy", "lean", "loud", "mild", "neat",
  "nice", "pure", "rare", "rich", "safe", "slim", "soft", "sure",
  "tall", "true", "warm", "wide", "wise", "swift",
];

const NOUNS = [
  "bear", "bird", "bull", "cat", "crow", "deer", "dove", "duck",
  "eagle", "elk", "fish", "fox", "frog", "hawk", "hare", "hawk",
  "kite", "lion", "lynx", "mole", "moth", "mule", "owl", "pike",
  "puma", "raven", "seal", "stag", "swan", "wolf",
];

const PASSWORD_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
const PASSWORD_LENGTH = 16;

/** Returns a secure random integer in [0, max). */
function secureRandInt(max: number): number {
  if (!crypto?.getRandomValues) {
    throw new Error("Secure random not available");
  }
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

/**
 * Generates a readable VPN username: adjective-noun with optional 2-digit suffix.
 * Result matches charset: a-zA-Z0-9._- (VPN-safe).
 * Examples: "swift-fox", "bold-eagle42"
 */
export function generateUsername(): string {
  const adj = ADJECTIVES[secureRandInt(ADJECTIVES.length)];
  const noun = NOUNS[secureRandInt(NOUNS.length)];
  const addSuffix = secureRandInt(2) === 0;
  const suffix = addSuffix ? String(secureRandInt(90) + 10) : "";
  return `${adj}-${noun}${suffix}`;
}

/**
 * Generates a strong random password of 16 characters.
 * Charset: a-zA-Z0-9!@#$%^&* — safe subset allowed by UsersSection onChange filter.
 */
export function generatePassword(): string {
  const chars: string[] = [];
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    chars.push(PASSWORD_CHARSET[secureRandInt(PASSWORD_CHARSET.length)]);
  }
  return chars.join("");
}
