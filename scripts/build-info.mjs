import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const hash = createHash('sha256');
for (const file of readdirSync('dist/server').filter(file=>file.endsWith('.js')).sort()) hash.update(readFileSync(`dist/server/${file}`));
hash.update(readFileSync('dist/public/index.html'));
writeFileSync('dist/build-info.json',JSON.stringify({id:hash.digest('hex').slice(0,16),builtAt:new Date().toISOString()}));
