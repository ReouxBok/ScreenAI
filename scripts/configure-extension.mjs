import fs from 'node:fs';
import path from 'node:path';
import { extensionEnvironment, environmentManifest, environmentModule } from './extension-environments.mjs';

const environment = extensionEnvironment(process.argv[3]);
const target = path.resolve(process.argv[2]);
const manifestPath = path.join(target, 'manifest.json');
const manifest = environmentManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), environment);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(target, 'src/limova/environment.js'), environmentModule(environment));
fs.writeFileSync(path.join(target, 'extension-build.json'), `${JSON.stringify(environment, null, 2)}\n`);
