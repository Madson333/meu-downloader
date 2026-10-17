// Copies the interface's static files next to the compiled renderer.js.
import fs from 'node:fs';
import path from 'node:path';

// Compiled to dist/scripts; sources live at the project root.
const root = path.join(__dirname, '..', '..');
const from = path.join(root, 'src', 'renderer');
const to = path.join(root, 'dist', 'src', 'renderer');

fs.mkdirSync(to, { recursive: true });
for (const file of ['index.html', 'styles.css']) fs.copyFileSync(path.join(from, file), path.join(to, file));
