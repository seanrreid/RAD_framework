const NO_DATE_LABEL = 'No date set';

function formatDay(startsAt) {
  const date = startsAt ? new Date(startsAt) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : NO_DATE_LABEL;
}

export function CalendarView({ events }) {
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>{formatDay(e.startsAt)}</li>
      ))}
    </ul>
  );
}
