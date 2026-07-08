/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      /* New Xero apps (created on/after 2 Mar 2026) must use granular scopes.
         P&L is the only report the core six need. offline_access -> refresh token. */
      scopes: 'openid offline_access accounting.reports.profitandloss.read accounting.settings.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic' /* Xero's token endpoint wants HTTP Basic client auth */
    },

    /* Resolve and cache the Xero tenant (organisation) this token is connected to.
       GET /connections returns [{ tenantId, tenantName, tenantType }]. We take the
       first ORGANISATION. Cached in KV so we do not call it on every metrics fetch. */
    async _tenant(env, h) {
      const cached = await env.TOKENS.get('xero:tenant');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      const conns = await h.fetchJson('https://api.xero.com/connections', { headers: { Accept: 'application/json' } });
      const org = (Array.isArray(conns) ? conns : []).find((c) => c.tenantType === 'ORGANISATION') || (conns && conns[0]);
      if (!org || !org.tenantId) { const e = new Error('no tenant'); e.status = 401; throw e; }
      const t = { id: org.tenantId, name: org.tenantName || 'your organisation' };
      await env.TOKENS.put('xero:tenant', JSON.stringify(t));
      return t;
    },

    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens || !tokens.access_token) return { connected: false };
      const t = await this._tenant(env, h);
      return {
        connected: true,
        org: t.name,
        /* Xero's practice/test org is literally named "Demo Company" */
        sandbox: /demo company/i.test(t.name || ''),
        lastSync: null
      };
    },

    /* Resolve the "Wages and Salaries" tracking category id and the FOH option id.
       Needed to filter the P&L to Front of House wages. Cached in KV. The names are
       owner-confirmed: category "Wages and Salaries", option
       "Wages and Salaries - Front of House". */
    _TRACK_CAT: 'Wages and Salaries',
    _TRACK_OPT_FOH: 'Wages and Salaries - Front of House',
    async _fohTracking(env, h) {
      const cached = await env.TOKENS.get('xero:track:foh');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      const t = await this._tenant(env, h);
      const body = await h.fetchJson('https://api.xero.com/api.xro/2.0/TrackingCategories',
        { headers: { Accept: 'application/json', 'Xero-Tenant-Id': t.id } });
      const cats = (body && body.TrackingCategories) || [];
      const cat = cats.find((c) => (c.Name || '').trim().toLowerCase() === this._TRACK_CAT.toLowerCase());
      if (!cat) { const e = new Error('tracking category "' + this._TRACK_CAT + '" not found'); e.status = 404; throw e; }
      const opt = (cat.Options || []).find((o) => (o.Name || '').trim().toLowerCase() === this._TRACK_OPT_FOH.toLowerCase());
      if (!opt) { const e = new Error('tracking option "' + this._TRACK_OPT_FOH + '" not found'); e.status = 404; throw e; }
      const res = { categoryId: cat.TrackingCategoryID, optionId: opt.TrackingOptionID, optionName: opt.Name };
      await env.TOKENS.put('xero:track:foh', JSON.stringify(res));
      return res;
    },

    /* FOH P&L pull. Two independent reads combined:
       1) FOH WAGES: P&L filtered by the FOH tracking option -> wagesSuper only.
          (The tracking category is applied to wage accounts, so the filtered
           report's wage/super lines are the FOH share.)
       2) FOH COGS + FOH SALES base: the UNFILTERED P&L, from which we take only
          the explicitly-FOH cost-of-sales accounts (owner-confirmed strict:
          "COGS - Front of House - GST/Non-GST"). Sales come from Square, not here.
       All ex-GST, straight from Xero, reconcilable to the cent. */
    async fetchFoh(env, h, q) {
      const t = await this._tenant(env, h);
      const hdr = { Accept: 'application/json', 'Xero-Tenant-Id': t.id };

      // 1) FOH wages via tracking filter
      let wagesSuper = null;
      try {
        const tr = await this._fohTracking(env, h);
        const wUrl = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss'
          + '?fromDate=' + q.from + '&toDate=' + q.to
          + '&trackingCategoryID=' + encodeURIComponent(tr.categoryId)
          + '&trackingOptionID=' + encodeURIComponent(tr.optionId);
        const wRep = await h.fetchJson(wUrl, { headers: hdr });
        const wMapped = mapProfitAndLoss(wRep);
        wagesSuper = wMapped.wagesSuper; // null if not journalled yet
      } catch (e) { wagesSuper = null; }

      // 2) FOH COGS from the unfiltered P&L, strict FOH accounts only
      const pUrl = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss'
        + '?fromDate=' + q.from + '&toDate=' + q.to;
      const pRep = await h.fetchJson(pUrl, { headers: hdr });
      const cogs = sumFohCogs(pRep);

      return { cogs, wagesSuper };
    },

    async fetchRange(env, h, q) {
      const t = await this._tenant(env, h);
      const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss'
        + '?fromDate=' + q.from + '&toDate=' + q.to;
      const rep = await h.fetchJson(url, { headers: { Accept: 'application/json', 'Xero-Tenant-Id': t.id } });
      return mapProfitAndLoss(rep);
    },

    /* Monthly trend: Xero's P&L supports periods+timeframe, but pulling each month
       explicitly keeps the section-mapping identical and avoids column-alignment
       surprises. One call per month, well within rate limits for a trend window. */
    async fetchMonthly(env, h, q) {
      const t = await this._tenant(env, h);
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      for (const mo of months) {
        const [y, m] = mo.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const from = mo + '-01';
        const to = mo + '-' + String(lastDay).padStart(2, '0');
        try {
          const rep = await h.fetchJson(
            'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=' + from + '&toDate=' + to,
            { headers: { Accept: 'application/json', 'Xero-Tenant-Id': t.id } }
          );
          const v = mapProfitAndLoss(rep);
          out.revenue.push(v.revenue); out.cogs.push(v.cogs);
          out.wagesSuper.push(v.wagesSuper); out.overheads.push(v.overheads);
        } catch (e) {
          out.revenue.push(null); out.cogs.push(null);
          out.wagesSuper.push(null); out.overheads.push(null);
        }
      }
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token', /* pasted production personal access token: POS_API_TOKEN */
    oauth: {},
    _base: 'https://connect.squareup.com',
    _ver: '2026-05-20',

    _headers(env) {
      return {
        'Authorization': 'Bearer ' + String(env.POS_API_TOKEN || '').trim(),
        'Square-Version': this._ver,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
    },

    /* Locations: gives the business name (account-confirm) and the location ids
       we count. This login has TWO venues; we count ONLY the confirmed one.
       CONFIRMED_LOCATION_NAME pins the count to "Elsewhere at SAM" so the other
       venue never inflates it. Cached so we do not call it on every fetch. */
    _confirmedLocationName: 'Elsewhere at SAM',

    async _locations(env) {
      /* Cache key versioned (v2) so an earlier unfiltered cache is ignored after
         we pinned the confirmed venue. Bump if the confirmed name ever changes. */
      const cached = await env.TOKENS.get('square:locations:v2');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      const res = await fetch(this._base + '/v2/locations', { headers: this._headers(env) });
      if (!res.ok) { const e = new Error('square locations HTTP ' + res.status); e.status = res.status; throw e; }
      const body = await res.json();
      const all = (body.locations || []).map((l) => ({ id: l.id, name: l.name, businessName: l.business_name || l.name }));
      /* Keep only the confirmed venue (exact match, case-insensitive). */
      const want = this._confirmedLocationName.trim().toLowerCase();
      const kept = all.filter((l) => (l.name || '').trim().toLowerCase() === want);
      const use = kept.length ? kept : all; /* fall back to all only if name not found */
      const info = {
        ids: use.map((l) => l.id),
        businessName: (use[0] && use[0].name) || 'your business',
        names: use.map((l) => l.name),
        matchedConfirmed: kept.length > 0,
        allNames: all.map((l) => l.name)
      };
      await env.TOKENS.put('square:locations:v2', JSON.stringify(info));
      return info;
    },

    async status(env, h) {
      if (!env.POS_API_TOKEN) return { connected: false };
      const loc = await this._locations(env);
      return {
        connected: true,
        org: loc.businessName,
        sandbox: false, /* production host only; a sandbox token 401s here */
        lastSync: null
      };
    },

    /* Count COMPLETED orders in [from,to], venue timezone, trading-day rollover.
       Refunds/returns are separate return-orders and are NOT counted; voided/
       cancelled are excluded by the COMPLETED state filter. Pages via cursor. */
    async _countRange(env, from, to, tz, rollover) {
      const loc = await this._locations(env);
      const startUtc = localDayStartToUtc(from, tz, rollover);
      const endUtc = localDayStartToUtc(addDays(to, 1), tz, rollover); /* exclusive end */
      let count = 0, cursor = null, pages = 0;
      do {
        const q = {
          location_ids: loc.ids,
          return_entries: true,
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: startUtc, end_at: endUtc } },
              state_filter: { states: ['COMPLETED'] }
            },
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
          },
          limit: 500
        };
        if (cursor) q.cursor = cursor;
        const res = await fetch(this._base + '/v2/orders/search', {
          method: 'POST', headers: this._headers(env), body: JSON.stringify(q)
        });
        if (!res.ok) { const e = new Error('square search HTTP ' + res.status); e.status = res.status; throw e; }
        const body = await res.json();
        count += (body.order_entries || []).length;
        cursor = body.cursor || null;
        pages++;
      } while (cursor && pages < 200);
      return count;
    },

    async fetchRange(env, h, q) {
      const count = await this._countRange(env, q.from, q.to, q.tz, q.rollover || 0);
      return { count };
    },

    /* Build a map: catalog_object_id (item variation) -> { itemName, categoryName }.
       Line items on orders carry catalog_object_id (the VARIATION id) but not the
       category. We page the catalog for ITEM objects (which include their variations
       and their reporting_category / category id), plus CATEGORY objects for names,
       and produce a variation-id -> category lookup. Cached in KV (catalog changes
       rarely; a manual refresh endpoint clears it). Needs ITEMS_READ on the token. */
    async _catalogMap(env) {
      const cached = await env.TOKENS.get('square:catalogmap:v1');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }

      // 1) category id -> name
      const catNames = {};
      let cursor = null, pages = 0;
      do {
        const url = this._base + '/v2/catalog/list?types=CATEGORY' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const res = await fetch(url, { headers: this._headers(env) });
        if (!res.ok) { const e = new Error('square catalog(categories) HTTP ' + res.status); e.status = res.status; throw e; }
        const body = await res.json();
        for (const obj of (body.objects || [])) {
          if (obj.type === 'CATEGORY' && obj.category_data) catNames[obj.id] = obj.category_data.name;
        }
        cursor = body.cursor || null; pages++;
      } while (cursor && pages < 100);

      // 2) item -> its category; expand to each variation id
      const varToCat = {};   // variationId -> categoryName
      const varToItem = {};  // variationId -> itemName
      cursor = null; pages = 0;
      do {
        const url = this._base + '/v2/catalog/list?types=ITEM' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const res = await fetch(url, { headers: this._headers(env) });
        if (!res.ok) { const e = new Error('square catalog(items) HTTP ' + res.status); e.status = res.status; throw e; }
        const body = await res.json();
        for (const obj of (body.objects || [])) {
          if (obj.type !== 'ITEM' || !obj.item_data) continue;
          const idata = obj.item_data;
          const itemName = idata.name || '(unnamed)';
          /* Category resolution across Square versions: reporting_category, then
             categories[], then legacy category_id. */
          let catId = null;
          if (idata.reporting_category && idata.reporting_category.id) catId = idata.reporting_category.id;
          else if (Array.isArray(idata.categories) && idata.categories[0]) catId = idata.categories[0].id;
          else if (idata.category_id) catId = idata.category_id;
          const catName = (catId && catNames[catId]) || 'Uncategorised';
          for (const v of (idata.variations || [])) {
            if (v && v.id) { varToCat[v.id] = catName; varToItem[v.id] = itemName; }
          }
        }
        cursor = body.cursor || null; pages++;
      } while (cursor && pages < 500);

      const map = { varToCat, varToItem, categories: Object.values(catNames) };
      await env.TOKENS.put('square:catalogmap:v1', JSON.stringify(map));
      return map;
    },

    /* Aggregate NON-FOOD item sales over [from,to]: itemised list with quantity and
       net sales (ex-GST-adjusted where possible), sorted by sales desc. "Food" is
       the kitchen category; everything else is FOH. Also returns FOH net sales total
       (sum of the non-food lines) which powers the FOH revenue card (badged Square).
       Net sales convention: gross_sales - discounts (Square's "net sales"); tax is
       excluded. For AU, inclusive tax stays in gross, so we subtract total_tax too
       to approximate ex-GST net, and badge it clearly as an indicative Square figure. */
    _FOOD_CATEGORY: 'Food',
    async _itemSales(env, from, to, tz, rollover) {
      const loc = await this._locations(env);
      const map = await this._catalogMap(env);
      const startUtc = localDayStartToUtc(from, tz, rollover);
      const endUtc = localDayStartToUtc(addDays(to, 1), tz, rollover);
      const items = {}; // key: itemName -> { name, category, qty, netSales }
      let cursor = null, pages = 0;
      do {
        const body_q = {
          location_ids: loc.ids,
          return_entries: false, /* need full orders for line_items */
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: startUtc, end_at: endUtc } },
              state_filter: { states: ['COMPLETED'] }
            },
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
          },
          limit: 200
        };
        if (cursor) body_q.cursor = cursor;
        const res = await fetch(this._base + '/v2/orders/search', {
          method: 'POST', headers: this._headers(env), body: JSON.stringify(body_q)
        });
        if (!res.ok) { const e = new Error('square item search HTTP ' + res.status); e.status = res.status; throw e; }
        const body = await res.json();
        for (const order of (body.orders || [])) {
          for (const li of (order.line_items || [])) {
            const varId = li.catalog_object_id || null;
            const category = (varId && map.varToCat[varId]) || 'Uncategorised';
            if ((category || '').trim().toLowerCase() === this._FOOD_CATEGORY.toLowerCase()) continue; // skip kitchen
            const name = li.name || (varId && map.varToItem[varId]) || '(custom item)';
            const qty = parseFloat(li.quantity || '0') || 0;
            const gross = (li.gross_sales_money && li.gross_sales_money.amount) || 0;
            const disc = (li.total_discount_money && li.total_discount_money.amount) || 0;
            const tax = (li.total_tax_money && li.total_tax_money.amount) || 0;
            const netCents = gross - disc - tax; // approx ex-GST net
            const key = name;
            if (!items[key]) items[key] = { name, category, qty: 0, netSales: 0 };
            items[key].qty += qty;
            items[key].netSales += netCents / 100;
          }
        }
        cursor = body.cursor || null; pages++;
      } while (cursor && pages < 300);

      const list = Object.values(items)
        .map((it) => ({ name: it.name, category: it.category, qty: Math.round(it.qty * 100) / 100, sales: Math.round(it.netSales * 100) / 100 }))
        .sort((a, b) => b.sales - a.sales);
      const fohNetSales = Math.round(list.reduce((s, it) => s + it.sales, 0) * 100) / 100;
      return { items: list, fohNetSales };
    },

    /* FOH POS pull: itemised non-food list + FOH net sales total. */
    async fetchFoh(env, h, q) {
      const { items, fohNetSales } = await this._itemSales(env, q.from, q.to, q.tz, q.rollover || 0);
      return { items, fohNetSales };
    },

    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months, count: [] };
      for (const mo of months) {
        const [y, m] = mo.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        try {
          const c = await this._countRange(env, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'), q.tz, q.rollover || 0);
          out.count.push(c);
        } catch (e) { out.count.push(null); }
      }
      return out;
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ---- Date helpers for POS trading-day boundaries (timezone + rollover) ----
   The page sends explicit YYYY-MM-DD ranges plus the venue tz and rollover hour.
   Square wants RFC3339 UTC timestamps. We convert "local trading day start" to
   UTC using the venue's actual offset (handles AEST/AEDT correctly). Rollover
   shifts the boundary later by N hours, so e.g. 3am sales count to the prior
   trading day (start_at = 03:00 local, end exclusive = next day 03:00 local). */
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* Offset (minutes) of a tz at a given UTC instant, via Intl. */
function tzOffsetMinutes(tz, atUtc) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(atUtc)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - atUtc.getTime()) / 60000);
}
/* Local trading-day start (date at rollover:00 local) -> RFC3339 UTC string. */
function localDayStartToUtc(ymd, tz, rollover) {
  const [y, m, d] = ymd.split('-').map(Number);
  const roll = Math.max(0, Math.min(6, rollover || 0));
  /* First guess UTC assuming no offset, then correct using the tz offset at that
     instant (two-pass handles DST edges safely for hour-level boundaries). */
  let guess = Date.UTC(y, m - 1, d, roll, 0, 0);
  let off = tzOffsetMinutes(tz, new Date(guess));
  let utc = Date.UTC(y, m - 1, d, roll, 0, 0) - off * 60000;
  off = tzOffsetMinutes(tz, new Date(utc));
  utc = Date.UTC(y, m - 1, d, roll, 0, 0) - off * 60000;
  return new Date(utc).toISOString();
}

