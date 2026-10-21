export function ErrorBanner({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="error-banner">
      {error.message}. Check your connection and try again.
    </div>
  );
}
