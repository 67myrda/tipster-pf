/**
 * MLF ARES PROXY — Cloudflare Worker
 * ------------------------------------------------------------------
 * Účel: obchází CORS omezení ares.gov.cz (běžný prohlížeč na GitHub
 * Pages nemůže volat cizí API napřímo bez proxy) a rovnou počítá
 * skóre "vhodnosti" v1 pro každou nalezenou firmu.
 *
 * STAV: v1 / OVĚŘIT — endpoint a schéma ARES API jsou ověřené ze
 * skutečné OpenAPI specifikace (ares.gov.cz/ekonomicke-subjekty-v-be/
 * rest/v3/api-docs), ALE samotné volání jsem nemohl end-to-end
 * odzkoušet živě (nemám na to síťový přístup). Než to nasadíš ostro,
 * udělej jeden testovací dotaz a zkontroluj, že odpověď vypadá
 * rozumně (viz "TEST" sekce v README.md).
 *
 * Nasazení: dash.cloudflare.com -> Workers & Pages -> Create Worker
 * -> vlož tento kód -> Deploy. Žádný API klíč není potřeba, ARES je
 * veřejné a bez autentizace.
 */

const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

/**
 * Poznámka: appka už NEPOUŽÍVÁ ruční tabulku kódů obcí (KODY_OBCI byla
 * smazána 8.8.2026) — hledání obce jde přes sidlo.textovaAdresa (volný
 * text), funguje pro libovolnou obec bez nutnosti dopředu znát kód.
 * Pro power-user případy (přesná obec/část obce) jde kód pořád zadat
 * ručně přes ?kodObce=CISLO (najdeš na epusa.cz/risy.cz).
 */

// CORS hlavičky — appka na GitHub Pages smí volat tenhle Worker odkudkoli
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

/**
 * Skórování v1 — POUZE ze zdarma dostupných ARES dat.
 * Obor (CZ-NACE) se zatím jen ZOBRAZUJE, neváhuje se — přesná mapa
 * "obor -> vhodnost" čeká na společné doladění (viz poznámka v chatu),
 * abych nevymýšlel NACE kódy nazpaměť.
 *
 * Složky:
 *  - vek firmy (datumVzniku): novější firma = vyšší skóre (Typ A hypotéza)
 *  - pravni forma: drobné/lokální formy > velké korporátní formy
 * Výstup: 0-100, rozdělené do 4 úrovní.
 */
/**
 * Bodování podle oboru (CZ-NACE) — založeno na skutečné četnosti oborů ve vzorku
 * 1298 inzerentů z plakátů (analýza 7.8.2026, viz předávací dokumentace).
 * Kódy z valné většiny ŽIVĚ OVĚŘENY appkou přes /nace-ciselnik (podlahářství,
 * truhlářství, nábytek, kámen, pohřební služby, pohonné hmoty) — zbytek (optika,
 * elektro, komín, kov, klenoty, střechy, dřevo, reality) doplněn přes Perplexity
 * a NEOVĚŘEN appkou naživo, ale shoda na těch ověřených kategoriích byla 100%,
 * takže je beru jako důvěryhodné. PRVNÍ TESTOVACÍ NASAZENÍ — Myrda porovná
 * výsledek se zkušeností z loňské edice Rychnova, váhy se podle toho doladí.
 *
 * Pořadí je důležité: specifičtější obory (podlahářství, truhlářství...) se
 * testují DŘÍV než obecné "stavebnictví", aby do něj nespadly omylem.
 */
/**
 * Konkrétní CZ-NACE kódy (5místné, leaf úroveň) pro KAŽDOU kategorii —
 * používají se jako SKUTEČNÝ FILTR dotazu do ARES (ne jen skóre), aby se
 * zúžil počet výsledků na naše sledované obory a appka se vešla pod
 * strop ARES (1000 záznamů na dotaz).
 *
 * Míra jistoty u jednotlivých kódů (STAV k 8.8.2026):
 *  - "ověřeno" = viděno naživo v /nace-ciselnik appky (screenshot)
 *  - "Perplexity" = doplněno přes Perplexity, NEOVĚŘENO appkou naživo
 * V komentáři u každé kategorie je uvedeno, co platí.
 */
