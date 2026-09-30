// Volume discount: orders at or above the threshold get the discount rate.
const BULK_QUANTITY_THRESHOLD = 10;
const BULK_DISCOUNT_RATE = 0.15;
const CENTS_PER_DOLLAR = 100;

export function orderTotalCents(unitPriceCents, quantity) {
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new RangeError('unitPriceCents must be a non-negative integer');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError('quantity must be a positive integer');
  }
  const subtotal = unitPriceCents * quantity;
  const discount = quantity >= BULK_QUANTITY_THRESHOLD ? subtotal * BULK_DISCOUNT_RATE : 0;
  return Math.round(subtotal - discount);
}

export function formatDollars(cents) {
  if (!Number.isInteger(cents)) {
    throw new RangeError('cents must be an integer');
  }
  return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
}
