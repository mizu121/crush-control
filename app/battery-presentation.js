'use strict';
function batteryLabel(battery) {
  if (!Number.isInteger(battery?.percent) || battery.percent < 0 || battery.percent > 100) return 'Battery unavailable';
  const suffix = battery.stale ? ' · last known' : battery.charging === true ? ' · charging' : '';
  return `Battery ${battery.percent}%${suffix}`;
}
module.exports = { batteryLabel };
