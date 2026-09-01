import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const repos = [
  { owner: 'Fryyyyy', repo: 'zeekr_ev_api' },
  { owner: 'Fryyyyy', repo: 'zeekr_homeassistant' },
];

async function loadRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ioBroker-Zeekr-Adapter',
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

const results = [];
for (const repo of repos) {
  const release = await loadRelease(repo);
  results.push({ repo: `${repo.owner}/${repo.repo}`, tag: release?.tag_name || null, published_at: release?.published_at || null });
}

await writeFile(path.join(repoRoot, 'upstream-releases.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
