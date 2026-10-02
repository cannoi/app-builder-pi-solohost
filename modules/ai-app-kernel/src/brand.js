import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const logoPath = path.join(here, '..', 'assets', 'ai-logo.png');
export const logoPublicPath = '/ai/logo.png';
