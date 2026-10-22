export function AgendaList({ events }) {
  return (
    <ol>
      {events.map((e) => (
        <li key={e.id}>{new Date(e.startsAt).toLocaleDateString()}</li>
      ))}
    </ol>
  );
}
