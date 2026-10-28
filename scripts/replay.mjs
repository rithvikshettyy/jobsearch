// LOCAL tooling only (Node built-ins are fine here, never in src/).
//
// Replays ONE full sharding cycle against live boards, offline from D1: every
// posting is treated as unseen, so the funnel is what the bot would see if the
// whole pool came up once. Runs the OLD pipeline (git HEAD) and the NEW one over
// the same fetched data, so the two columns differ only by code.
//
//   node scripts/replay.mjs                       # pool from seed.sql
//   node scripts/replay.mjs --seed seed.sql --seed seed.proposed.sql
//   node scripts/replay.mjs --old-ref HEAD~0      # which commit is "before"
//   node scripts/replay.mjs --json out.json
//
// ATS boards only (greenhouse, lever, ashby): the keyed aggregators need
// secrets and add nothing to a filter comparison.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const all = (name) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));
const one = (name, fallback) => all(name)[0] ?? fallback;

const seeds = all('--seed').length > 0 ? all('--seed') : ['seed.sql'];
const oldRef = one('--old-ref', 'HEAD');
const jsonOut = one('--json', null);
const CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Bundle OLD (from git) and NEW (working tree) into importable modules.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'job-bot-replay-'));
const oldSrc = join(work, 'old', 'src');
mkdirSync(oldSrc, { recursive: true });
for (const file of ['filters.ts', 'config.ts', 'dedupe.ts', 'types.ts']) {
	const body = execFileSync('git', ['show', `${oldRef}:src/${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
	writeFileSync(join(oldSrc, file), body);
}
writeFileSync(join(oldSrc, 'entry.ts'), `export * from './filters';\nexport * from './config';\nexport * from './dedupe';\n`);

const newEntry = join(work, 'new-entry.ts');
const rootPosix = root.replace(/\\/g, '/');
writeFileSync(
	newEntry,
	[
		`export * from '${rootPosix}/src/filters';`,
		`export * from '${rootPosix}/src/config';`,
		`export * from '${rootPosix}/src/dedupe';`,
		`export * from '${rootPosix}/src/pipeline';`,
		`export { getSource } from '${rootPosix}/src/sources/index';`,
	].join('\n'),
);

async function bundle(entry, name) {
	const outfile = join(work, `${name}.mjs`);
	await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
	return import(pathToFileURL(outfile).href);
}

const OLD = await bundle(join(oldSrc, 'entry.ts'), 'old');
const NEW = await bundle(newEntry, 'new');

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------
function readPool(path) {
	const sql = readFileSync(resolve(root, path), 'utf8');
	const rows = [...sql.matchAll(/VALUES \('([^']+)', '([^']+)', '([^']+)', 1\)/g)];
	return rows.map((m, i) => ({ id: i + 1, name: m[1], source: m[2], board: m[3], tier: 2 }));
}

const pool = [];
const names = new Set();
for (const seed of seeds) {
	for (const company of readPool(seed)) {
		if (names.has(company.name)) continue;
		names.add(company.name);
		pool.push({ ...company, id: pool.length + 1 });
	}
}

const core = JSON.parse(readFileSync(join(here, 'companies.json'), 'utf8')).map((c) => c.name);

// ---------------------------------------------------------------------------
// Fetch once, replay twice
// ---------------------------------------------------------------------------
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (next < items.length) {
				const index = next++;
				out[index] = await fn(items[index], index);
			}
		}),
	);
	return out;
}

const now = Date.now();
const lists = new Map();
let failures = 0;

console.error(`fetching ${pool.length} boards...`);
await mapLimit(pool, CONCURRENCY, async (company) => {
	try {
		lists.set(company.name, await NEW.getSource(company.source).fetchJobs(company, {}));
	} catch (error) {
		failures += 1;
		lists.set(company.name, []);
		console.error(`  ${company.name}: ${error instanceof Error ? error.message : error}`);
	}
});

// Old light gate = what detailCompany did at HEAD (geoOk with config, roleOk with config, isFresh).
const oldLight = (job) =>
	OLD.roleOk(job.title, OLD.FILTERS) && OLD.geoOk(job.location, OLD.FILTERS) && OLD.isFresh(job.postedAt, OLD.FILTERS, now);

// Fetch each JD once, for the union of what either pipeline shortlists.
const wanted = new Map();
for (const company of pool) {
	const jobs = lists.get(company.name) ?? [];
	const fresh = NEW.lightGate(jobs, NEW.FILTERS, now).shortlist;
	const keys = new Set([...fresh, ...jobs.filter(oldLight)].map((job) => job.externalId));
	for (const job of jobs) if (keys.has(job.externalId)) wanted.set(`${company.name}#${job.externalId}`, { company, job });
}

console.error(`fetching ${wanted.size} job descriptions...`);
const details = new Map();
await mapLimit([...wanted.entries()], CONCURRENCY, async ([key, { company, job }]) => {
	try {
		const [detail] = await NEW.getSource(company.source).fetchDetails(company, [job], {});
		details.set(key, detail);
	} catch {
		failures += 1;
	}
});

// ---------------------------------------------------------------------------
// Funnels
// ---------------------------------------------------------------------------
const INDIA = /\b(india|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|ncr|gurugram|gurgaon|noida|thane)\b/i;

function funnels(companies) {
	const before = { fetched: 0, title: 0, location: 0, fresh: 0, detailed: 0, yoe: 0, unknownYoe: 0, deduped: 0, sent: 0, staffSent: 0, wrongLocationSent: 0 };
	const after = { fetched: 0, title: 0, location: 0, fresh: 0, detailed: 0, yoe: 0, unknownYoe: 0, deduped: 0, sent: 0, staffSent: 0, wrongLocationSent: 0 };
	const sentOld = [];
	const sentNew = [];

	for (const company of companies) {
		const jobs = lists.get(company.name) ?? [];
		before.fetched += jobs.length;
		after.fetched += jobs.length;

		// OLD, stage by stage, mirroring HEAD's order (title, location, fresh).
		const t = jobs.filter((j) => OLD.roleOk(j.title, OLD.FILTERS));
		const l = t.filter((j) => OLD.geoOk(j.location, OLD.FILTERS));
		const f = l.filter((j) => OLD.isFresh(j.postedAt, OLD.FILTERS, now));
		before.title += t.length;
		before.location += l.length;
		before.fresh += f.length;
		for (const job of f) {
			const detail = details.get(`${company.name}#${job.externalId}`);
			if (!detail) continue;
			before.detailed += 1;
			if (!OLD.passesDetailFilters(detail, OLD.FILTERS) || !OLD.geoOk(detail.description) || !OLD.yoeOk(detail.description)) continue;
			before.yoe += 1;
			const yoe = OLD.minYoe(detail.description);
			if (yoe === null) before.unknownYoe += 1;
			sentOld.push({ company: company.name, title: detail.title, location: detail.location, yoe, key: `${detail.company}|${OLD.normalizeTitle(detail.title)}|${detail.location}` });
		}

		// NEW
		const light = NEW.lightGate(jobs, NEW.FILTERS, now);
		after.title += light.counts.title;
		after.location += light.counts.location;
		after.fresh += light.counts.fresh;
		for (const job of light.shortlist) {
			const detail = details.get(`${company.name}#${job.externalId}`);
			if (!detail) continue;
			after.detailed += 1;
			const outcome = NEW.detailGate({ ...detail, location: job.location }, NEW.FILTERS, { sendUnknownYoe: false });
			if (!outcome.ok) continue;
			after.yoe += 1;
			sentNew.push({ company: company.name, title: detail.title, location: job.location, yoe: outcome.yoeMin, key: `${detail.company.toLowerCase()}|${NEW.normalizeTitle(detail.title)}` });
		}
	}

	// Dedupe. OLD: exact company|title|location. NEW: company|title, locations merged.
	const oldUnique = new Map(sentOld.map((s) => [s.key, s]));
	const newUnique = new Map();
	for (const s of sentNew) {
		const prior = newUnique.get(s.key);
		if (prior) prior.location = NEW.mergeLocations(prior.location, s.location);
		else newUnique.set(s.key, { ...s });
	}
	before.deduped = sentOld.length - oldUnique.size;
	after.deduped = sentNew.length - newUnique.size;
	before.sent = oldUnique.size;
	after.sent = newUnique.size;

	const staff = /\bstaff\b/i;
	for (const s of oldUnique.values()) {
		if (staff.test(s.title)) before.staffSent += 1;
		if (!INDIA.test(s.location) && !/\b(worldwide|anywhere|apac)\b/i.test(s.location)) before.wrongLocationSent += 1;
	}
	for (const s of newUnique.values()) {
		if (staff.test(s.title)) after.staffSent += 1;
		if (!INDIA.test(s.location) && !/\b(worldwide|anywhere|apac)\b/i.test(s.location)) after.wrongLocationSent += 1;
	}

	return { before, after, sample: { old: [...oldUnique.values()], new: [...newUnique.values()] } };
}

const groups = [
	{ label: `core 14 (scripts/companies.json)`, companies: pool.filter((c) => core.includes(c.name)) },
	{ label: `resolved pool (${seeds.join(' + ')})`, companies: pool },
];

const report = groups.map((g) => ({ label: g.label, boards: g.companies.length, ...funnels(g.companies) }));

const rows = [
	['jobs fetched', 'fetched'],
	['passed title', 'title'],
	['passed location', 'location'],
	['passed freshness', 'fresh'],
	['JD fetched', 'detailed'],
	['passed YOE', 'yoe'],
	['  of which YOE unknown', 'unknownYoe'],
	['deduped away', 'deduped'],
	['SENT', 'sent'],
	['  staff roles sent', 'staffSent'],
	['  non-India locations sent', 'wrongLocationSent'],
];

for (const r of report) {
	console.log(`\n## ${r.label}: ${r.boards} boards, one full cycle (${failures} fetch failures overall)`);
	console.log(`| stage | before | after |\n|---|---:|---:|`);
	for (const [name, key] of rows) console.log(`| ${name} | ${r.before[key]} | ${r.after[key]} |`);
	console.log(`| Telegram messages (5 per msg) | ${Math.ceil(r.before.sent / 5)} | ${Math.ceil(r.after.sent / 5)} |`);
}

const last = report[report.length - 1];
console.log(`\nSAMPLE sent AFTER (${last.sample.new.length}), first 25:`);
for (const s of last.sample.new.slice(0, 25)) console.log(`  ${s.company} | ${s.title} | ${s.location} | yoe=${s.yoe}`);
console.log(`\nSAMPLE sent BEFORE but not AFTER (first 25):`);
const afterKeys = new Set(last.sample.new.map((s) => `${s.company}|${s.title}`));
for (const s of last.sample.old.filter((s) => !afterKeys.has(`${s.company}|${s.title}`)).slice(0, 25)) {
	console.log(`  ${s.company} | ${s.title} | ${s.location} | yoe=${s.yoe}`);
}

if (jsonOut) writeFileSync(resolve(root, jsonOut), JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------
// Audit: India-eligible postings that the NEW title gate rejects, grouped by why.
// Eyeball this for over-filtering (a good fresher role dropped on a missing keyword).
// ---------------------------------------------------------------------------
if (argv.includes('--audit')) {
	const level = [];
	const noKeyword = [];
	for (const company of pool) {
		for (const job of lists.get(company.name) ?? []) {
			if (NEW.eligibleLocations(job.location, NEW.FILTERS).length === 0) continue;
			if (NEW.roleOk(job.title, NEW.FILTERS)) continue;
			(NEW.roleOk(job.title) ? noKeyword : level).push(`${company.name} | ${job.title} | ${job.location}`);
		}
	}
	console.log(`\nAUDIT India-eligible, rejected by level marker: ${level.length}`);
	for (const line of level.slice(0, 15)) console.log(`  ${line}`);
	console.log(`\nAUDIT India-eligible, rejected for NO role keyword: ${noKeyword.length}`);
	for (const line of noKeyword.slice(0, 60)) console.log(`  ${line}`);
}
