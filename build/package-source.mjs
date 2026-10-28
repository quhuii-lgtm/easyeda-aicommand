import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));
const output = path.join(root, 'build/dist');
const archiveName = `easyeda-aicommand-plugin-source_v${manifest.version}.zip`;
const archivePath = path.join(output, archiveName);
const zip = new JSZip();
const excluded = new Set(['.git', 'node_modules', 'dist', 'skills', '__pycache__', '.codex', '.agents']);
const fixtureManifest = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/manifest.json'), 'utf8'));
const fixtureZipFiles = new Set(fixtureManifest.entries
  .filter(entry => entry.fixture.endsWith('.zip'))
  .map(entry => `test/fixtures/${entry.fixture}`));
const sourceFiles = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) { collect(absolute); continue; }
    if (!entry.isFile() || relative === 'SKILL.md' || relative === '.npmrc') continue;
    if (/^(?:\.env(?:\..*)?|.*credentials.*|.*\.log|.*\.jsonl|.*\.tsbuildinfo|.*\.pyc|.*\.eext)$/i.test(entry.name)) continue;
    if (entry.name.toLowerCase().endsWith('.zip') && !fixtureZipFiles.has(relative)) continue;
    const bytes = fs.readFileSync(absolute);
    sourceFiles.push(relative);
    zip.file(`easyeda-aicommand-v${manifest.version}/${relative}`, bytes, { date: new Date('1980-01-01T00:00:00Z') });
  }
}

collect(root);
if (sourceFiles.some(name => name.startsWith('skills/') || name === 'SKILL.md')) throw new Error('Skill content in plugin source');
fs.mkdirSync(output, { recursive: true });
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
fs.writeFileSync(archivePath, bytes, { flag: 'wx' });
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join(output, `SHA256SUMS-plugin-source-v${manifest.version}.txt`), `${digest}  ${archiveName}\n`, { flag: 'wx' });
console.log(JSON.stringify({ archive: archivePath, version: manifest.version, sourceFiles: sourceFiles.length, sha256: digest, containsSkill: false }));
