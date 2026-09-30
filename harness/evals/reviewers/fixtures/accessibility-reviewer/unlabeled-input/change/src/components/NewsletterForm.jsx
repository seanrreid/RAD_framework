import { useState } from 'react';

export function NewsletterForm({ onSubscribe }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    onSubscribe({ name, email });
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2>Subscribe to the newsletter</h2>
      <label htmlFor="newsletter-name">Name</label>
      <input
        id="newsletter-name"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <button type="submit">Subscribe to the newsletter</button>
    </form>
  );
}
