import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// ════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ════════════════════════════════════════════════════════════════
const COVER_LETTER = `Madame, Monsieur,

C'est avec un grand enthousiasme que je vous adresse ma candidature.

Fort de mes competences en developpement (React.js, Node.js, TypeScript), je suis convaincu de pouvoir apporter une contribution solide a votre equipe.

Je serais ravi de vous rencontrer lors d'un entretien pour vous exposer de vive voix tout l'interet de ma demarche.

Dans l'attente, je vous prie d'agreer l'expression de mes salutations distinguees.

Sofiane Mouedrhiri`;

const WTTJ_URL            = 'https://www.welcometothejungle.com/fr/jobs-matches';
const HW_LOGIN            = 'https://www.hellowork.com/fr-fr/candidat/connexion-inscription.html#connexion';
const HW_SEARCH           = 'https://www.hellowork.com/fr-fr/emploi/recherche.html';
const UA                  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SEEN_FILE           = path.resolve('./jobbot_seen.json');

// ════════════════════════════════════════════════════════════════
//  PERSISTANCE
// ════════════════════════════════════════════════════════════════
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch {}
  return new Set();
}
function saveSeen(seen) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]), 'utf8'); }
  catch (e) { log('WARN', `Sauvegarde impossible : ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════
//  UTILITAIRES
// ════════════════════════════════════════════════════════════════
function ask(q) {
  return new Promise(res => {
    const i = readline.createInterface({ input: process.stdin, output: process.stdout });
    i.question(q, a => { i.close(); res(a.trim()); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function header(t) { console.log('\n' + '='.repeat(60) + '\n  ' + t + '\n' + '='.repeat(60) + '\n'); }
function log(icon, msg) { console.log(`  ${icon}  ${msg}`); }
function timestamp() {
  return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function countdown(ms) {
  return new Promise(resolve => {
    let rem = Math.floor(ms / 1000);
    const iv = setInterval(() => {
      rem--;
      const m = String(Math.floor(rem / 60)).padStart(2, '0');
      const s = String(rem % 60).padStart(2, '0');
      process.stdout.write(`\r  Prochain scan dans ${m}:${s}   `);
      if (rem <= 0) { clearInterval(iv); process.stdout.write('\n'); resolve(); }
    }, 1000);
  });
}

// ════════════════════════════════════════════════════════════════
//  MENU
// ════════════════════════════════════════════════════════════════
async function mainMenu() {
  header('JobBot -- Candidature automatique (boucle 30 min)');
  console.log('  [1]  Welcome to the Jungle');
  console.log('  [2]  HelloWork');
  console.log('  [3]  Les deux\n');

  let choice = '';
  while (!['1','2','3'].includes(choice)) choice = await ask('  Votre choix (1/2/3) : ');

  let phone = '', jobKeyword = '', jobLocation = '';
  if (['2','3'].includes(choice)) {
    jobKeyword  = await ask('\n  Metier (ex: Alternance Informatique) : ');
    jobLocation = await ask('  Lieu (ex: France) : ');
    phone       = await ask('  Telephone : ');
  }

  if (fs.existsSync(SEEN_FILE)) {
    const r = await ask('\n  Historique trouve. Reinitialiser ? (o/N) : ');
    if (r.toLowerCase() === 'o') { fs.unlinkSync(SEEN_FILE); log('OK', 'Historique efface'); }
    else { log('OK', `${loadSeen().size} offres en memoire`); }
  }

  return { choice, phone, jobKeyword, jobLocation };
}

// ════════════════════════════════════════════════════════════════
//  CONNEXION HELLOWORK
//
//  REGLE STRICTE :
//  1. Aller sur HW_LOGIN
//  2. Attendre l'apparition du cercle bleu avec initiales (ex: "MO")
//     OU du lien mon-compte dans le DOM
//  3. L'URL seule NE SUFFIT PAS — Google OAuth fait des redirections
//     intermediaires sans etre vraiment connecte
// ════════════════════════════════════════════════════════════════

async function isHWLoggedIn(page) {
  try {
    // Cercle bleu avec les initiales = connecte
    const initials = await page.locator('[data-from-account-data-copy-value="Initials"]').count();
    if (initials > 0) return true;

    // Lien mon compte present = connecte
    const monCompte = await page.locator('a[href*="/candidat/mon-compte"], a[href*="/mon-compte/"]').count();
    if (monCompte > 0) return true;

    // Le bouton "Se connecter" a disparu ET on n'est plus sur la page login
    const url = page.url();
    const onLoginPage = url.includes('connexion-inscription') || url.includes('accounts.google') || url.includes('oauth');
    if (!onLoginPage) {
      const connectBtn = await page.locator('[data-cy="headerAccountMenu"]').count();
      if (connectBtn === 0) return true;
    }
  } catch {}
  return false;
}

async function loginHelloWork(page) {
  log('NAV', `Ouverture : ${HW_LOGIN}`);
  await page.goto(HW_LOGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  if (await isHWLoggedIn(page)) {
    log('OK', 'Deja connecte sur HelloWork !');
    return;
  }

  log('>>>>', '');
  log('>>>>', 'CONNECTE-TOI SUR HELLOWORK (Google ou email/mdp)');
  log('>>>>', 'Le bot attend lapparition de ton cercle bleu avec tes initiales.');
  log('>>>>', 'NE FERME PAS le navigateur.');
  log('>>>>', '');

  let dots = 0;
  while (true) {
    await sleep(1200);
    try {
      if (await isHWLoggedIn(page)) break;
    } catch {}
    dots++;
    process.stdout.write(dots % 40 === 0 ? '\n  ' : '.');
  }

  console.log('');
  log('OK', `Connexion HelloWork confirmee ! URL : ${page.url()}\n`);
}

// ════════════════════════════════════════════════════════════════
//  CONNEXION WTTJ
// ════════════════════════════════════════════════════════════════
async function loginWTTJ(page) {
  log('NAV', `Ouverture : ${WTTJ_URL}`);
  await page.goto(WTTJ_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const loggedIn = await page.locator('a[href*="/me/"], [data-testid="user-menu"]').count();
  if (loggedIn > 0) { log('OK', 'Deja connecte sur WTTJ !'); return; }

  log('>>>>', '');
  log('>>>>', 'CONNECTE-TOI SUR WTTJ DANS LE NAVIGATEUR');
  log('>>>>', '');

  let dots = 0;
  while (true) {
    await sleep(1000);
    try {
      const ok = await page.locator('a[href*="/me/"], [data-testid="user-menu"]').count();
      if (ok > 0) break;
    } catch {}
    dots++;
    process.stdout.write(dots % 40 === 0 ? '\n  ' : '.');
  }
  console.log('');
  log('OK', 'Connecte sur WTTJ !\n');
}

// ════════════════════════════════════════════════════════════════
//  HELLOWORK — FILTRES
//  Clique sur les labels par attribut "for" exact (pas sur les inputs)
//  Car les inputs sont caches, seuls les labels sont cliquables
// ════════════════════════════════════════════════════════════════
async function applyHWFilters(page) {
  log('FILTRE', 'Filtres ignores -- collecte directe des offres');
}

// ════════════════════════════════════════════════════════════════
//  HELLOWORK — CYCLE
// ════════════════════════════════════════════════════════════════
async function runHelloWork(page, jobKeyword, jobLocation, phone, seen, cycleNum) {
  header(`HelloWork -- Cycle #${cycleNum} [${timestamp()}]`);

  // Navigation directe avec parametres dans l'URL
  const searchUrl = `${HW_SEARCH}?k=${encodeURIComponent(jobKeyword)}&l=${encodeURIComponent(jobLocation)}`;
  log('NAV', `URL : ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Appliquer filtres
  await applyHWFilters(page);

  // Collecter URLs
  log('OK', 'Collecte des offres...');
  const allUrls = await hwCollectUrls(page, searchUrl);
  const urlsToApply = allUrls;
  log('OK', `${allUrls.length} offre(s) trouvee(s) -- toutes seront traitees`);

  if (urlsToApply.length === 0) { log('ZZZ', 'Aucune offre trouvee'); return { sent: 0, skipped: 0 }; }

  let sent = 0, skipped = 0;

  for (let i = 0; i < urlsToApply.length; i++) {
    const url = urlsToApply[i];
    console.log('\n' + '-'.repeat(55));
    log('LIEN', `[${i+1}/${urlsToApply.length}] ${url}`);
    seen.add(url); saveSeen(seen);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000);

      const title   = await page.locator('h1').first().innerText().catch(() => '?');
      const company = await page.locator('[data-cy="jobCompanyName"], h2').first().innerText().catch(() => '?');
      log('OK', `${company.trim()} -- ${title.trim()}`);

      // ── ETAPE 1 : Vrai clic Playwright sur "Postuler" ────────────────────
      const postulerLoc = page.locator('a[data-cy="applyButtonHeader"][href="#postuler"]').first();
      if (await postulerLoc.count() === 0) { log('SKIP', 'Bouton Postuler introuvable -- skip'); skipped++; continue; }
      try {
        await postulerLoc.click({ force: true, timeout: 5000 });
      } catch {
        await page.evaluate(() => { const a = document.querySelector('a[data-cy="applyButtonHeader"][href="#postuler"]'); if (a) a.click(); });
      }
      log('OK', 'Clic sur "Postuler"');

      // ── ETAPE 2 : Attendre le formulaire visible (jusqu'a 10s) ───────────
      const submitLoc = page.locator('button[data-cy="submitButton"]').first();
      let submitReady = false;
      for (let t = 0; t < 10; t++) {
        await sleep(1000);
        if (await submitLoc.count() > 0 && await submitLoc.isVisible().catch(() => false)) {
          log('OK', `Formulaire pret (${t+1}s)`); submitReady = true; break;
        }
      }
      if (!submitReady) {
        // Screenshot debug pour voir ce que HelloWork affiche
        const debugPath = path.resolve('./debug_postuler.png');
        await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
        // Dump texte visible sur la page
        const pageText = await page.evaluate(() => {
          const section = document.querySelector('#postuler, [id="postuler"], section:has(button)');
          return {
            postulerSection: section ? section.innerText.substring(0, 500) : 'section #postuler introuvable',
            allButtons: [...document.querySelectorAll('button')].map(b => b.getAttribute('data-cy') + ' | ' + b.textContent.trim().substring(0, 30)).join('\n'),
            url: window.location.href,
          };
        }).catch(() => ({ postulerSection: 'erreur', allButtons: '', url: '' }));
        log('DEBUG', `URL: ${pageText.url}`);
        log('DEBUG', `Section postuler: ${pageText.postulerSection}`);
        log('DEBUG', `Boutons visibles:\n${pageText.allButtons}`);
        log('DEBUG', `Screenshot: ${debugPath}`);
        log('SKIP', 'Formulaire non visible -- skip'); skipped++; continue;
      }

      // Remplir telephone si present
      const phoneField = page.locator('input[name*="phone"], input[name*="tel"], input[type="tel"]').first();
      if (await phoneField.count() > 0) {
        const existing = await phoneField.inputValue().catch(() => '');
        if (!existing.trim() && phone) { await phoneField.fill(phone); log('OK', 'Telephone renseigne'); }
      }

      // ── ETAPE 3 : Vrai clic Playwright sur submit ────────────────────────
      await submitLoc.click({ force: true, timeout: 5000 });
      log('OK', 'Clic submit (evenement souris reel)');
      await sleep(3000);

      // ── ETAPE 4 : Detection confirmation ─────────────────────────────────
      const isConfirmed = await page.evaluate(() => {
        const txt = (document.body.innerText || '').toLowerCase();
        const url = window.location.href.toLowerCase();
        return txt.includes('envoy') || txt.includes('merci') || txt.includes('confirm') ||
               url.includes('confirm') || url.includes('success') || url.includes('merci') ||
               !!document.querySelector('[data-cy="applicationSent"],[data-cy="successMessage"]');
      });

      if (isConfirmed) {
        log('ENVOYE', 'Candidature confirmee par HelloWork !');
      } else {
        // Tenter un 2e ecran
        const submit2 = page.locator('button[data-cy="submitButton"]').first();
        if (await submit2.count() > 0 && await submit2.isVisible().catch(() => false)) {
          await submit2.click({ force: true, timeout: 5000 });
          log('OK', 'Clic 2e submit');
          await sleep(3000);
        }
        const isConfirmed2 = await page.evaluate(() => {
          const txt = (document.body.innerText || '').toLowerCase();
          return txt.includes('envoy') || txt.includes('merci') || txt.includes('confirm');
        });
        if (isConfirmed2) {
          log('ENVOYE', 'Candidature confirmee (2e etape) !');
        } else {
          log('WARN', 'Pas de confirmation detectee -- candidature peut-etre non envoyee');
          skipped++; continue;
        }
      }
      sent++;

    } catch (err) { log('ERREUR', err.message); }
  }

  log('FIN', `HW cycle #${cycleNum} -- ${sent} envoyee(s), ${skipped} skippee(s)`);
  return { sent, skipped };
}

// ════════════════════════════════════════════════════════════════
//  HELLOWORK — COLLECTE DES URLS (pagination Turbo Frame)
//
//  La pagination HW passe par data-turbo-frame="turboSerp" :
//  le contenu change SANS rechargement complet de la page.
//  -> on n'utilise donc PAS waitForLoadState, mais waitForFunction
//     sur le changement de la 1ere carte.
//
//  Detection page suivante :
//  - page COURANTE = button[name="p"] disabled + !bg-black (fond noir)
//  - page suivante = bouton numerote dont le texte === (courante + 1)
//  - fallback = fleche droite (<use href*="#right">) si non desactivee
//    (la fleche partage la meme "value" que le bouton numerote -> on
//     distingue par le TEXTE chiffre pour ne pas confondre les deux)
// ════════════════════════════════════════════════════════════════
async function hwCollectUrls(page, baseSearchUrl) {
  const allUrls = new Set();
  for (let p = 1; p <= 50; p++) {
    // HelloWork utilise le parametre "p" (et non "page") pour la pagination.
    const pageUrl = new URL(baseSearchUrl);
    if (p === 1) pageUrl.searchParams.delete('p');
    else pageUrl.searchParams.set('p', String(p));
    const url = pageUrl.toString();
    log('NAV', 'Collecte page ' + p + ' : ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    await page.waitForSelector('[data-cy="serpCard"]', { timeout: 10000 }).catch(() => {});
    await sleep(500);
    const hrefs = await page.evaluate(() => {
      const links = [...document.querySelectorAll('[data-cy="serpCard"] a[data-cy="offerTitle"], [data-cy="serpCard"] a[href*="/emplois/"]')];
      return [...new Set(links.map(a => a.href).filter(h => /\/emplois\/\d+/.test(h)))];
    });
    const before = allUrls.size;
    hrefs.forEach(u => allUrls.add(u));
    const added = allUrls.size - before;
    log('OK', `Page ${p} : ${hrefs.length} offre(s) -- ${added} URL unique(s) ajoutee(s)`);

    if (hrefs.length === 0) {
      log('OK', 'Fin pagination : aucune offre sur la page ' + p);
      break;
    }

    // On s'arrete seulement si HelloWork ne propose vraiment pas la page suivante.
    // Le nombre d'URL deja collectees ne doit jamais interrompre la pagination.
    const nextPage = p + 1;
    const hasNextPage = await page.evaluate(next => {
      const controls = [...document.querySelectorAll('button[name="p"], a[href*="p="]')];
      return controls.some(control => {
        if (control.disabled || control.getAttribute('aria-disabled') === 'true') return false;

        const value = control.getAttribute('value');
        const text = (control.textContent || '').trim();
        if (Number(value) === next || (/^\d+$/.test(text) && Number(text) === next)) return true;

        const href = control.getAttribute('href');
        if (!href) return false;
        try {
          return Number(new URL(href, window.location.href).searchParams.get('p')) === next;
        } catch {
          return false;
        }
      });
    }, nextPage);

    if (!hasNextPage) {
      log('OK', `Fin pagination : aucune page ${nextPage}`);
      break;
    }
  }
  return [...allUrls];
}

// ════════════════════════════════════════════════════════════════
//  WTTJ — CYCLE
// ════════════════════════════════════════════════════════════════
async function runWTTJ(page, seen, cycleNum) {
  header(`WTTJ -- Cycle #${cycleNum} [${timestamp()}]`);

  await page.goto(WTTJ_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  log('OK', 'Collecte des offres...');
  const allUrls = await wttjCollectUrls(page);
  const urlsToApply = allUrls;
  log('OK', `${allUrls.length} offre(s) trouvee(s) -- toutes seront traitees`);

  if (urlsToApply.length === 0) { log('ZZZ', 'Aucune offre trouvee'); return { sent: 0, skipped: 0 }; }

  let sent = 0, skipped = 0;

  for (let i = 0; i < urlsToApply.length; i++) {
    const url = urlsToApply[i];
    console.log('\n' + '-'.repeat(55));
    log('LIEN', `[${i+1}/${urlsToApply.length}] ${url}`);
    seen.add(url); saveSeen(seen);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('h2', { timeout: 8000 });

      const title   = await page.locator('h2').first().innerText().catch(() => '?');
      const company = await page.locator('[data-testid="company-name"], [class*="CompanyName"]').first().innerText().catch(() => '?');
      log('OK', `${company.trim()} -- ${title.trim()}`);

      const applyBtn = page.locator(
        'button[data-testid="job_bottom-button-apply"], button[data-testid="job_header-button-apply"], button[data-role="job:apply"]'
      ).first();
      if (await applyBtn.count() === 0) { log('SKIP', 'Externe'); skipped++; continue; }

      await applyBtn.click();
      const hasForm = await page.waitForSelector('[data-testid="apply-form-submit"], button[type="submit"]', { timeout: 6000 }).then(() => true).catch(() => false);
      if (!hasForm) { log('SKIP', 'Pas de formulaire'); skipped++; continue; }

      const coverField = page.locator(['textarea#cover_letter','textarea[name="cover_letter"]','[data-testid="apply-form-field-cover_letter"] textarea'].join(', ')).first();
      if (await coverField.count() > 0) {
        const existing = await coverField.inputValue().catch(() => '');
        if (existing.trim().length < 15) { await coverField.fill(COVER_LETTER); log('OK', 'Lettre renseignee'); }
      }

      const consent = page.locator('input[type="checkbox"][id="consent"], input[type="checkbox"][name="consent"]').first();
      if (await consent.count() > 0 && !(await consent.isChecked())) {
        const lbl = page.locator('label[for="consent"]');
        await (await lbl.count() > 0 ? lbl.first() : consent).click();
        log('OK', 'RGPD coche');
      }

      const submitBtn = page.locator('[data-testid="apply-form-submit"], button[type="submit"]').first();
      if (await submitBtn.count() > 0) {
        await submitBtn.click();
        log('ENVOYE', 'Candidature envoyee !');
        sent++;
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      }

    } catch (err) { log('ERREUR', err.message); }
  }

  log('FIN', `WTTJ cycle #${cycleNum} -- ${sent} envoyee(s), ${skipped} skippee(s)`);
  return { sent, skipped };
}

async function wttjCollectUrls(page) {
  const allUrls = [];
  const cardSel = 'a[href*="/companies/"][href*="/jobs/"]';
  while (true) {
    await page.waitForSelector(cardSel, { timeout: 10000 });
    const hrefs = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(a => a.href), cardSel);
    hrefs.filter(u => !allUrls.includes(u)).forEach(u => allUrls.push(u));
    const nextBtn = page.locator('[data-testid="job-list-pagination-arrow-next"]:not([disabled])');
    if (await nextBtn.count() === 0) break;
    await nextBtn.click();
    await page.waitForSelector(cardSel, { state: 'detached', timeout: 3000 }).catch(() => {});
    await page.waitForSelector(cardSel, { timeout: 10000 });
  }
  return allUrls;
}

// ════════════════════════════════════════════════════════════════
//  MAIN
// ════════════════════════════════════════════════════════════════
async function main() {
  const { choice, phone, jobKeyword, jobLocation } = await mainMenu();
  const seen = loadSeen();
  log('OK', `Historique : ${seen.size} offre(s) en memoire\n`);

  // Chercher Edge ou Chrome (tous deux detectes comme vrais navigateurs)
  function findRealBrowser() {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return null;
  }
  const REAL_BROWSER = findRealBrowser();
  const USER_DATA = process.env.LOCALAPPDATA + '\\JobbotBrowser';

  let browser, ctx;
  try {
    if (!REAL_BROWSER) throw new Error('Aucun navigateur reel trouve');
    log('OK', 'Navigateur reel trouve : ' + REAL_BROWSER);
    ctx = await chromium.launchPersistentContext(USER_DATA, {
      executablePath: REAL_BROWSER,
      headless: false,
      slowMo: 80,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
        '--start-maximized',
        '--disable-extensions-except=',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      extraHTTPHeaders: {
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Google Chrome";v="136", "Chromium";v="136", "Not.A/Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });
    log('OK', 'Navigateur Chrome reel lance avec profil persistant');
  } catch(e) {
    log('WARN', 'Navigateur reel introuvable -- utilisation de Chromium Playwright');
    log('WARN', e.message);
    ctx = await chromium.launchPersistentContext('./jobbot_profile', {
      headless: false,
      slowMo: 80,
      args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--start-maximized'],
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });
  }

  // Supprimer les fausses proprietes (ctx.newContext n'existe pas en persistentContext)


  // ── Script anti-détection injecté avant tout JS de la page ──────────────
  await ctx.addInitScript(() => {
    // Supprimer navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Simuler des plugins Chrome réels
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = plugins.length;
        return plugins;
      }
    });

    // Simuler des langues réalistes
    Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });

    // Cacher les traces d'automation Chrome
    window.chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
      runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformOs: {}, id: undefined },
    };

    // Supprimer __playwright et __pwInitScripts
    delete window.__playwright;
    delete window.__pwInitScripts;

    // Patcher les permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  let wttjPage = null;
  let hwPage   = null;

  // ─── CONNEXIONS OBLIGATOIRES — DANS L'ORDRE, AVANT TOUT ─────
  if (choice === '1' || choice === '3') {
    wttjPage = await ctx.newPage();
    await loginWTTJ(wttjPage);
  }

  if (choice === '2' || choice === '3') {
    hwPage = await ctx.newPage();
    // REGLE STRICTE : aller sur login HW et attendre la redirection
    await loginHelloWork(hwPage);
  }

  // ─── BOUCLE 30 MIN ──────────────────────────────────────────
  let cycle = 1;
  const grand = { sent: 0, skipped: 0 };

  while (true) {
    try {
      if (wttjPage) { const r = await runWTTJ(wttjPage, seen, cycle); grand.sent += r.sent; grand.skipped += r.skipped; }
      if (hwPage)   { const r = await runHelloWork(hwPage, jobKeyword, jobLocation, phone, seen, cycle); grand.sent += r.sent; grand.skipped += r.skipped; }
    } catch (err) {
      log('ERREUR', `Cycle #${cycle} : ${err.message}`);
      log('INFO', 'Reprise au prochain cycle...');
    }

    console.log('\n' + '-'.repeat(60));
    log('STATS', `Cumul : ${grand.sent} envoyee(s) | ${grand.skipped} skippee(s) | ${seen.size} URL(s)`);
    log('SAVE', SEEN_FILE);
    console.log('-'.repeat(60));
    cycle++;
    await countdown(REFRESH_INTERVAL_MS);
  }
}

main().catch(err => { console.error('\nErreur fatale :', err.message); process.exit(1); });
