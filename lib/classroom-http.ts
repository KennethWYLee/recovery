// RFC 9110 sections 8.8.3.2 and 13.1.2 require weak comparison for If-None-Match.
const ENTITY_TAG_LIST = /^[ \t]*(?:(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*)?(?:,[ \t]*(?:(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"[ \t]*)?)*$/;

export function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  const value = header?.trim();
  if (value === "*") return true;
  if (!value || !ENTITY_TAG_LIST.test(value)) return false;
  const current = etag.replace(/^W\//, "");
  return [...value.matchAll(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g)]
    .some(([candidate]) => candidate.replace(/^W\//, "") === current);
}
