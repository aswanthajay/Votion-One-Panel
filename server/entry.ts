import 'dotenv/config';
import { hasCoreInstallationConfiguration, loadRuntimeConfiguration } from './services/runtimeConfig.js';

loadRuntimeConfiguration();

if (hasCoreInstallationConfiguration()) {
  await import('./index.js');
} else {
  await import('./installer.js');
}
