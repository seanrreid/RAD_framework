export function DraftToolbar({ draftTitle, onSave, onPublish, onDelete }) {
  return (
    <div className="draft-actions">
      <button type="button" onClick={onSave}>
        Save draft
      </button>
      <button type="button" onClick={onPublish}>
        Publish {draftTitle}
      </button>
      <button type="button" onClick={onDelete} aria-label={`Delete draft ${draftTitle}`}>
        <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16">
          <path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10" />
        </svg>
      </button>
    </div>
  );
}