/* Sum ONLY the explicitly-FOH cost-of-sales accounts, owner-confirmed strict:
   "COGS - Front of House - GST" and "COGS - Front of House - Non-GST". Shared
   lines (packaging, freight, functions) are deliberately excluded so the FOH
   number is unambiguous. Walks the Cost of Sales section leaves by name. */
function _isFohCogsAccount(name) {
  const n = (name || '').toLowerCase();
  // Front-of-house cost line, but never a wage/super line (those are tracked
  // separately). Matches "COGS - Front of House - GST/Non-GST" and close variants.
  if (/wage|salar|super/.test(n)) return false;
  const isFront = /front of house/.test(n) || /\bfoh\b/.test(n);
  const isCost = /cogs|cost of (sales|goods)/.test(n);
  return isFront && isCost;
}
function sumFohCogs(rep) {
  const report = rep && rep.Reports && rep.Reports[0];
  if (!report || !Array.isArray(report.Rows)) throw new Error('unexpected P&L shape');
  let total = 0, saw = false;
  for (const section of report.Rows) {
    if (section.RowType !== 'Section' || !Array.isArray(section.Rows)) continue;
    if (!_isCostOfSalesTitle(section.Title || '')) continue;
    for (const row of section.Rows) {
      const l = _leaf(row);
      if (!l) continue;
      if (_isFohCogsAccount(l.name)) { total += l.amount; saw = true; }
    }
  }
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  return saw ? round2(total) : null;
}

