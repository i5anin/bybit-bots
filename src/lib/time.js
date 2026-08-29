// Наработка в человекочитаемом виде: 3д 4ч 05м, 12м 30с.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) return `${days}д ${hours}ч ${pad(minutes)}м`;
  if (hours > 0) return `${hours}ч ${pad(minutes)}м`;
  if (minutes > 0) return `${minutes}м ${pad(secs)}с`;
  return `${secs}с`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}
