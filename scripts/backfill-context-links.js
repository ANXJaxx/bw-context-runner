// Backfill BW Context Linker AI sentences across all sites in sites.json.
//
// Calls each site's /wp-json/bw-context-linker/v1/process-next endpoint in a
// round-robin loop, sleeping between calls to stay under Groq's free-tier
// rate limits. Designed to run from GitHub Actions on a schedule but works
// locally too.
//
// Usage:
//   node scripts/backfill-context-links.js                 # all sites, default pacing
//   node scripts/backfill-context-links.js --only=best-hemp-oil.com
//   node scripts/backfill-context-links.js --rpm=120 --batch=3 --max-minutes=300
//
// Flags:
//   --only=<domain>        run only this site (substring match against sites.json domain)
//   --rpm=<n>              global target requests-per-minute (default 120, cap 200)
//   --batch=<n>            posts to process per site per call (default 2, cap 10)
//   --max-minutes=<n>      hard cap on total runtime, in minutes (default 320, max 350 for GH Actions safety)
//   --skip-done            skip sites already fully backfilled (default true)
//   --dry-run              show what would happen but don't make calls

const { loadAllSites, siteUrl } = require('./lib/load-config');
const { wpClient, logAxiosError } = require('./lib/wp-client');

function parseArgs(argv) {
    const args = { only: null, rpm: 120, batch: 2, maxMinutes: 320, skipDone: true, dryRun: false };
    for (const a of argv) {
        if (a.startsWith('--only=')) args.only = a.slice('--only='.length);
        else if (a.startsWith('--rpm=')) args.rpm = Math.min(200, Math.max(10, parseInt(a.slice('--rpm='.length), 10)));
        else if (a.startsWith('--batch=')) args.batch = Math.min(10, Math.max(1, parseInt(a.slice('--batch='.length), 10)));
        else if (a.startsWith('--max-minutes=')) args.maxMinutes = Math.min(350, Math.max(5, parseInt(a.slice('--max-minutes='.length), 10)));
        else if (a === '--no-skip-done') args.skipDone = false;
        else if (a === '--dry-run') args.dryRun = true;
    }
    return args;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let sites = loadAllSites();

    if (args.only) {
        sites = sites.filter(s => (s.domain || '').includes(args.only));
        if (sites.length === 0) {
            console.error(`No site matched --only=${args.only}`);
            process.exit(1);
        }
    } else {
        // Default: engine-built sites running template-a, PLUS all external sites
        // (external sites have the plugin installed via install-plugin-all.js).
        sites = sites.filter(s => s._external || (s.template || 'template-a') === 'template-a');
    }

    console.log(`backfill-context-links: ${sites.length} site(s), rpm=${args.rpm}, batch=${args.batch}/site/call, max=${args.maxMinutes}min, dryRun=${args.dryRun}`);

    // Pacing: convert global RPM to per-call sleep
    const sleepBetweenCallsMs = Math.max(50, Math.round(60000 / args.rpm));
    const deadline = Date.now() + args.maxMinutes * 60 * 1000;

    // Track per-site state so we don't waste calls on sites already complete or rate-limited
    const siteState = new Map();
    for (const s of sites) siteState.set(s.domain, { done: false, rateLimitedUntil: 0, lastMissing: null, totalProcessed: 0, errors: 0 });

    let cycle = 0;
    let totalCalls = 0;
    let totalInserts = 0;

    while (Date.now() < deadline) {
        cycle++;
        let anyWorkThisCycle = false;
        const cycleStart = Date.now();

        for (const site of sites) {
            if (Date.now() >= deadline) break;
            const state = siteState.get(site.domain);
            if (state.done) continue;
            if (Date.now() < state.rateLimitedUntil) continue;

            const wp = wpClient(site);
            if (args.dryRun) {
                console.log(`  [${site.domain}] DRY-RUN would call /process-next?batch=${args.batch}`);
                state.totalProcessed += args.batch;
                anyWorkThisCycle = true;
                await sleep(20);
                continue;
            }

            try {
                const t0 = Date.now();
                const { data } = await wp.post('/bw-context-linker/v1/process-next', null, { params: { batch: args.batch }, timeout: 60000 });
                const dt = Date.now() - t0;
                totalCalls++;

                if (data.done) {
                    state.done = true;
                    state.lastMissing = 0;
                    console.log(`  [${site.domain}] ✓ DONE — all ${data.total} posts processed`);
                    continue;
                }
                if (data.rate_limit) {
                    state.rateLimitedUntil = Date.now() + 5 * 60 * 1000; // back off this site for 5 min
                    console.log(`  [${site.domain}] ⏸ rate-limited, backing off 5min (${data.missing} still missing)`);
                    await sleep(sleepBetweenCallsMs * 2); // give Groq a breather
                    continue;
                }

                const proc = data.processed || [];
                const inserts = proc.reduce((sum, p) => sum + ((p.data && p.data.inserted) || 0), 0);
                state.totalProcessed += proc.length;
                state.lastMissing = data.missing;
                totalInserts += inserts;
                anyWorkThisCycle = true;

                console.log(`  [${site.domain}] +${proc.length} processed (+${inserts} links inserted), ${data.missing} remaining (${dt}ms)`);
            } catch (err) {
                state.errors++;
                const code = err.response && err.response.status;
                if (code === 429) {
                    state.rateLimitedUntil = Date.now() + 5 * 60 * 1000;
                    console.log(`  [${site.domain}] HTTP 429 — backing off 5min`);
                } else {
                    console.log(`  [${site.domain}] ERROR ${code || ''} ${err.message}`);
                }
                if (state.errors > 5) {
                    console.log(`  [${site.domain}] too many errors, skipping for this run`);
                    state.rateLimitedUntil = deadline; // skip rest of run
                }
            }

            await sleep(sleepBetweenCallsMs);
        }

        if (!anyWorkThisCycle) {
            const allDone = [...siteState.values()].every(s => s.done);
            if (allDone) {
                console.log('\nAll sites fully backfilled — exiting early.');
                break;
            }
            const stillRateLimited = [...siteState.values()].some(s => Date.now() < s.rateLimitedUntil && !s.done);
            if (stillRateLimited) {
                console.log(`\nCycle ${cycle}: all active sites rate-limited, sleeping 60s before retry...`);
                await sleep(60000);
                continue;
            }
            // Nothing to do but not all done — must be all errored out
            console.log('\nNo work this cycle and not all done — exiting.');
            break;
        }

        const dt = ((Date.now() - cycleStart) / 1000).toFixed(1);
        console.log(`Cycle ${cycle}: ${dt}s, ${totalCalls} total calls, ${totalInserts} total inserts. Sites left: ${[...siteState.values()].filter(s => !s.done).length}/${sites.length}`);
    }

    // Final summary
    console.log('\n=== SUMMARY ===');
    let done = 0, missing = 0, errored = 0, processed = 0;
    for (const [domain, s] of siteState) {
        if (s.done) done++;
        if (s.errors > 0) errored++;
        if (s.lastMissing !== null) missing += s.lastMissing;
        processed += s.totalProcessed;
    }
    console.log(`Sites complete:       ${done} / ${sites.length}`);
    console.log(`Posts processed:      ${processed}`);
    console.log(`Total links inserted: ${totalInserts}`);
    console.log(`Total API calls:      ${totalCalls}`);
    console.log(`Posts still missing:  ~${missing} (sum of last-known missing)`);
    console.log(`Sites with errors:    ${errored}`);
    console.log(`Total runtime:        ${((Date.now() - (deadline - args.maxMinutes * 60 * 1000)) / 60000).toFixed(1)} min`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
