const MAX_NAME_LENGTH = 80;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;

export function validateSignup(body) {
  const errors = [];
  if (body === null || typeof body !== 'object') {
    return ['request body must be a JSON object'];
  }
  if (typeof body.email !== 'string' || !EMAIL_PATTERN.test(body.email)) {
    errors.push('email must be a valid address');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > MAX_NAME_LENGTH) {
    errors.push(`name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return errors;
}

// Server-side handler; `users` is the injected persistence port.
export async function handleSignup(body, users) {
  const errors = validateSignup(body);
  if (errors.length > 0) {
    return { status: HTTP_BAD_REQUEST, body: { errors } };
  }
  const user = await users.create({ email: body.email.toLowerCase(), name: body.name.trim() });
  return { status: HTTP_CREATED, body: { id: user.id } };
}
