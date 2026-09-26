const fs = require('fs');
const c = fs.readFileSync('src/docs/openapi.ts', 'utf-8');
const lines = c.split('\n');

// Line 4744 (index 4743) is "    }," — it closes schemas
// We need to insert "  }," after it to close components
// Then line 4745 (index 4744) is "  security: ..."
lines.splice(4744, 0, '  },');

fs.writeFileSync('src/docs/openapi.ts', lines.join('\n'));
console.log('Fixed.');
