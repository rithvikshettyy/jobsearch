// LOCAL tooling only. This never ships to the Worker — Node built-ins and
// unbounded fetching are used here on purpose and are forbidden inside src/.
//
//   node scripts/resolve.mjs                  # data/companies.txt -> seed.sql
//   node scripts/resolve.mjs --out other.sql  # write somewhere else
//   node scripts/resolve.mjs --fresh          # ignore the probe cache
//   node scripts/resolve.mjs --prune          # also deactivate companies not listed
//   node scripts/resolve.mjs --no-verify-pins # trust `Name = ats:slug` lines without probing them
//
// Also run as `npm run discover-slugs`. Probes Greenhouse, Lever, Ashby and SmartRecruiters.
//
// Input is one company name per line. `#` starts a comment, blank lines are
// skipped, and a line may pin the answer to skip probing entirely:
//
//   Stripe
//   Some Startup = greenhouse:somestartup
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
	const index = argv.indexOf(name);
	return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1];
};

const INPUT = resolvePath(root, option('--in', 'data/companies.txt'));
const OUTPUT = resolvePath(root, option('--out', 'seed.sql'));
const CACHE = join(here, '.resolve-cache.json');
const FRESH = flag('--fresh');
const PRUNE = flag('--prune');
const NO_VERIFY_PINS = flag('--no-verify-pins');

