export const SUPPORTED_NODE_RANGE = ">=26.11.1 <27";

export function supportsNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 26 && (minor > 11 || (minor === 11 && patch >= 1));
}

export function assertSupportedNode(version = process.version) {
  if (!supportsNodeVersion(version)) {
    throw new Error(`This lab supports Node.js ${SUPPORTED_NODE_RANGE}; detected ${version}. For the pinned reproduction, use fnm install 26.11.1 && fnm use 26.11.1.`);
  }
}