/* ============================================================================
   Xero P&L mapper - turns the report's nested Sections into the four money
   figures, per the LOCKED definitions in kpi-spec.md. Reads the owner's chart
   of accounts as-is; never re-categorises. Figures are ex-GST (the P&L report
   is prepared on the org's tax basis; Xero's P&L excludes GST).

   kpi-spec mapping:
     revenue    = Income/Revenue section, trading income only (Other Income excluded)
     cogs       = Cost of Sales section
     wagesSuper = wage + super accounts (matched by keyword; CONFIRMED with the
                  owner at reconciliation - a business question, not technical)
     overheads  = Operating Expenses section MINUS the wage/super accounts
                  (and minus any cost-of-sales lines that sit inside expenses)

   The report shape (verified against Xero docs, Jun 2026): Reports[0].Rows is an
   array of RowType 'Section' objects, each with a Title and nested Rows; each
   leaf 'Row' has Cells: [ {Value: accountName}, {Value: amount} ]. A section's
   own summary appears as a SummaryRow but we sum leaf rows ourselves so the
   wage/overhead split is exact. */

/* Keyword tests. Wage/super matching is the fragile part kpi-spec flags: match
   generously, then confirm the exact account list with the owner. */
function _isWageAccount(name) {
  const n = (name || '').toLowerCase();
  /* Explicitly NOT wages, even though they mention staff: training and generic
     "staff costs" are overheads here (owner-confirmed). Amenities too. */
  if (/staff (training|amenities|uniforms?|welfare)/.test(n)) return false;
  if (/^staff costs?$/.test(n.trim())) return false;
  if (/super(annuation)?/.test(n)) return true;
  if (/\b(wages?|salar(y|ies)|payroll)\b/.test(n)) return true;
  return false;
}
function _isOtherIncome(name) {
  const n = (name || '').toLowerCase();
  /* Other Income/Revenue (interest, one-off asset sales, rebates) is excluded
     from Revenue so it cannot distort Revenue or ACS. Trading income only.
     Note: this org lists "Other Revenue" as a line INSIDE Trading Income, so we
     exclude by line name, not only by section. */
  return /\b(other income|other revenue|interest( income| received)?|gain on|asset sale|dividend|rounding)\b/.test(n);
}
function _isCostOfSalesTitle(title) {
  return /cost of (sales|goods)|cogs|direct costs/i.test(title || '');
}
function _isIncomeTitle(title) {
  const t = title || '';
  if (/other income/i.test(t)) return false;
  if (_isCostOfSalesTitle(t)) return false; /* "Cost of Sales" contains "Sales" - exclude first */
  return /^income$|^revenue$|^sales$|trading income|^operating income$/i.test(t);
}
function _isOtherIncomeTitle(title) {
  return /other income/i.test(title || '');
}
function _isExpenseTitle(title) {
  return /^(less )?operating expenses$|^expenses$|overheads/i.test(title || '');
}

