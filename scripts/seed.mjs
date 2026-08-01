// LOCAL tooling only. This never ships to the Worker — Node built-ins are used
// here on purpose and are forbidden inside src/.
//
//   node scripts/seed.mjs            # seed the local D1
//   node scripts/seed.mjs --remote   # seed the deployed D1
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const remote = process.argv.includes('--remote');

const VALID_SOURCES = new Set(['greenhouse', 'lever', 'ashby']);
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const companies = JSON.parse(readFileSync(join(here, 'companies.json'), 'utf8'));

const statements = companies.map((company, index) => {
	for (const field of ['name', 'source', 'board']) {
		if (typeof company[field] !== 'string' || company[field] === '') {
			throw new Error(`companies.json[${index}]: missing "${field}"`);
		}
	}
	if (!VALID_SOURCES.has(company.source)) {
		throw new Error(`companies.json[${index}]: unknown source "${company.source}"`);
	}
	return (
		`INSERT INTO companies (name, source, board, active) VALUES (${quote(company.name)}, ${quote(company.source)}, ${quote(company.board)}, 1)\n` +
		`  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;`
	);
});

// Anything no longer in companies.json is deactivated rather than deleted, so
// its seen_postings / jobs history survives a board slug being retired.
const keep = companies.map((company) => quote(company.name)).join(', ');
statements.push(`UPDATE companies SET active = 0 WHERE name NOT IN (${keep});`);

const sqlPath = join(here, '.seed.generated.sql');
writeFileSync(sqlPath, `${statements.join('\n')}\n`, 'utf8');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['wrangler', 'd1', 'execute', 'job-bot-db', remote ? '--remote' : '--local', `--file=${sqlPath}`, '--yes'];

console.log(`seeding ${companies.length} companies (${remote ? 'remote' : 'local'})`);
execFileSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
