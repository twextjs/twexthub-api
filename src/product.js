import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const productPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'product.yml');

export const product = YAML.parse(readFileSync(productPath, 'utf8'));
