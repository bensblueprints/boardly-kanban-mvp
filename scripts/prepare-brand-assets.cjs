// Present the approved PNG artwork in tightly framed SVG viewports.
// The original pixels are embedded unchanged; these are not vector tracings.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../client/public');
const dir = path.join(root, 'landing/brand');
const icon = fs.readFileSync(path.join(dir, 'boardly-icon-source.png')).toString('base64');
const logo = fs.readFileSync(path.join(dir, 'boardly-logo-source.png')).toString('base64');
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="135 137 984 980"><title>Boardly</title><defs><clipPath id="tile"><rect x="135" y="137" width="984" height="980" rx="180"/></clipPath></defs><image width="1254" height="1254" href="data:image/png;base64,${icon}" clip-path="url(#tile)"/></svg>`;
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="192 258 1425 347"><title>Boardly</title><image width="1774" height="887" href="data:image/png;base64,${logo}"/></svg>`;
fs.writeFileSync(path.join(dir, 'boardly-icon-black-v1.svg'), iconSvg);
fs.writeFileSync(path.join(dir, 'boardly-wordmark-black-v1.svg'), logoSvg);
// Keep the old public asset path useful for existing bookmarks and clients.
fs.writeFileSync(path.join(root, 'landing/icon.svg'), iconSvg);
fs.writeFileSync(path.join(root, 'favicon.svg'), iconSvg);
console.log('Prepared Boardly icon, wordmark and favicon from the approved artwork.');
