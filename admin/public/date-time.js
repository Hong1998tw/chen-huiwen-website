(function (root) {
  "use strict";

  function day(value) {
    const raw = String(value || "").trim();
    const digits = raw.match(/^(20\d{2})(\d{2})(\d{2})$/);
    const separated = raw.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const parts = digits || separated;
    if (!parts) return raw;
    const [, year, month, date] = parts;
    const result = `${year}-${month.padStart(2, "0")}-${date.padStart(2, "0")}`;
    const parsed = new Date(`${result}T00:00:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === result ? result : raw;
  }

  function validDay(value) {
    if (!/^20\d\d-\d\d-\d\d$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }

  function month(value) {
    const raw = String(value || "").trim();
    const parts = raw.match(/^(20\d{2})(\d{2})$/) || raw.match(/^(20\d{2})[-/.](\d{1,2})$/);
    if (!parts) return raw;
    const number = Number(parts[2]);
    return number >= 1 && number <= 12 ? `${parts[1]}-${String(number).padStart(2, "0")}` : raw;
  }

  function time(value) {
    const raw = String(value || "").trim();
    const compact = raw.match(/^(\d{1,2})(\d{2})$/);
    const separated = raw.match(/^(\d{1,2})[:.](\d{1,2})$/);
    const hourOnly = raw.match(/^(\d{1,2})$/);
    const parts = compact || separated || (hourOnly && [raw, hourOnly[1], "00"]);
    if (!parts) return raw;
    const hour = Number(parts[1]), minute = Number(parts[2]);
    return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : raw;
  }

  function dateTime(value) {
    const raw = String(value || "").trim();
    const compact = raw.match(/^(20\d{6})(\d{3,4})$/);
    const spaced = raw.match(/^(20\d{2}(?:\d{4}|[-/.]\d{1,2}[-/.]\d{1,2}))[ T]+(\d{1,2}(?::\d{1,2}|\.\d{1,2})?|\d{3,4})$/);
    const parts = compact || spaced;
    if (!parts) return raw;
    const normalizedDay = day(parts[1]), normalizedTime = time(parts[2]);
    return validDay(normalizedDay) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)
      ? `${normalizedDay}T${normalizedTime}` : raw;
  }

  function period(value) {
    const raw = String(value || "").trim();
    if (/^20\d{2}$/.test(raw)) return raw;
    const normalizedDay = day(raw);
    if (normalizedDay !== raw || /^20\d\d-\d\d-\d\d$/.test(raw)) return normalizedDay;
    return month(raw);
  }

  root.HuiwenDateTime = Object.freeze({ day, month, time, dateTime, period });
})(typeof window === "undefined" ? globalThis : window);
