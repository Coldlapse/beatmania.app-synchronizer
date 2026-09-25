// tsc 는 .ts 만 옮긴다. 화면의 html·css 는 여기서 dist 로 복사한다.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'src/renderer';
const out = 'dist/renderer';
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith('.html') || f.endsWith('.css')) cpSync(join(src, f), join(out, f));
}
