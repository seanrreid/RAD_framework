import { useState } from 'react';

export function SaveBar({ draft, onSave }) {
  const [saved, setSaved] = useState(false);

  return (
    <div className="save-bar">
      <span>{saved ? 'All changes saved' : 'Unsaved changes'}</span>
      <button type="button" onClick={() => setSaved(true)}>
        Save draft
      </button>
      <button type="button" onClick={() => onSave(draft)}>
        Publish
      </button>
    </div>
  );
}
