export function CalendarView({ events }) {
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>{new Date(e.startsAt).toLocaleDateString()}</li>
      ))}
    </ul>
  );
}
