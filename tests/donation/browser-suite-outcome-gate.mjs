const suiteIds = [
  'browser',
  'min_font',
  'target_size',
  'sticky_navigation',
  'small_q',
  'public_service_audit',
  'runtime_maturity',
  'site_maturity',
  'service_tools',
  'legal_calendar',
  'digital_civic',
  'ux_acceptance',
  'font_rendering',
  'p0',
  'achievement_governance',
  'achievement_list_mobile',
  'election_mode',
  'lifecycle',
  'readiness',
];

const supplied = new Map();
const errors = [];
const raw = process.env.BROWSER_SUITE_OUTCOMES;

for (const [index, rawLine] of (raw ?? '').split(/\r?\n/).entries()) {
  const line = rawLine.trim();
  if (!line) continue;

  const separator = line.indexOf('=');
  if (separator < 1) {
    errors.push(`line ${index + 1}: malformed outcome entry`);
    continue;
  }

  const id = line.slice(0, separator).trim();
  const outcome = line.slice(separator + 1).trim();
  if (supplied.has(id)) {
    errors.push(`${id}: duplicate outcome entry`);
    continue;
  }
  supplied.set(id, outcome);
}

for (const id of suiteIds) {
  if (!supplied.has(id) || supplied.get(id) === '') {
    errors.push(`${id}: missing outcome`);
  } else if (supplied.get(id) !== 'success') {
    errors.push(`${id}: expected success, received ${supplied.get(id)}`);
  }
}

for (const id of supplied.keys()) {
  if (!suiteIds.includes(id)) errors.push(`${id}: unexpected suite outcome`);
}

for (const id of suiteIds) {
  console.log(`${id}: ${supplied.get(id) || '<missing>'}`);
}

if (errors.length > 0) {
  console.error('Browser suite outcome gate failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('All independent browser suites succeeded.');
}
