// Bundle only the Tabler SVGs used by this offline Electron interface.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const icons = {
  light:'bulb', keyboard:'keyboard', sync:'refresh', settings:'settings-2', cube:'cube',
  top:'layout-board', bottom:'flip-vertical', presets:'bookmark',
  reset:'rotate-clockwise', sliders:'adjustments-horizontal', sun:'sun', moon:'moon', speed:'gauge',
  info:'info-circle', plug:'plug-connected', trash:'trash', plus:'plus', check:'check',
  download:'download', folder:'folder', power:'power', solid:'circle', breathe:'wave-sine',
  wave:'ripple', bar:'chart-bar', cloud:'cloud', vortex:'spiral', mix:'circles', stone:'hexagon',
  laser:'bolt', starry:'sparkles', flowers:'flower', traverse:'arrows-horizontal',
  meteor:'meteor', rain:'cloud-rain', scan:'scan', spread:'arrows-maximize', trigger:'hand-click',
};
const symbols = Object.entries(icons).map(([id,name]) => {
  const svg = fs.readFileSync(path.join(root, 'node_modules/@tabler/icons/icons/outline', name+'.svg'), 'utf8');
  return `<symbol id="i-${id}" viewBox="0 0 24 24">${svg.replace(/^[\s\S]*?<svg[^>]*>/,'').replace(/<\/svg>[\s\S]*$/,'')}</symbol>`;
}).join('\n');
const sprite = `<!-- Tabler Icons, MIT license: node_modules/@tabler/icons/LICENSE -->\n<svg class="icon-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>\n${symbols}\n</defs></svg>`;
const target = path.join(root, 'app/renderer/index.html');
const html = fs.readFileSync(target, 'utf8');
fs.writeFileSync(target, html.replace(/<!-- UI_ICONS -->|<!-- Tabler Icons[\s\S]*?<\/defs><\/svg>/, sprite));
console.log(`Bundled ${Object.keys(icons).length} local Tabler icons`);
