const SUBJECT_PREFIX = '[Orders]';

export function buildShippedEmail(users, order) {
  if (!Array.isArray(users)) {
    throw new TypeError('users must be an array');
  }
  if (order === null || typeof order !== 'object') {
    throw new TypeError('order must be an object');
  }
  const customer = users.find((user) => user.id === order.customerId);
  return {
    to: customer.email,
    subject: `${SUBJECT_PREFIX} Order ${order.id} has shipped`,
  };
}
