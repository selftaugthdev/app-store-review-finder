const { chromium } = require('playwright');
const fs = require('fs');

const args = process.argv.slice(2);

function getArg(name) {
  const inlineMatch = args.find((a) => a.startsWith(`--${name}=`));
  if (inlineMatch) return inlineMatch.split('=').slice(1).join('=');
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const appArg = getArg('app');
const idArg = getArg('id');
const starsArg = getArg('stars');

if (!appArg && !idArg) {
  console.error('Usage:');
  console.error('  node scrape.js --app "migraine buddy"');
  console.error('  node scrape.js --id 6744931427');
  console.error('  node scrape.js --app "migraine buddy" --stars 1,2,3');
  process.exit(1);
}

const filterStars = starsArg ? starsArg.split(',').map(Number) : null;
const CSV_DIR = 'CSV output';
if (!fs.existsSync(CSV_DIR)) fs.mkdirSync(CSV_DIR);

async function resolveAppId(browser, name) {
  const page = await browser.newPage();
  await page.goto(`https://apps.apple.com/us/search?term=${encodeURIComponent(name)}`, { waitUntil: 'networkidle', timeout: 30000 });
  const href = await page.$eval('a[href*="/app/id"]', (a) => a.href).catch(() => null);
  await page.close();
  if (!href) { console.error('App not found.'); process.exit(1); }
  const idMatch = href.match(/id(\d+)/);
  return idMatch[1];
}

function toCSV(reviews) {
  const header = 'rating,date,author,title,review';
  const rows = reviews.map((r) => [
    r.rating,
    r.date,
    `"${(r.author || '').replace(/"/g, '""')}"`,
    `"${(r.title || '').replace(/"/g, '""')}"`,
    `"${(r.review || '').replace(/"/g, '""')}"`,
  ].join(','));
  return [header, ...rows].join('\n');
}

async function scrapeReviews(page) {
  return page.evaluate(() => {
    const results = [];
    // ol.stars is 4 levels deep inside the review card
    document.querySelectorAll('ol.stars').forEach((ol) => {
      const card = ol.parentElement?.parentElement?.parentElement?.parentElement;
      if (!card) return;

      const ratingMatch = ol.getAttribute('aria-label')?.match(/(\d+)/);
      const rating = ratingMatch ? parseInt(ratingMatch[1]) : null;
      const date = card.querySelector('time')?.getAttribute('datetime')?.split('T')[0] || '';
      const author = card.querySelector('p.author')?.innerText?.trim() || '';
      // Title is the first line of the card's text (before the header section)
      const fullText = card.innerText?.trim() || '';
      const title = fullText.split('\n')[0]?.trim() || '';
      const review = card.querySelector('[data-testid="truncate-text"]')?.innerText?.trim() || '';

      if (author || review) results.push({ rating, date, author, title, review });
    });
    return results;
  });
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });

  let appId = idArg;
  let appName = appArg || `app_${idArg}`;

  if (!appId) {
    console.log(`Searching for "${appArg}"...`);
    appId = await resolveAppId(browser, appArg);
    console.log(`Found app ID: ${appId}\n`);
  }

  const reviewsUrl = `https://apps.apple.com/us/app/id${appId}?see-all=reviews`;
  console.log(`Fetching reviews from App Store...`);

  const page = await browser.newPage();
  await page.goto(reviewsUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Get app name from page title
  const title = await page.title().catch(() => '');
  const nameMatch = title.match(/^‎?(.+?) - Ratings/);
  if (nameMatch) appName = nameMatch[1];

  // Scroll to load all reviews
  console.log('Scrolling to load all reviews...');
  let previousCount = 0;
  let unchangedRounds = 0;
  while (unchangedRounds < 5) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(1500);
    const count = await page.evaluate(() => document.querySelectorAll('[class^="review"]').length);
    if (count === previousCount) {
      unchangedRounds++;
    } else {
      unchangedRounds = 0;
      previousCount = count;
      console.log(`  ${count} reviews loaded...`);
    }
  }

  await page.waitForTimeout(2000);
  const allReviews = await scrapeReviews(page);
  await browser.close();

  const filtered = filterStars ? allReviews.filter((r) => filterStars.includes(r.rating)) : allReviews;

  if (!filtered.length) {
    console.log('\nNo reviews found. The selectors may need updating for this app.');
    // Dump a sample to help debug
    console.log('Total raw reviews found:', allReviews.length);
    return;
  }

  console.log(`\nTotal: ${filtered.length} reviews`);
  const byStars = [1, 2, 3, 4, 5].map((s) => ({
    stars: s,
    count: filtered.filter((r) => r.rating === s).length,
  }));
  console.log('\nBreakdown:');
  byStars.forEach(({ stars, count }) => console.log(`  ${stars}★  ${count}`));

  const safeName = appName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase().slice(0, 40);
  const starLabel = filterStars ? `_${filterStars.join('-')}stars` : '';
  const outputFile = `${CSV_DIR}/${safeName}${starLabel}.csv`;
  fs.writeFileSync(outputFile, toCSV(filtered));
  console.log(`\nSaved to ${outputFile}`);
}

scrape().catch(console.error);
