const fs = require('fs');
const content = fs.readFileSync('src/docs/openapi.ts', 'utf-8');
const pathsMatch = content.match(/paths:\s*\{([\s\S]*?)\n\s*components:/);
if (pathsMatch) {
  const keys = [...pathsMatch[1].matchAll(/\"(\/[^\"]+)\":/g)].map(m => m[1]);
  console.log(keys.join('\n'));
} else {
  console.log('no paths found');
}
