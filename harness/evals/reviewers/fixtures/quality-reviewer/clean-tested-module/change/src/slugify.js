const MAX_SLUG_LENGTH = 60;
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

// Turns a post title into a URL-safe slug. Throws on input that yields no slug.
export function slugify(title) {
  if (typeof title !== 'string') {
    throw new TypeError('title must be a string');
  }
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, '-')
    .replace(EDGE_HYPHENS, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(EDGE_HYPHENS, '');
  if (slug === '') {
    throw new RangeError(`title "${title}" contains no slug-able characters`);
  }
  return slug;
}
