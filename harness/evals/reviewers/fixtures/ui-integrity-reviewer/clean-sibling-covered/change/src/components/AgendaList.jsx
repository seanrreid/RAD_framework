import { formatDay } from './format-day.js';

export function AgendaList({ events }) {
  return (
    <ol>
      {events.map((e) => (
        <li key={e.id}>{formatDay(e.startsAt)}</li>
      ))}
    </ol>
  );
}
