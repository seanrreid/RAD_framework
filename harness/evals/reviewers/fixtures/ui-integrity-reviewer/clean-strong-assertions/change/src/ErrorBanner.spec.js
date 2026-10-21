import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ErrorBanner } from './ErrorBanner.jsx';

function render(error) {
  return renderToStaticMarkup(createElement(ErrorBanner, { error }));
}

test('renders nothing when there is no error', () => {
  assert.equal(render(null), '');
});

test('shows the message and the remediation text', () => {
  const html = render(new Error('Upload failed'));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('Upload failed. Check your connection and try again.'));
});
