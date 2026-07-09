const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function formatClock(date: Date) {
  const hour = date.getHours();
  const displayHour = hour % 12 || 12;
  const meridiem = hour >= 12 ? "PM" : "AM";

  return `${pad(displayHour)}:${pad(date.getMinutes())} ${meridiem}`;
}

function isSameLocalDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function formatExactMessageTimestamp(timestampMs: number, nowMs = Date.now()) {
  const date = new Date(timestampMs);

  if (Number.isNaN(date.getTime())) {
    return "Time unavailable";
  }

  const now = new Date(nowMs);
  const time = formatClock(date);

  if (isSameLocalDate(date, now)) {
    return time;
  }

  return `${MONTH_LABELS[date.getMonth()] ?? "Jan"} ${date.getDate()}, ${time}`;
}
