const axios = require('axios');
const fs = require('fs');

const args = process.argv.slice(2);

const appArg = args.find((a) => a.startsWith('--app='))?.split('=')[1]
  || args[args.indexOf('--app') + 1];
const idArg = args.find((a) => a.startsWith('--id='))?.split('=')[1]
  || args[args.indexOf('--id') + 1];
const starsArg = args.find((a) => a.startsWith('--stars='))?.split('=')[1]
  || args[args.indexOf('--stars') + 1];

if (!appArg && !idArg) {
  console.error('Usage:');
  console.error('  node scrape.js --app "migraine buddy"');
  console.error('  node scrape.js --id 1064614487');
  console.error('  node scrape.js --app "migraine buddy" --stars 1,2,3');
  process.exit(1);
}

const filterStars = starsArg ? starsArg.split(',').map(Number) : null;

const COUNTRIES = ['us', 'gb', 'au', 'ca', 'ie', 'nz', 'de', 'fr', 'nl', 'be', 'ch', 'at', 'es', 'it', 'se', 'no', 'dk', 'fi'];
const CSV_DIR = 'CSV output';
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR);

async function searchApp(term) {
  console.log(`Searching App Store for "${term}"...`);
  const res = await axios.get('https://itunes.apple.com/search', {
    params: { term, entity: 'software', country: 'us', limit: 5 },
  });
  const results = res.data.results;
  if (!results.length) {
    console.error('No apps found.');
    process.exit(1);
  }
  console.log('\nFound apps:');
  results.forEach((app, i) => {
    console.log(`  [${i + 1}] ${app.trackName} — ID: ${app.trackId} — by ${app.artistName}`);
  });
  // Auto-select first result
  const picked = results[0];
  console.log(`\nUsing: ${picked.trackName} (ID: ${picked.trackId})\n`);
  return { id: picked.trackId, name: picked.trackName };
}

async function fetchReviews(appId, country, page) {
  try {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortBy=mostRecent/json`;
    const res = await axios.get(url, { timeout: 10000 });
    const entries = res.data?.feed?.entry;
    if (!entries || !Array.isArray(entries)) return [];
    return entries.map((e) => ({
      country: country.toUpperCase(),
      rating: parseInt(e['im:rating']?.label, 10),
      title: e.title?.label || '',
      review: e.content?.label || '',
      author: e.author?.name?.label || '',
      date: e.updated?.label?.split('T')[0] || '',
      version: e['im:version']?.label || '',
    }));
  } catch {
    return [];
  }
}

function toCSV(reviews) {
  const header = 'country,rating,date,version,author,title,review';
  const rows = reviews.map((r) => {
    return [
      r.country,
      r.rating,
      r.date,
      r.version,
      `"${r.author.replace(/"/g, '""')}"`,
      `"${r.title.replace(/"/g, '""')}"`,
      `"${r.review.replace(/"/g, '""')}"`,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

async function scrape() {
  let appId, appName;

  if (idArg) {
    appId = idArg;
    appName = `app_${idArg}`;
  } else {
    const result = await searchApp(appArg);
    appId = result.id;
    appName = result.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  }

  const seen = new Set();
  const allReviews = [];

  for (const country of COUNTRIES) {
    process.stdout.write(`  Fetching ${country.toUpperCase()}... `);
    let countryCount = 0;
    for (let page = 1; page <= 10; page++) {
      const reviews = await fetchReviews(appId, country, page);
      if (!reviews.length) break;
      for (const r of reviews) {
        const key = `${r.author}|${r.date}|${r.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!filterStars || filterStars.includes(r.rating)) {
          allReviews.push(r);
          countryCount++;
        }
      }
    }
    console.log(`${countryCount} reviews`);
  }

  // Sort by date descending
  allReviews.sort((a, b) => b.date.localeCompare(a.date));

  const starLabel = filterStars ? `_${filterStars.join('-')}stars` : '';
  const outputFile = `${CSV_DIR}/${appName}${starLabel}.csv`;

  if (!allReviews.length) {
    console.log('\nNo reviews found matching your filters.');
    return;
  }

  console.log(`\nTotal: ${allReviews.length} reviews across ${COUNTRIES.length} countries`);

  // Summary by star rating
  const byStars = [1, 2, 3, 4, 5].map((s) => ({
    stars: s,
    count: allReviews.filter((r) => r.rating === s).length,
  }));
  console.log('\nBreakdown:');
  byStars.forEach(({ stars, count }) => console.log(`  ${stars}★  ${count}`));

  fs.writeFileSync(outputFile, toCSV(allReviews));
  console.log(`\nSaved to ${outputFile}`);
}

scrape().catch(console.error);
