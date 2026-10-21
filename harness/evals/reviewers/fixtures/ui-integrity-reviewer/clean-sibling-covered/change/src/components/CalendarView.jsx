import { formatDay } from './format-day.js';

export function CalendarView({ events }) {
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>{formatDay(e.startsAt)}</li>
      ))}
    </ul>
  );
}
