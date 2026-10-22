export function CartSummary({ items }) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discounted = items.reduce((sum, item) => sum + item.discount * item.qty, 0);
  const discountPercent = Math.round((discounted / total) * 100);

  return (
    <section>
      <h2>Order summary</h2>
      <p>Total: ${total.toFixed(2)}</p>
      <p>You saved {discountPercent}%</p>
    </section>
  );
}
