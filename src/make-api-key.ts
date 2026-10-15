import { randomBytes } from 'node:crypto';

// Usage: npm run api:key -- <name> [pii]   -> prints an API_KEYS entry to paste into .env
const [name = 'website', flag] = process.argv.slice(2);
console.log(`${name}:${randomBytes(32).toString('hex')}${flag === 'pii' ? ':pii' : ''}`);