/** Board endpoints, same ones src/sources/ polls. Light payloads only. */
const ATS = [
	{
		id: 'greenhouse',
		url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
		// null = "not a board here"; a number = openings found.
		count: (payload) => (payload && Array.isArray(payload.jobs) ? payload.jobs.length : null),
	},
	{
		id: 'lever',
		url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
		count: (payload) => (Array.isArray(payload) ? payload.length : null),
	},
	{
		id: 'ashby',
		url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
		count: (payload) => (payload && Array.isArray(payload.jobs) ? payload.jobs.length : null),
	},
	{
		id: 'smartrecruiters',
		url: (slug) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`,
		// An unknown company answers 200 with totalFound 0 instead of a 404, so zero means "no usable
		// board" here (the Worker treats an empty first page the same way).
		count: (payload) => (payload && typeof payload.totalFound === 'number' && payload.totalFound > 0 ? payload.totalFound : null),
	},
];

const CONCURRENCY = 6;
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'job-bot-resolver (+https://workers.cloudflare.com)';

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function readNames(path) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new Error(`no input file at ${path} — create it with one company name per line`);
		}
		throw error;
	}

	const entries = [];
	const seen = new Set();

	raw.split(/\r?\n/).forEach((line, index) => {
		const text = line.replace(/#.*$/, '').trim();
		if (text === '') return;

		const pinned = text.match(/^(.*?)\s*=\s*(greenhouse|lever|ashby|smartrecruiters)\s*:\s*(\S+)$/i);
		const name = (pinned ? pinned[1] : text).trim();
		if (name === '') throw new Error(`${path}:${index + 1}: pin without a company name`);

		const key = name.toLowerCase();
		if (seen.has(key)) return; // A duplicate name would only produce a duplicate upsert.
		seen.add(key);

		entries.push({
			name,
			line: index + 1,
			pin: pinned ? { source: pinned[2].toLowerCase(), board: pinned[3] } : null,
		});
	});

	return entries;
}

/** Accents left behind by NFKD decomposition. Escaped, so the source stays ASCII. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Slug guesses for a company name, best first. ATS slugs are near-always the
 * name with punctuation removed, so the collapsed form carries most of the hits
 * and the rest are cheap fallbacks.
 */
function candidateSlugs(name) {
	const flat = name
		.normalize('NFKD')
		.replace(COMBINING_MARKS, '')
		.toLowerCase()
		// Legal suffixes are never part of the slug.
		.replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|bv|ag|pvt|private)\b\.?/g, ' ')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

	const words = flat.split(' ').filter(Boolean);
	if (words.length === 0) return [];

	const out = [words.join(''), words.join('-'), words[0]];
	// "The Foo Company" also lives at "foo".
	if (words[0] === 'the' && words.length > 1) out.push(words.slice(1).join(''), words[1]);

	return [...new Set(out.filter((slug) => slug.length >= 2))];
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

const cache = FRESH ? {} : loadCache();
let cacheDirty = false;

function loadCache() {
	try {
		return JSON.parse(readFileSync(CACHE, 'utf8'));
	} catch {
		return {};
	}
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Job count for `slug` on `ats`, or null when that board does not exist.
 *
 * A 429 or 5xx is retried once — the boards throttle, and a throttled probe
 * looks exactly like a missing board otherwise.
 */
async function probe(ats, slug) {
	const key = `${ats.id}:${slug}`;
	if (key in cache) return cache[key];

	let count = null;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetch(ats.url(slug), {
				headers: { accept: 'application/json', 'user-agent': USER_AGENT },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});

			if (response.status === 429 || response.status >= 500) {
				if (attempt === 0) {
					await sleep(1500);
					continue;
				}
				// Still throttled: leave it uncached so a rerun asks again.
				return null;
			}
			if (!response.ok) break;

			count = ats.count(await response.json());
			break;
		} catch {
			// Timeout or malformed JSON. Both mean "no usable board here".
			break;
		}
	}

	cache[key] = count;
	cacheDirty = true;
	return count;
}

/**
 * First slug that answers on any ATS, preferring one with live openings.
 *
 * A board that returns zero jobs is a real board with nothing posted, so it is
 * kept as a fallback rather than accepted outright — a later candidate with
 * actual openings is the better answer.
 */
async function resolveCompany(name) {
	const slugs = candidateSlugs(name);
	const matches = [];

	for (const slug of slugs) {
		const counts = await Promise.all(ATS.map((ats) => probe(ats, slug)));
		ATS.forEach((ats, index) => {
			if (counts[index] !== null) matches.push({ source: ats.id, board: slug, jobs: counts[index] });
		});
		if (matches.some((match) => match.jobs > 0)) break;
	}

	if (matches.length === 0) return { name, resolved: null, alternates: [] };

	matches.sort((a, b) => b.jobs - a.jobs);
	return { name, resolved: matches[0], alternates: matches.slice(1) };
}

/** Manual semaphore — the boards throttle well before Node runs out of sockets. */
async function mapLimited(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;

	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await fn(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function buildSql(rows, unresolved) {
	const lines = [
		`-- Generated by scripts/resolve.mjs on ${new Date().toISOString()}. Do not hand-edit.`,
		`-- ${rows.length} resolved, ${unresolved.length} unresolved.`,
		`-- Apply with: npx wrangler d1 execute job-bot-db --local --file=seed.sql --yes`,
		'',
	];

	for (const { name, resolved, alternates } of rows) {
		if (alternates.length > 0) {
			// Slug collisions are real (two firms, one obvious name), so the runner-up
			// stays visible for a human to check rather than being silently dropped.
			lines.push(`-- ${name}: also matched ${alternates.map((alt) => `${alt.source}:${alt.board} (${alt.jobs})`).join(', ')}`);
		}
		lines.push(
			`INSERT INTO companies (name, source, board, active) VALUES (${quote(name)}, ${quote(resolved.source)}, ${quote(resolved.board)}, 1)`,
			`  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;`,
		);
	}

	if (unresolved.length > 0) {
		lines.push('', '-- No board found. Pin these in data/companies.txt, e.g. `Name = greenhouse:slug`:');
		for (const { name } of unresolved) lines.push(`--   ${name}`);
	}

	if (PRUNE) {
		// Deactivated rather than deleted, so seen_postings / jobs history survives
		// a board being retired. Only safe when every name resolved — otherwise a
		// throttled probe would switch off a company that is perfectly fine.
		lines.push('');
		if (unresolved.length > 0) {
			lines.push('-- --prune skipped: some names are unresolved, pruning now would deactivate live boards.');
		} else {
			const keep = rows.map((row) => quote(row.name)).join(', ');
			lines.push(`UPDATE companies SET active = 0 WHERE name NOT IN (${keep});`);
		}
	}

	return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const entries = readNames(INPUT);
if (entries.length === 0) throw new Error(`${INPUT} has no company names`);

console.log(`resolving ${entries.length} companies from ${INPUT}`);

const results = await mapLimited(entries, CONCURRENCY, async (entry) => {
	if (entry.pin !== null) {
		if (NO_VERIFY_PINS) {
			console.log(`  ${entry.name} -> ${entry.pin.source}:${entry.pin.board} (pinned, not verified)`);
			return { name: entry.name, resolved: { ...entry.pin, jobs: -1 }, alternates: [] };
		}
		// A pin used to skip probing, so a typo or a retired board went into the seed unnoticed.
		const jobs = await probe(ATS.find((ats) => ats.id === entry.pin.source), entry.pin.board);
		if (jobs === null) {
			console.log(`  ${entry.name} -> PIN DEAD ${entry.pin.source}:${entry.pin.board}`);
			return { name: entry.name, resolved: null, alternates: [] };
		}
		console.log(`  ${entry.name} -> ${entry.pin.source}:${entry.pin.board} (pinned, ${jobs} open)`);
		return { name: entry.name, resolved: { ...entry.pin, jobs }, alternates: [] };
	}

	const result = await resolveCompany(entry.name);
	if (result.resolved === null) console.log(`  ${entry.name} -> NOT FOUND`);
	else console.log(`  ${entry.name} -> ${result.resolved.source}:${result.resolved.board} (${result.resolved.jobs} open)`);
	return result;
});

if (cacheDirty) writeFileSync(CACHE, JSON.stringify(cache, null, '\t'), 'utf8');

const resolved = results.filter((result) => result.resolved !== null);
const unresolved = results.filter((result) => result.resolved === null);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, buildSql(resolved, unresolved), 'utf8');

console.log(`\nwrote ${OUTPUT}: ${resolved.length} resolved, ${unresolved.length} unresolved`);
if (unresolved.length > 0) {
	console.log(`unresolved: ${unresolved.map((result) => result.name).join(', ')}`);
	console.log('pin them in the input file as `Name = greenhouse:slug` and rerun.');
}
if (resolved.length === 0) process.exitCode = 1;