/* Pull [name, amount] from a leaf Row's cells. Amount may carry commas. */
function _leaf(row) {
  if (!row || row.RowType !== 'Row' || !Array.isArray(row.Cells) || row.Cells.length < 2) return null;
  const name = (row.Cells[0] && row.Cells[0].Value) || '';
  const raw = (row.Cells[row.Cells.length - 1] && row.Cells[row.Cells.length - 1].Value) || '';
  if (name === '' && raw === '') return null;
  const num = parseFloat(String(raw).replace(/,/g, '').replace(/[()]/g, (m) => (m === '(' ? '-' : '')));
  if (!isFinite(num)) return null;
  return { name, amount: num };
}

function mapProfitAndLoss(rep) {
  const report = rep && rep.Reports && rep.Reports[0];
  if (!report || !Array.isArray(report.Rows)) throw new Error('unexpected P&L shape');

  let revenue = 0, cogs = 0, wagesSuper = 0, overheads = 0;
  let sawIncome = false, sawExpenses = false, sawWageAccount = false, sawCostOfSales = false;

  for (const section of report.Rows) {
    if (section.RowType !== 'Section' || !Array.isArray(section.Rows)) continue;
    const title = section.Title || '';
    const leaves = section.Rows.map(_leaf).filter(Boolean);

    if (_isOtherIncomeTitle(title)) {
      continue; /* Other Income never enters Revenue */
    }
    if (_isIncomeTitle(title)) {
      sawIncome = true;
      for (const l of leaves) { if (!_isOtherIncome(l.name)) revenue += l.amount; }
      continue;
    }
    if (_isCostOfSalesTitle(title)) {
      /* Wages/super sometimes live INSIDE Cost of Sales (this org files a
         "COGS WAGES" sub-section). Labour must always be tracked as Wage %, never
         left in cost of goods (kpi-spec rule 6 + metric 4/5). Pull them out here. */
      sawCostOfSales = true;
      for (const l of leaves) {
        if (_isWageAccount(l.name)) { wagesSuper += l.amount; sawWageAccount = true; }
        else cogs += l.amount;
      }
      continue;
    }
    if (_isExpenseTitle(title)) {
      sawExpenses = true;
      for (const l of leaves) {
        if (_isWageAccount(l.name)) { wagesSuper += l.amount; sawWageAccount = true; }
        else if (_isCostOfSalesTitle(l.name)) cogs += l.amount; /* stray CoS inside expenses */
        else overheads += l.amount;
      }
      continue;
    }
    /* Untitled or unusual section: classify each leaf individually so nothing is
       silently dropped. Default unknowns to overheads except clear wage lines. */
    for (const l of leaves) {
      if (_isWageAccount(l.name)) { wagesSuper += l.amount; sawWageAccount = true; }
    }
  }

  if (!sawIncome && !sawExpenses && !sawCostOfSales) throw new Error('no recognisable P&L sections');

  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  return {
    revenue: round2(revenue),
    cogs: round2(cogs),
    /* No wage/super account present for this period (e.g. payroll not journalled
       yet) -> null, so Wage % shows "not configured" rather than a false 0%.
       When payroll is posted, real accounts appear and this becomes a number. */
    wagesSuper: sawWageAccount ? round2(wagesSuper) : null,
    overheads: round2(overheads)
  };
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  /* Trim: a trailing newline on a pasted secret makes the Basic auth header
     malformed and Xero returns 400 at the token exchange. */
  const id = String(env[cfg.clientIdSecret] || '').trim();
  const secret = String(env[cfg.clientSecretSecret] || '').trim();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  /* Trim in case a credential was pasted with a trailing space/newline - a blank
     or whitespace-padded client_id is the usual cause of Xero "invalid client_id". */
  const clientId = String(env[cfg.clientIdSecret] || '').trim();
  if (!clientId) {
    /* Never leak the value; just say plainly it is missing so the fix is obvious. */
    return new Response('This connection is not finished yet: the app id has not reached the dashboard. Your AI will check the saved credential and try again in a moment.', { status: 503 });
  }
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    /* Read Xero's specific reason (invalid_grant, invalid_client, etc.) to make
       the failure diagnosable. The body carries no user secrets. */
    let reason = '';
    try { reason = (await res.text()).slice(0, 300); } catch (e) {}
    await env.TOKENS.put('oautherror:' + source, 'HTTP ' + res.status + ' ' + reason, { expirationTtl: 900 });
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

/* One FOH period slot: Xero FOH (cogs, wagesSuper) + Square FOH (items, sales). */
async function fetchFohSlot(env, q) {
  const out = { accounting: null, pos: null };
  const acc = ADAPTERS.accounting, pos = ADAPTERS.pos;
  try {
    if (acc && acc.configured && acc.fetchFoh) {
      out.accounting = await acc.fetchFoh(env, makeHelpers(env, 'accounting'), q);
      await noteSync(env, 'accounting');
    }
  } catch (e) { out.accounting = null; }
  try {
    if (pos && pos.configured && pos.fetchFoh) {
      out.pos = await pos.fetchFoh(env, makeHelpers(env, 'pos'), q);
      await noteSync(env, 'pos');
    }
  } catch (e) { out.pos = null; }
  return out;
}

const FOH_CACHE_TTL = 120;

async function apiFoh(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const tz = url.searchParams.get('tz') || 'Australia/Melbourne';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));
  const base = { tz, rollover };

  const [sAcc, sPos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos')
  ]);

  const cacheKey = 'fohcache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchFohSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchFohSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchFohSlot(env, { ...base, ...yoy }) : null;
    data = { generatedAt: new Date().toISOString(), periods };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: FOH_CACHE_TTL }); } catch (e) {}
    }
  }

  /* Shape a period into the card values the FOH page renders. */
  const shape = (slot) => {
    if (!slot) return null;
    const acc = slot.accounting || {};
    const pos = slot.pos || {};
    const sales = (pos.fohNetSales != null) ? pos.fohNetSales : null;      // Square, indicative
    const cogs = (acc.cogs != null) ? acc.cogs : null;                     // Xero, ex-GST
    const wages = (acc.wagesSuper != null) ? acc.wagesSuper : null;        // Xero, ex-GST
    const pct = (n) => (sales && sales !== 0 && n != null) ? Math.round((n / sales) * 1000) / 10 : null;
    return {
      sales, cogs, wages,
      cogsPct: pct(cogs), wagesPct: pct(wages),
      items: Array.isArray(pos.items) ? pos.items : null
    };
  };

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos },
    cur: shape(data.periods.cur),
    prev: shape(data.periods.prev),
    yoy: shape(data.periods.yoy)
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    if (path === '/api/foh' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiFoh(env, url);
    }
    if (path === '/api/foh/refresh-catalog' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      await env.TOKENS.delete('square:catalogmap:v1');
      return json({ ok: true, message: 'Catalog map cleared; it rebuilds on next load.' });
    }
    if (path === '/api/oautherror' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source') || 'accounting';
      const reason = await env.TOKENS.get('oautherror:' + source);
      return json({ source, reason: reason || null });
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
