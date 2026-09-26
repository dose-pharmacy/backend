const fs = require('fs');
let c = fs.readFileSync('src/docs/openapi.ts', 'utf-8');

// Replace fancy box-drawing comments with plain ASCII
c = c.replace(/\/\/ ── Purchasing Schemas ────────────────────────────────────────────────/g,
  '// --- Purchasing Schemas ---');
c = c.replace(/\/\/ ── Notification Schemas ─────────────────────────────────────────────/g,
  '// --- Notification Schemas ---');

fs.writeFileSync('src/docs/openapi.ts', c);
console.log('Fixed comment lines.');
