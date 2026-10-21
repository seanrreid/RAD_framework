import { useState } from 'react';

export function SaveBar({ draft, onSave }) {
  const [status, setStatus] = useState('idle');

  async function handleSave() {
    setStatus('saving');
    try {
      await onSave(draft);
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      throw err;
    }
  }

  return (
    <div className="save-bar">
      <span>{status === 'saved' ? 'All changes saved' : 'Unsaved changes'}</span>
      <button type="button" onClick={handleSave} disabled={status === 'saving'}>
        Save draft
      </button>
    </div>
  );
}
