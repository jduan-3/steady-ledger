import { createApplication } from './server.mjs';
import { fileURLToPath } from 'node:url';

// A separate, loopback-only workspace keeps demos away from the real ledger.
const dataDir = fileURLToPath(new URL('../work/preview-data/', import.meta.url));
const app = createApplication({ dataDir, disableAuth: true });
app.server.listen(3211, '127.0.0.1', () => console.log('持衡 Steady 演示预览：http://127.0.0.1:3211\n独立预览数据库，仅本机访问；正式使用请运行 npm start。'));
const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
