const EMPTY_PERCENT = 0;

export function discountPercent(items) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (total <= 0) return EMPTY_PERCENT;
  const discounted = items.reduce((sum, item) => sum + item.discount * item.qty, 0);
  return Math.round((discounted / total) * 100);
}

export function CartSummary({ items }) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return (
    <section>
      <h2>Order summary</h2>
      <p>Total: ${total.toFixed(2)}</p>
      <p>You saved {discountPercent(items)}%</p>
    </section>
  );
}
