import { createHash } from 'node:crypto';

/** A catalog receives explicit content; it never follows paths or imports code. */
export async function createSkillCatalog(entries) {
  const resources = new Map();
  for (const entry of entries) {
    if (!entry || !['resourceId', 'name', 'description', 'content'].every(key => typeof entry[key] === 'string')) {
      throw new TypeError('Skill entries require resourceId, name, description and content strings');
    }
    if (resources.has(entry.resourceId)) throw new Error(`Duplicate Skill resource: ${entry.resourceId}`);
    resources.set(entry.resourceId, { ...entry, contentHash: createHash('sha256').update(entry.content).digest('hex') });
  }
  return {
    list() {
      return [...resources.values()].map(({ resourceId, name, description, contentHash }) => ({ id: resourceId, name, description, resourceId, contentHash }));
    },
    async read({ resourceId, cursor, maxChars = 2000 }) {
      const entry = resources.get(resourceId);
      const fail = (code, message) => ({ status: 'failed', resourceId, error: { code, message } });
      if (!entry) return fail('unknown_resource', 'Skill resource is not in this catalog');
      if (!Number.isSafeInteger(maxChars) || maxChars < 1) return fail('invalid_page_size', 'maxChars must be a positive safe integer');
      let start = 0;
      if (cursor !== undefined) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (decoded.resourceId !== resourceId || decoded.contentHash !== entry.contentHash || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > entry.content.length) throw new Error();
          start = decoded.offset;
        } catch {
          return fail('invalid_cursor', 'Cursor does not match this resource revision');
        }
      }
      const end = Math.min(start + maxChars, entry.content.length);
      const result = { status: 'completed', resourceId, contentHash: entry.contentHash, text: entry.content.slice(start, end), range: { start, end, total: entry.content.length }, coverage: end < entry.content.length ? 'partial' : 'complete' };
      if (end < entry.content.length) result.nextCursor = Buffer.from(JSON.stringify({ resourceId, contentHash: entry.contentHash, offset: end })).toString('base64url');
      return result;
    },
  };
}
