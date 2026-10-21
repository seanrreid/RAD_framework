const NO_DATE_LABEL = 'No date set';

export function formatDay(startsAt) {
  const date = startsAt ? new Date(startsAt) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : NO_DATE_LABEL;
}
