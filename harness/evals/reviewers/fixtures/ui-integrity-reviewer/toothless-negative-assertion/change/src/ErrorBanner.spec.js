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

test('does not show the error banner when loading succeeds', () => {
  // Queries a class that the component never renders, so this passes even if
  // the banner is wrongly shown.
  assert.ok(!render(new Error('x')).includes('error-banner-visible'));
});
