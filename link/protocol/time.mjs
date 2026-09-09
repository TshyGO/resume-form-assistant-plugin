export function isUtcTimestamp(value) {
  if (typeof value !== "string" || !value.endsWith("Z") || value.length < 20) return false;
  const match = value.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const dim = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Boolean(dim) && day >= 1 && day <= dim;
}

function leap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