const NACE_KODY = {
  reality: { vaha: 25, kody: ["68110", "68120", "68200", "68310", "68320"] }, // Perplexity
  pohostinství: { vaha: 25, kody: ["56110", "56210", "56290", "56300"] }, // odvozeno z ověřených 561/562/563
  autoškola: { vaha: 20, kody: ["85530"] }, // ověřeno
  autoservis: { vaha: 20, kody: ["95310", "95320"] }, // ověřeno
  "podlahářství": { vaha: 15, kody: ["43330", "16220", "47530"] }, // ověřeno
  "truhlářství/nábytek": { vaha: 15, kody: ["16230", "43320", "31000", "46470", "47550", "95240"] }, // ověřeno
  kamenictví: { vaha: 15, kody: ["23700", "08110"] }, // ověřeno
  kominictví: { vaha: 15, kody: ["81220"] }, // Perplexity
  střechy: { vaha: 15, kody: ["43910", "43410"] }, // Perplexity
  "palivové dřevo": { vaha: 15, kody: ["02200", "16100", "16210", "16290", "46730"] }, // Perplexity
  kovovýroba: {
    vaha: 15,
    kody: ["25110", "25120", "25400", "25610", "25620", "25910", "25920", "25930", "25940", "25990", "24100", "24200", "24330", "24340", "46720", "47520", "38320"],
  }, // Perplexity
  elektro: { vaha: 15, kody: ["43210", "47540", "46430", "27110", "27120", "33140"] }, // Perplexity
  optika: { vaha: 15, kody: ["47740", "32500", "26700"] }, // Perplexity
  "pohřební služby": { vaha: 15, kody: ["96300"] }, // ověřeno
  klenotnictví: { vaha: 10, kody: ["46480", "47770", "32120", "32130", "95250"] }, // 46480+47770 ověřeno, zbytek Perplexity
  "stavebnictví (obecně)": { vaha: 20, kody: ["43240", "43350", "43420", "43500", "43600", "43990"] }, // ověřeno
};

// Plochý seznam VŠECH sledovaných kódů — použije se jako výchozí filtr do ARES,
// aby appka nestahovala úplně všechny firmy v obci, ale jen naše top-obory.
const VSECHNY_SLEDOVANE_NACE_KODY = Object.values(NACE_KODY).flatMap((k) => k.kody);

function obodujOborNace(czNaceList) {
  if (!czNaceList || czNaceList.length === 0) return null;
  const kodySet = new Set(czNaceList.map(String));
  for (const [obor, data] of Object.entries(NACE_KODY)) {
    if (data.kody.some((k) => kodySet.has(k))) {
      return { obor, vaha: data.vaha };
    }
  }
  return null;
}

function skoreFirmy(subjekt) {
  let skore = 50; // základ
  const duvody = [];

  // --- věk firmy ---
  if (subjekt.datumVzniku) {
    const vznik = new Date(subjekt.datumVzniku);
    const dnes = new Date();
    const rokyOd = (dnes - vznik) / (1000 * 60 * 60 * 24 * 365.25);
    if (rokyOd <= 3) {
      skore += 30;
      duvody.push(`Založena před ${rokyOd.toFixed(1)} lety (< 3 roky) — silný signál "nová firma, dělá změnu"`);
    } else if (rokyOd <= 7) {
      skore += 15;
      duvody.push(`Založena před ${rokyOd.toFixed(1)} lety (3–7 let) — mírný plus`);
    } else {
      duvody.push(`Založena před ${rokyOd.toFixed(0)} lety — zavedená firma, neutrální`);
    }
  } else {
    duvody.push("Datum vzniku neznámé — bez vlivu na skóre");
  }

  // --- právní forma ---
  // 101/102 = fyzická osoba podnikající (OSVČ), 112 = s.r.o. -- lokální/malé formy
  // velké/korporátní formy (a.s. 121, státní podnik, atd.) o něco níž
  const pf = subjekt.pravniForma;
  const maleFormy = ["101", "102", "112", "113", "104"]; // OSVČ, v.o.s., s.r.o., ...
  const velkeFormy = ["121", "205", "301"]; // a.s. a podobné — orientační, OVĚŘIT
  if (maleFormy.includes(pf)) {
    skore += 20;
    duvody.push("Právní forma odpovídá malé/lokální firmě (+20)");
  } else if (velkeFormy.includes(pf)) {
    skore -= 10;
    duvody.push("Právní forma odpovídá větší/korporátní struktuře (-10, OVĚŘIT kód formy)");
  } else {
    duvody.push(`Právní forma kód ${pf || "neznámý"} — nezařazeno do tabulky, neutrální`);
  }

  // --- obor (CZ-NACE) ---
  const oborZasah = obodujOborNace(subjekt.czNace);
  if (oborZasah) {
    skore += oborZasah.vaha;
    duvody.push(`Obor "${oborZasah.obor}" (CZ-NACE) — časté odvětví mezi kupujícími inzerce (+${oborZasah.vaha})`);
  } else {
    duvody.push("Obor mimo naši sledovanou top-kategorii — neutrální (0)");
  }

  skore = Math.max(0, Math.min(100, skore));

  let uroven;
  if (skore >= 70) uroven = 1;
  else if (skore >= 50) uroven = 2;
  else if (skore >= 30) uroven = 3;
  else uroven = 4;

  return { skore, uroven, duvody };
}

