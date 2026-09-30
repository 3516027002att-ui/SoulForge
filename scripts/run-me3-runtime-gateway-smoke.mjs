import { runDesktopSmoke } from './desktop-test-build.mjs';
process.exit(await runDesktopSmoke('gateway', 'me3RuntimeGatewaySmoke.js'));
