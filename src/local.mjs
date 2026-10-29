import { createApplication } from './server.mjs';
import { fileURLToPath } from 'node:url';

// This entry point is only for the owner's computer. LAN hosting uses npm start.
const app = createApplication({ dataDir: process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)), disableAuth: true });
app.server.listen(Number(process.env.PORT || 3211), '127.0.0.1', () => console.log('Steady 本地账本：http://127.0.0.1:' + (process.env.PORT || 3211)));
const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