async function nactiNaceCiselnik() {
  const filtr = { kodCiselniku: "CzNace", pocet: 1000 };
  const resp = await fetch(`${ARES_BASE}/ciselniky-nazevniky/vyhledat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filtr),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ARES (ciselnik) vrátil ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const polozky = data.ciselniky?.[0]?.polozkyCiselniku || [];
  const mapa = {};
  for (const p of polozky) {
    const nazevCs = p.nazev?.find((n) => n.kodJazyka === "cs") || p.nazev?.[0];
    mapa[p.kod] = nazevCs?.nazev || p.kod;
  }
  return mapa;
}

/**
 * ZMĚNA 8.8.2026: Předchozí přístup (zjistiKodObce -> samostatný endpoint
 * /standardizovane-adresy/vyhledat) se v živém testu ukázal nefunkční a
 * appka ho nedokázala ověřit (žádný ze 4 zkoušených tvarů dotazu nezabral).
 * Místo dalšího hádání používáme pole "textovaAdresa" přímo v HLAVNÍM
 * vyhledávacím filtru (sidlo.textovaAdresa) — to je stejný endpoint, který
 * appka celý večer prokazatelně úspěšně používala (kodObce varianta).
 * Riziko: textovaAdresa hledá volný text v adrese, takže méně přesné jméno
 * obce by teoreticky mohlo najít i podobně znějící místo jinde v ČR — proto
 * appka vrací "obecPouzita" s adresou první nalezené firmy, abys hned viděl,
 * kde appka reálně hledala.
 */

async function hledejFirmy(kodObce, textAdresy, naceList, pravniFormaList, obchodniJmeno, start = 0, pocet = 50) {
  const filtr = {
    start,
    pocet,
  };
  if (kodObce) {
    filtr.sidlo = { kodObce };
  } else if (textAdresy) {
    filtr.sidlo = { textovaAdresa: textAdresy };
  }
  if (obchodniJmeno) {
    filtr.obchodniJmeno = obchodniJmeno;
  }
  if (pravniFormaList && pravniFormaList.length > 0) {
    filtr.pravniForma = pravniFormaList;
  }
  if (naceList && naceList.length > 0) {
    filtr.czNace = naceList;
  }

  const resp = await fetch(`${ARES_BASE}/ekonomicke-subjekty/vyhledat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filtr),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ARES vrátil ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Živý test (7.8.2026, Rychnov n.Kn.) potvrdil: ARES odmítne CELÝ dotaz chybou
 * "příliš mnoho výsledků", pokud filtr odpovídá >1000 záznamům — netýká se to
 * jen stránkované části, ale úplně celého (nefiltrovaného stránkováním) součtu.
 * Přidáním OSVČ do filtru se to stalo reálným problémem (1907 pro Rychnov n.Kn.).
 * Řešení: rozděl právní formy do dvou skupin (OSVČ / firmy) a zavolej ARES 2x
 * zvlášť, výsledky slij. Zmenší to pravděpodobnost přesažení stropu u většiny
 * měst. ZNÁMÉ OMEZENÍ: u opravdu velkých měst (desetitisíce firem) může
 * i jedna skupina sama o sobě strop překročit — pak dotaz stále selže a bude
 * nutné přidat další úroveň dělení (např. podle NACE), zatím neřešeno.
 * ZNÁMÉ OMEZENÍ 2: hluboké stránkování ("Načíst další") u rozděleného dotazu
 * není 100% přesné (obě skupiny stránkují nezávisle na sobě), ale pro první
 * várky nejlépe skórovaných firem to funguje spolehlivě.
 */
async function hledejFirmyRozdeleno(kodObce, textAdresy, naceList, pravniFormaList, obchodniJmeno, start, pocet) {
  if (!pravniFormaList || pravniFormaList.length <= 1) {
    return hledejFirmy(kodObce, textAdresy, naceList, pravniFormaList, obchodniJmeno, start, pocet);
  }
  const osvcFormy = pravniFormaList.filter((f) => ["101", "102"].includes(f));
  const firemniFormy = pravniFormaList.filter((f) => !["101", "102"].includes(f));
  const skupiny = [osvcFormy, firemniFormy].filter((s) => s.length > 0);
  if (skupiny.length <= 1) {
    return hledejFirmy(kodObce, textAdresy, naceList, pravniFormaList, obchodniJmeno, start, pocet);
  }
  const vysledky = await Promise.all(
    skupiny.map((skupina) => hledejFirmy(kodObce, textAdresy, naceList, skupina, obchodniJmeno, start, pocet))
  );
  return {
    pocetCelkem: vysledky.reduce((soucet, v) => soucet + (v.pocetCelkem || 0), 0),
    ekonomickeSubjekty: vysledky.flatMap((v) => v.ekonomickeSubjekty || []),
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/nace-ciselnik") {
      try {
        const mapa = await nactiNaceCiselnik();
        return jsonResponse({ mapa });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/search") {
      const obec = url.searchParams.get("obec");
      const kodObceParam = url.searchParams.get("kodObce");
      const naceParam = url.searchParams.get("nace"); // čárkou oddělené kódy, přepíše výchozí sledované obory
      const vsechnyObory = url.searchParams.get("vsechnyObory") === "1"; // únikový poklop — vypne NACE filtr úplně
      const start = parseInt(url.searchParams.get("start") || "0", 10);
      const obchodniJmeno = url.searchParams.get("jmeno"); // volitelné hledání podle (části) názvu firmy

      const kodObce = kodObceParam ? parseInt(kodObceParam, 10) : null;
      const textAdresy = !kodObce && obec ? obec.trim() : null;
      const obecPouzita = textAdresy || (kodObce ? `kód obce ${kodObce}` : null);

      if (!kodObce && !textAdresy && !obchodniJmeno) {
        return jsonResponse({ error: "Chybí parametr ?obec=, ?kodObce=, nebo ?jmeno=" }, 400);
      }

      // Výchozí chování: filtruj rovnou na naše sledované obory (viz NACE_KODY výš),
      // aby se appka vešla pod strop ARES a zároveň hledala jen relevantní firmy.
      // ?nace=... přepíše vlastním seznamem, ?vsechnyObory=1 filtr úplně vypne
      // (pozor, u obcí s hodně firmami pak snadno narazíš na strop 1000).
      let naceList;
      if (naceParam) {
        naceList = naceParam.split(",").map((s) => s.trim());
      } else if (!vsechnyObory && (obec || kodObce)) {
        naceList = VSECHNY_SLEDOVANE_NACE_KODY;
      } else {
        naceList = null;
      }

      const pfParam = url.searchParams.get("pravniForma"); // čárkou oddělené kódy, volitelné
      const pravniFormaList = pfParam ? pfParam.split(",").map((s) => s.trim()) : null;

      try {
        const vysledek = await hledejFirmyRozdeleno(kodObce, textAdresy, naceList, pravniFormaList, obchodniJmeno, start, 50);
        const subjekty = (vysledek.ekonomickeSubjekty || []).map((s) => {
          const { skore, uroven, duvody } = skoreFirmy(s);
          return {
            ico: s.ico,
            nazev: s.obchodniJmeno,
            obec: s.sidlo?.nazevObce,
            adresa: s.sidlo?.textovaAdresa,
            pravniForma: s.pravniForma,
            czNace: s.czNace || [],
            datumVzniku: s.datumVzniku,
            skore,
            uroven,
            duvody,
          };
        });
        subjekty.sort((a, b) => b.skore - a.skore);

        return jsonResponse({
          pocetCelkem: vysledek.pocetCelkem,
          vraceno: subjekty.length,
          obecPouzita,
          oboroveFiltrovano: !!naceList,
          firmy: subjekty,
        });
      } catch (e) {
        return jsonResponse(
          {
            error: String(e),
            napoveda:
              "Pokud chyba zmiňuje 'příliš mnoho výsledků', appka i tak filtrovala jen sledované obory — problém je v hodně velkém městě. Zkus zúžit přes ?nace=KOD1,KOD2 na jeden konkrétní obor, nebo doplň jméno firmy přes ?jmeno=.",
          },
          500
        );
      }
    }

    return jsonResponse(
      { info: "MLF ARES proxy běží. Použij /search?obec=NazevObce&nace=volitelne,kody" },
      200
    );
  },
};
