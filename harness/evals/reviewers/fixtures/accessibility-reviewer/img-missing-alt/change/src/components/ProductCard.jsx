export function ProductCard({ product, onAddToCart }) {
  return (
    <article className="product-card" aria-labelledby={`product-${product.id}-name`}>
      <img src={product.imageUrl} width="320" height="240" />
      <h3 id={`product-${product.id}-name`}>{product.name}</h3>
      <p className="product-card__price">{product.priceLabel}</p>
      <button type="button" onClick={() => onAddToCart(product.id)}>
        Add {product.name} to cart
      </button>
    </article>
  );
}
