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
 * Kódy obcí (RÚIAN/ČSÚ) — ověřeno ručně přes epusa.cz / risy.cz.
 * "textovaAdresa" jako volný text hledá moc široce (Rychnov n. Kn.
 * vrátilo 2462 výsledků napříč ČR), proto potřebujeme přesný kód.
 * Doplňuj postupně, jak přibývají cílová města. Kód najdeš na
 * epusa.cz (vyhledej obec -> pole "Kód obce") nebo risy.cz.
 */
const KODY_OBCI = {
  "rychnov nad kněžnou": 576069,
  // "dobruška": ???,
  // "opočno": ???,
  // "solnice": ???,
  // ... doplnit před rozšířením na další obce
};

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
 * Dohledá kód obce (RÚIAN) podle názvu přes ARES standardizaci adres.
 * STAV: NEOVĚŘENO ŽIVĚ — endpoint /standardizovane-adresy/vyhledat existuje
 * v oficiálním ARES OpenAPI schématu a přijímá "komplexní filtr", ale
 * přesný název pole pro volný text (předpoklad: "textovaAdresa", po vzoru
 * ostatních filtrů v tomtéž API) jsem nemohl otestovat živě (bez síťového
 * přístupu k ares.gov.cz z mého prostředí). PRVNÍ OSTRÉ POUŽITÍ OVĚŘ:
 * zadej známou obec (např. "Rychnov nad Kněžnou") a zkontroluj, že vrácené
 * kodObce sedí na hodnotu 576069 v tabulce KODY_OBCI níž.
 * Pokud to nebude fungovat, appka se bezpečně vrátí k chybové hlášce
 * (žádné tiché/špatné výsledky) — viz volání v /search níž.
 */
async function zjistiKodObce(nazevObce) {
  try {
    const resp = await fetch(`${ARES_BASE}/standardizovane-adresy/vyhledat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textovaAdresa: nazevObce, pocet: 5 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const adresy = data.standardizovaneAdresy || [];
    // Vezmi první výsledek, jehož název obce se shoduje (case-insensitive) se zadáním,
    // ať nevybereme omylem nějakou ulici/část obce se stejným kódem, ale jiným místem.
    const shoda =
      adresy.find((a) => (a.nazevObce || "").trim().toLowerCase() === nazevObce.trim().toLowerCase()) ||
      adresy[0];
    if (!shoda || !shoda.kodObce) return null;
    return { kodObce: shoda.kodObce, nazevObce: shoda.nazevObce || nazevObce };
  } catch (e) {
    return null;
  }
}

async function hledejFirmy(kodObce, naceList, pravniFormaList, obchodniJmeno, start = 0, pocet = 50) {
  const filtr = {
    start,
    pocet,
  };
  if (kodObce) {
    filtr.sidlo = { kodObce };
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
      const naceParam = url.searchParams.get("nace"); // čárkou oddělené kódy, volitelné
      const start = parseInt(url.searchParams.get("start") || "0", 10);
      const obchodniJmeno = url.searchParams.get("jmeno"); // volitelné hledání podle (části) názvu firmy

      let kodObce = kodObceParam ? parseInt(kodObceParam, 10) : null;
      let obecPouzita = null;
      if (!kodObce && obec) {
        kodObce = KODY_OBCI[obec.trim().toLowerCase()];
        if (kodObce) obecPouzita = obec.trim();
      }
      if (!kodObce && obec) {
        // Obec není v ruční tabulce (cache) -> zkus dohledat automaticky přes ARES/RÚIAN.
        const nalezeno = await zjistiKodObce(obec.trim());
        if (nalezeno) {
          kodObce = nalezeno.kodObce;
          obecPouzita = nalezeno.nazevObce;
        }
      }
      if (!kodObce && !obchodniJmeno) {
        return jsonResponse(
          {
            error: obec
              ? `Obec "${obec}" se nepodařilo dohledat (ani ručně v tabulce, ani automaticky přes ARES). Zkus zavolat ?kodObce=CISLO ručně (kód najdeš na epusa.cz/risy.cz), nebo hledej podle ?jmeno= bez obce.`
              : "Chybí parametr ?obec=, ?kodObce=, nebo ?jmeno=",
          },
          400
        );
      }

      const naceList = naceParam ? naceParam.split(",").map((s) => s.trim()) : null;
      const pfParam = url.searchParams.get("pravniForma"); // čárkou oddělené kódy, volitelné
      const pravniFormaList = pfParam ? pfParam.split(",").map((s) => s.trim()) : null;

      try {
        const vysledek = await hledejFirmy(kodObce, naceList, pravniFormaList, obchodniJmeno, start, 50);
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
          kodObcePouzity: kodObce,
          firmy: subjekty,
        });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 500);
      }
    }

    return jsonResponse(
      { info: "MLF ARES proxy běží. Použij /search?obec=NazevObce&nace=volitelne,kody" },
      200
    );
  },
};
