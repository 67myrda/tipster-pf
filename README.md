# MLF — Marketing Lead Finder, v1

## Co to je
Appka pro filtrování firem podle "vhodnosti" k oslovení s nabídkou inzerce.
Vstup: název obce. Výstup: seřazený seznam firem ve 4 úrovních, se
skóre a odkazy pro rychlé ověření (Google, Meta Ad Library, Google Ads
Transparency).

## Co je JISTĚ hotové a funkční
- Worker volá reálný, ověřený ARES endpoint (`POST /ekonomicke-subjekty/vyhledat`)
  se schématem ověřeným přímo z OpenAPI specifikace ARES.
- Filtrování podle obce (`sidlo.textovaAdresa`) a volitelně podle oboru
  (`czNace`) je podle schématu podporované.
- Skórovací logika (věk firmy, právní forma) je jednoduchá, transparentní,
  a u každé firmy vidíš PROČ dostala dané skóre.

## Co je NEOVĚŘENO — vyžaduje tvůj test
1. **Neprovedl jsem živé volání ARES API** (nemám k tomu síťový přístup
   z tohoto prostředí) — kód odpovídá dokumentaci, ale první ostré
   spuštění může odhalit drobnosti (formát dat, limity dotazů apod.).
   → Po nasazení zkus jako první test obec "Rychnov nad Kněžnou" a
   podívej se, jestli seznam vypadá smysluplně.
2. **Kódy právní formy** (101/102/112.../121) v `worker.js` jsou můj
   nejlepší odhad, ne ověřený číselník — označeno komentářem OVĚŘIT.
   Skóre kvůli tomu není přesné, jen orientační v1.
3. **Obor (NACE)** se v v1 jen ZOBRAZUJE, neváhuje se do skóre — chybí
   ověřená mapa "obor → vhodnost". Řešení příště: buď mi dej pár
   příkladů kódů, které chceš zvýhodnit/znevýhodnit, nebo použijeme
   `/ciselniky-nazevniky/vyhledat` k dotažení názvů oborů, ať to
   vybíráme podle jmen, ne nazpaměť napsaných kódů.

## Nasazení (stejný postup jako u AI kouče)

### 1. Cloudflare Worker (ARES proxy)
1. dash.cloudflare.com → Workers & Pages → Create → Create Worker
2. Pojmenuj např. `mlf-ares-proxy`
3. Vlož obsah `worker.js` do editoru, klikni Deploy
4. Zkopíruj adresu Workeru (něco jako `mlf-ares-proxy.tvuj-ucet.workers.dev`)

### 2. GitHub Pages (appka)
1. Nové repo, např. `mlf-tool` (67myrda účet, stejně jako ostatní appky)
2. Nahraj `index.html` do repa
3. Settings → Pages → zapnout na `main` branch
4. Appka poběží na `67myrda.github.io/mlf-tool/`

### 3. Propojení
Otevři appku, do pole "Adresa Worker proxy" vlož URL z kroku 1,
vyhledej "Rychnov nad Kněžnou" → zkontroluj výsledky.

## Co záměrně NENÍ v téhle verzi (increment 2+)
- **Trvalé úložiště** (Firestore) — výsledky se teď jen zobrazí, nic
  se neukládá. Přidání = nový Firebase projekt, stejný vzor jako AI kouč.
- **Zápis výsledku návštěvy** (K/P/N/X ze sešitu) — navazuje na Firestore výše.
- **AI enrichment přes Claude** — mám to připravené architektonicky
  (stejný vzor Worker+Secret jako u AI kouče), ale potřebuje tvůj
  samostatný Anthropic API klíč a rozhodnutí, kdy do procesu vstoupí
  (na celý seznam je to drahé, na top 10-20 z úrovně 1 dává smysl).
- **Napojení na Tahák appku** — vědomě odloženo, jak jsme se bavili.

## Poznámka k jednomu odkazu
Odkaz na Google Ads Transparency Center v appce je jen předvyplněné
vyhledávání — samotná stránka vyžaduje ruční doladění (viz náš dřívější
rozhovor: oba nástroje jsou spíš ověřovací než objevovací).
