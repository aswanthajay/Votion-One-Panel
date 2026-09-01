import 'dotenv/config';
import { hasCoreInstallationConfiguration, loadRuntimeConfiguration } from './services/runtimeConfig.js';

loadRuntimeConfiguration();

process.on('uncaughtException', (err: any) => {
  console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT' || err?.code === 'EPIPE' || err?.code === '57P01') {
    return;
  }
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});

if (hasCoreInstallationConfiguration()) {
  await import('./index.js');
} else {
  await import('./installer.js');
}
