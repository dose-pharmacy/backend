const fs = require('fs');
let c = fs.readFileSync('src/docs/openapi.ts', 'utf-8');
c = c.replace(/    \},\r?\n,\r?\n    "\/health": \{/, '    },\n    "/health": {');
c = c.replace(/    }  },/, '    }\n  },');
fs.writeFileSync('src/docs/openapi.ts', c);
