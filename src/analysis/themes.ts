/**
 * News Nexus — the rules that turn headlines into themes, companies and deals.
 *
 * Everything here is deterministic pattern matching: keyword lists for
 * themes, name matching for companies, regular expressions for deal sizes.
 * It reads what a headline says; it does not understand it. A company is
 * "mentioned" only when its name appears. "Exposure" lists are a separate,
 * curated set of companies that operate in a theme — they are NOT derived
 * from the news and do not mean a company benefits from any given story.
 */

export interface ThemeDef {
  id: string;
  label: string;
  /** Lower-case keywords or phrases; matched on word boundaries. */
  keywords: string[];
  /** Curated tickers that operate in this theme. Unknown ones are dropped at runtime. */
  exposure: string[];
  /**
   * An illustrative second-order chain: who is affected downstream when this
   * theme heats up. Background knowledge, not something the news proved.
   */
  chain: { stage: string; why: string; examples: string[] }[];
}

export const THEMES: readonly ThemeDef[] = [
  {
    id: "ai",
    label: "AI & semiconductors",
    keywords: ["artificial intelligence", "ai", "genai", "generative ai", "chip", "chips", "chipmaker", "semiconductor", "semiconductors", "gpu", "gpus", "data centre", "data center", "data centres", "data centers", "llm", "foundry", "fab"],
    exposure: ["NVDA", "AMD", "TSM", "AVGO", "MU", "MSFT", "GOOGL", "TATAELXSI.NS", "PERSISTENT.NS", "DIXON.NS", "KAYNES.NS", "NETWEB.NS"],
    chain: [
      { stage: "Chip designers and foundries", why: "First to see orders when AI spending rises", examples: ["NVDA", "AMD", "TSM"] },
      { stage: "Data-centre builders", why: "Chips need servers, racks and buildings", examples: ["VRT", "ANANTRAJ.NS", "NETWEB.NS"] },
      { stage: "Power utilities", why: "Data centres draw large, steady electricity loads", examples: ["CEG", "GEV", "NTPC.NS", "TATAPOWER.NS"] },
      { stage: "Cooling and electrical equipment", why: "Dense compute needs cooling and switchgear", examples: ["VRT", "ABB.NS", "SIEMENS.NS", "BLUESTARCO.NS"] },
      { stage: "Copper and metals", why: "Grid and data-centre wiring is copper-intensive", examples: ["HINDCOPPER.NS", "HINDALCO.NS"] },
    ],
  },
  {
    id: "defence",
    label: "Defence & aerospace",
    keywords: ["defence", "defense", "missile", "missiles", "fighter jet", "fighter jets", "warship", "submarine", "drdo", "army", "navy", "air force", "ministry of defence", "aerospace", "drone", "drones", "ammunition", "radar"],
    exposure: ["HAL.NS", "BEL.NS", "BDL.NS", "MAZDOCK.NS", "COCHINSHIP.NS", "GRSE.NS", "BHARATFORG.NS", "SOLARINDS.NS", "LMT", "RTX", "BA"],
    chain: [
      { stage: "Prime contractors", why: "Sign the headline contracts", examples: ["HAL.NS", "MAZDOCK.NS", "LMT"] },
      { stage: "Electronics and sub-systems", why: "Radars, avionics and guidance are subcontracted", examples: ["BEL.NS", "DATAPATTNS.NS", "RTX"] },
      { stage: "Forgings, alloys and explosives", why: "Platforms need specialised materials", examples: ["BHARATFORG.NS", "MIDHANI.NS", "SOLARINDS.NS"] },
    ],
  },
  {
    id: "energy",
    label: "Power & renewables",
    keywords: ["solar", "wind energy", "wind power", "renewable", "renewables", "green hydrogen", "power plant", "electricity", "power grid", "transmission", "thermal power", "nuclear", "battery storage", "energy storage", "discom", "gw", "mw"],
    exposure: ["NTPC.NS", "POWERGRID.NS", "TATAPOWER.NS", "ADANIGREEN.NS", "ADANIPOWER.NS", "SUZLON.NS", "JSWENERGY.NS", "NHPC.NS", "WAAREEENER.NS", "NEE", "GEV", "CEG"],
    chain: [
      { stage: "Developers and generators", why: "Win the capacity auctions", examples: ["NTPC.NS", "ADANIGREEN.NS", "NEE"] },
      { stage: "Equipment makers", why: "Supply modules, turbines and boilers", examples: ["SUZLON.NS", "WAAREEENER.NS", "BHEL.NS", "GEV"] },
      { stage: "Transmission and grid", why: "New capacity needs lines and substations", examples: ["POWERGRID.NS", "KEC.NS", "KPIL.NS"] },
      { stage: "Lenders to the sector", why: "Projects are debt-financed", examples: ["PFC.NS", "RECLTD.NS", "IREDA.NS"] },
    ],
  },
  {
    id: "oilgas",
    label: "Oil & gas",
    keywords: ["crude", "crude oil", "brent", "opec", "refinery", "refining", "lng", "natural gas", "petrol", "diesel", "oil prices", "oil price", "fuel", "pipeline", "upstream"],
    exposure: ["RELIANCE.NS", "ONGC.NS", "IOC.NS", "BPCL.NS", "HINDPETRO.NS", "GAIL.NS", "OIL.NS", "PETRONET.NS", "XOM", "CVX"],
    chain: [
      { stage: "Explorers and producers", why: "Earn more per barrel when crude rises", examples: ["ONGC.NS", "OIL.NS", "XOM"] },
      { stage: "Refiners and fuel retailers", why: "Margins are squeezed when crude rises faster than pump prices", examples: ["IOC.NS", "BPCL.NS", "HINDPETRO.NS"] },
      { stage: "Fuel-heavy industries", why: "Airlines, paints and tyres carry crude-linked costs", examples: ["INDIGO.NS", "ASIANPAINT.NS", "MRF.NS"] },
    ],
  },
  {
    id: "banking",
    label: "Banking & finance",
    keywords: ["bank", "banks", "banking", "rbi", "repo rate", "rate cut", "rate hike", "nbfc", "loan", "loans", "credit growth", "deposit", "deposits", "npa", "fed", "federal reserve", "interest rate", "interest rates", "insurer", "insurance", "ipo"],
    exposure: ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS", "AXISBANK.NS", "BAJFINANCE.NS", "LICI.NS", "JPM", "GS", "BAC"],
    chain: [
      { stage: "Banks", why: "Rate moves change lending margins directly", examples: ["HDFCBANK.NS", "SBIN.NS", "JPM"] },
      { stage: "Non-bank lenders", why: "Borrow wholesale, so funding cost moves fastest", examples: ["BAJFINANCE.NS", "SHRIRAMFIN.NS", "CHOLAFIN.NS"] },
      { stage: "Rate-sensitive sectors", why: "Cheaper loans lift housing and auto demand", examples: ["DLF.NS", "MARUTI.NS", "LODHA.NS"] },
    ],
  },
  {
    id: "pharma",
    label: "Healthcare & pharma",
    keywords: ["pharma", "pharmaceutical", "drug", "drugs", "usfda", "fda", "vaccine", "hospital", "hospitals", "clinical trial", "biotech", "generic", "generics", "healthcare", "obesity drug", "glp-1"],
    exposure: ["SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS", "LUPIN.NS", "APOLLOHOSP.NS", "MAXHEALTH.NS", "LLY", "PFE", "JNJ"],
    chain: [
      { stage: "Drug makers", why: "Approvals and pricing hit revenue directly", examples: ["SUNPHARMA.NS", "DRREDDY.NS", "LLY"] },
      { stage: "Contract manufacturers and API suppliers", why: "Make ingredients for the brand owners", examples: ["DIVISLAB.NS", "LAURUSLABS.NS", "SYNGENE.NS"] },
      { stage: "Hospitals and diagnostics", why: "Deliver the care", examples: ["APOLLOHOSP.NS", "MAXHEALTH.NS", "LALPATHLAB.NS"] },
    ],
  },
  {
    id: "infra",
    label: "Infrastructure & railways",
    keywords: ["infrastructure", "highway", "highways", "nhai", "metro rail", "railway", "railways", "vande bharat", "bridge", "airport", "port", "ports", "epc", "construction", "cement", "capex", "tunnel"],
    exposure: ["LT.NS", "RVNL.NS", "IRCON.NS", "IRFC.NS", "NBCC.NS", "KEC.NS", "ULTRACEMCO.NS", "ADANIPORTS.NS", "TITAGARH.NS", "BEML.NS"],
    chain: [
      { stage: "EPC contractors", why: "Win the construction orders", examples: ["LT.NS", "RVNL.NS", "KEC.NS"] },
      { stage: "Cement and steel", why: "Every project consumes both", examples: ["ULTRACEMCO.NS", "TATASTEEL.NS", "JSWSTEEL.NS"] },
      { stage: "Equipment and rolling stock", why: "Machines and wagons follow the orders", examples: ["BEML.NS", "TITAGARH.NS", "CUMMINSIND.NS"] },
    ],
  },
  {
    id: "auto",
    label: "Autos & EVs",
    keywords: ["electric vehicle", "electric vehicles", "ev", "evs", "automaker", "carmaker", "car sales", "auto sales", "two-wheeler", "two-wheelers", "suv", "battery", "charging", "tractor", "passenger vehicle"],
    exposure: ["MARUTI.NS", "M&M.NS", "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "EICHERMOT.NS", "TVSMOTOR.NS", "HEROMOTOCO.NS", "MOTHERSON.NS", "TSLA"],
    chain: [
      { stage: "Vehicle makers", why: "Volumes and pricing", examples: ["MARUTI.NS", "M&M.NS", "TSLA"] },
      { stage: "Component suppliers", why: "Every vehicle pulls a parts order", examples: ["MOTHERSON.NS", "BOSCHLTD.NS", "UNOMINDA.NS"] },
      { stage: "Batteries and materials", why: "EVs shift value to cells and metals", examples: ["EXIDEIND.NS", "ARE&M.NS", "HINDALCO.NS"] },
    ],
  },
  {
    id: "it",
    label: "IT services",
    keywords: ["it services", "software services", "outsourcing", "deal win", "deal wins", "cloud", "digital transformation", "h-1b", "tcs", "infosys", "wipro", "hcltech", "saas", "cybersecurity"],
    exposure: ["TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS", "TECHM.NS", "LTIM.NS", "PERSISTENT.NS", "COFORGE.NS", "MSFT", "ORCL"],
    chain: [
      { stage: "Large-cap IT", why: "Sign the multi-year outsourcing deals", examples: ["TCS.NS", "INFY.NS", "HCLTECH.NS"] },
      { stage: "Mid-cap specialists", why: "Grow faster on niche digital work", examples: ["PERSISTENT.NS", "COFORGE.NS", "MPHASIS.NS"] },
      { stage: "Currency", why: "A weaker rupee lifts dollar-revenue margins", examples: [] },
    ],
  },
  {
    id: "metals",
    label: "Metals & mining",
    keywords: ["steel", "aluminium", "aluminum", "copper", "iron ore", "coal", "mining", "miner", "miners", "zinc", "lithium", "rare earth", "rare earths", "gold price", "silver price"],
    exposure: ["TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "VEDL.NS", "COALINDIA.NS", "NMDC.NS", "HINDCOPPER.NS", "SAIL.NS", "JINDALSTEL.NS"],
    chain: [
      { stage: "Miners", why: "Most direct exposure to the commodity price", examples: ["COALINDIA.NS", "NMDC.NS", "VEDL.NS"] },
      { stage: "Processors", why: "Margins depend on the spread over raw material", examples: ["TATASTEEL.NS", "HINDALCO.NS", "JSWSTEEL.NS"] },
      { stage: "Metal users", why: "Autos and capital goods pay the input cost", examples: ["MARUTI.NS", "LT.NS"] },
    ],
  },
  {
    id: "consumer",
    label: "Consumer & retail",
    keywords: ["fmcg", "consumer demand", "rural demand", "retail sales", "e-commerce", "quick commerce", "festive season", "festive sales", "jewellery", "apparel", "restaurant", "food delivery", "gst cut"],
    exposure: ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "TITAN.NS", "DMART.NS", "TRENT.NS", "ETERNAL.NS", "NYKAA.NS", "WMT", "COST", "AMZN"],
    chain: [
      { stage: "Staples", why: "Volume follows rural and urban incomes", examples: ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS"] },
      { stage: "Discretionary and retail", why: "More sensitive to sentiment and credit", examples: ["TITAN.NS", "TRENT.NS", "DMART.NS"] },
      { stage: "Delivery platforms", why: "Capture the shift to online ordering", examples: ["ETERNAL.NS", "SWIGGY.NS", "AMZN"] },
    ],
  },
  {
    id: "telecom",
    label: "Telecom",
    keywords: ["telecom", "5g", "spectrum", "tariff hike", "arpu", "broadband", "satellite internet", "starlink", "subscriber", "subscribers"],
    exposure: ["BHARTIARTL.NS", "RELIANCE.NS", "IDEA.NS", "INDUSTOWER.NS", "TEJASNET.NS", "HFCL.NS"],
    chain: [
      { stage: "Operators", why: "Tariffs and subscribers drive revenue", examples: ["BHARTIARTL.NS", "RELIANCE.NS", "IDEA.NS"] },
      { stage: "Towers and gear", why: "Network roll-outs need sites and equipment", examples: ["INDUSTOWER.NS", "TEJASNET.NS", "HFCL.NS"] },
    ],
  },
  {
    id: "macro",
    label: "Policy & macro",
    keywords: ["inflation", "gdp", "budget", "fiscal deficit", "tariff", "tariffs", "trade deal", "sanctions", "rupee", "dollar", "recession", "monsoon", "election", "sebi", "gst", "export", "exports", "import duty"],
    exposure: [],
    chain: [],
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const THEME_PATTERNS = THEMES.map((theme) => ({
  id: theme.id,
  pattern: new RegExp(
    `(?<![a-z0-9])(?:${theme.keywords.map(escapeRegExp).join("|")})(?![a-z0-9])`,
    "i",
  ),
}));

/** Theme ids whose keywords appear in `text`. */
export function themesIn(text: string): string[] {
  return THEME_PATTERNS.filter((t) => t.pattern.test(text)).map((t) => t.id);
}

/* ------------------------------------------------------------------ */
/* Company matching                                                    */
/* ------------------------------------------------------------------ */

export interface NamedCompany {
  symbol: string;
  name: string;
  industry: string;
  market: "IN" | "US";
  /** Large, widely covered company: may be matched by a one-word name. */
  core?: boolean;
}

/**
 * How headlines actually refer to large companies, where it differs from the
 * registered name. Case-sensitive entries are acronyms.
 */
const ALIASES: Record<string, string[]> = {
  "TCS.NS": ["TCS"], "INFY.NS": ["Infosys"], "GROWW.NS": ["Groww"], "HDFCBANK.NS": ["HDFC Bank"],
  "ICICIBANK.NS": ["ICICI Bank"], "SBIN.NS": ["SBI", "State Bank of India"],
  "LT.NS": ["L&T", "Larsen & Toubro", "Larsen and Toubro"], "HAL.NS": ["HAL", "Hindustan Aeronautics"],
  "BEL.NS": ["BEL", "Bharat Electronics"], "BHEL.NS": ["BHEL"], "NTPC.NS": ["NTPC"],
  "ONGC.NS": ["ONGC"], "RVNL.NS": ["RVNL", "Rail Vikas Nigam"], "IRCTC.NS": ["IRCTC"],
  "IRFC.NS": ["IRFC"], "BHARTIARTL.NS": ["Airtel", "Bharti Airtel"], "M&M.NS": ["M&M", "Mahindra & Mahindra"],
  "MARUTI.NS": ["Maruti Suzuki", "Maruti"], "RELIANCE.NS": ["Reliance Industries", "RIL", "Reliance Jio"],
  "HCLTECH.NS": ["HCLTech", "HCL Tech", "HCL Technologies"], "WIPRO.NS": ["Wipro"],
  "SUNPHARMA.NS": ["Sun Pharma"], "DRREDDY.NS": ["Dr Reddy's", "Dr. Reddy's", "Dr Reddy"],
  "ETERNAL.NS": ["Zomato", "Eternal Ltd", "Blinkit"], "PAYTM.NS": ["Paytm"], "NYKAA.NS": ["Nykaa"],
  "ADANIENT.NS": ["Adani Enterprises"], "ADANIPORTS.NS": ["Adani Ports"], "ADANIGREEN.NS": ["Adani Green"],
  "ADANIPOWER.NS": ["Adani Power"], "TATAMOTORS.NS": ["Tata Motors"], "TATASTEEL.NS": ["Tata Steel"],
  "TATAPOWER.NS": ["Tata Power"], "JSWSTEEL.NS": ["JSW Steel"], "COALINDIA.NS": ["Coal India"],
  "POWERGRID.NS": ["Power Grid"], "BAJFINANCE.NS": ["Bajaj Finance"], "ITC.NS": ["ITC"],
  "HINDUNILVR.NS": ["HUL", "Hindustan Unilever"], "LICI.NS": ["LIC"], "IOC.NS": ["Indian Oil", "IOCL"],
  "BPCL.NS": ["BPCL"], "HINDPETRO.NS": ["HPCL"], "GAIL.NS": ["GAIL"], "MAZDOCK.NS": ["Mazagon Dock"],
  "COCHINSHIP.NS": ["Cochin Shipyard"], "BDL.NS": ["Bharat Dynamics"], "SUZLON.NS": ["Suzlon"],
  "INDIGO.NS": ["IndiGo", "InterGlobe Aviation"], "DMART.NS": ["DMart", "Avenue Supermarts"],
  "KOTAKBANK.NS": ["Kotak Mahindra Bank", "Kotak Bank"], "AXISBANK.NS": ["Axis Bank"],
  "TECHM.NS": ["Tech Mahindra"], "TITAN.NS": ["Titan Company", "Tanishq"], "VEDL.NS": ["Vedanta"],
  GOOGL: ["Google", "Alphabet"], META: ["Meta", "Facebook"], AMZN: ["Amazon", "AWS"],
  TSM: ["TSMC", "Taiwan Semiconductor"], JPM: ["JPMorgan", "JP Morgan"], AMD: ["AMD"],
  NVDA: ["Nvidia"], MSFT: ["Microsoft"], AAPL: ["Apple"], TSLA: ["Tesla"],
};

/** Same alias table, exported for the NLP entity index. */
export const ALIASES_FOR_NLP: Record<string, string[]> = ALIASES;


const LEGAL_SUFFIX = /\s*\b(limited|ltd\.?|incorporated|inc\.?|corporation|corp\.?|company|co\.?|plc)\b\.?/gi;

/** Names too generic to match on their own, even though a company is called this. */
const TOO_GENERIC = new Set([
  "india", "bank", "power", "energy", "finance", "motors", "industries", "apple",
  "meta", "oracle", "intel", "micron", "the", "one", "page", "info", "max", "star",
  "sun", "supreme", "linde", "trent", "global", "national", "united", "central",
  "union", "indian", "bharat", "hindustan", "general", "century", "emami", "aarti",
]);

export interface CompanyMatcher {
  company: NamedCompany;
  patterns: RegExp[];
}

/** Build one matcher per company. Call once per universe, not per headline. */
export function buildMatchers(universe: NamedCompany[]): CompanyMatcher[] {
  return universe.map((company) => {
    const names = new Set<string>();
    const cleaned = company.name
      .replace(LEGAL_SUFFIX, "")
      .replace(/\s*\(india\)/i, "")
      .replace(/\s+/g, " ")
      .trim();
    // The registered name minus its legal suffix: "Bharat Forge", "Tata Elxsi".
    // Small companies are often named after ordinary words ("Orient",
    // "Prime", "Focus"), so only core names may match on a single word.
    const words = cleaned.split(" ").length;
    const singleOk =
      company.core !== false && cleaned.length >= 5 && !TOO_GENERIC.has(cleaned.toLowerCase());
    if (words >= 2 || singleOk) names.add(cleaned);
    for (const alias of ALIASES[company.symbol] ?? []) names.add(alias);

    const patterns = [...names].map((name) => {
      // An all-caps alias (TCS, HAL, BEL) must match case-sensitively, or
      // "hal" inside ordinary words and "bel" in "belief" would fire.
      const acronym = /^[A-Z&]{2,6}$/.test(name);
      return new RegExp(
        `(?<![A-Za-z0-9&])${escapeRegExp(name)}(?:'s)?(?![A-Za-z0-9&])`,
        acronym ? "" : "i",
      );
    });
    return { company, patterns };
  });
}

/** Companies named in `text`. */
export function companiesIn(text: string, matchers: CompanyMatcher[]): NamedCompany[] {
  return matchers
    .filter((m) => m.patterns.some((pattern) => pattern.test(text)))
    .map((m) => m.company);
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

export type DealKind = "Order or contract" | "Acquisition or stake" | "Fundraise" | "Investment";

export interface DealSignal {
  kind: DealKind;
  /** The amount as written, e.g. "₹1,250 crore". `null` when none was stated. */
  amount: string | null;
  /** Approximate size in US$ million, for ranking only. */
  usdMillion: number | null;
}

const DEAL_KINDS: { kind: DealKind; pattern: RegExp }[] = [
  { kind: "Order or contract", pattern: /\b(wins?|won|bags?|bagged|secures?|secured|receives?|received|awarded|lands?)\b[^.]{0,60}\b(orders?|contracts?|deal|loa|letter of award|project|tender|work order)\b|\b(order win|order inflow|order book|contract worth|orders? worth)\b/i },
  { kind: "Acquisition or stake", pattern: /\b(acquires?|acquired|acquisition|to buy|buys|takeover|merger|merge with|stake (?:sale|buy|purchase)|buys? .{0,20}stake|picks up .{0,20}stake)\b/i },
  { kind: "Fundraise", pattern: /\b(raises?|raised|fundraise|fund-raise|qip|rights issue|ipo|funding round|bond sale|ncd issue)\b/i },
  { kind: "Investment", pattern: /\b(to invest|invests?|investment of|capex of|plans? .{0,30}(plant|factory|facility)|sets? up .{0,30}(plant|factory|facility))\b/i },
];

/** Assumed conversion for ranking deal sizes only; never displayed. */
const INR_PER_USD = 88;

const AMOUNT =
  /(?:(rs\.?|₹|inr)\s?([\d,]+(?:\.\d+)?)\s?(lakh crore|crore|cr|lakh|billion|bn|million|mn)?|(us\$|\$)\s?([\d,]+(?:\.\d+)?)\s?(trillion|billion|bn|million|mn|m|b)?|([\d,]+(?:\.\d+)?)\s?-?(crore|cr)\b)/i;

/** Extract a deal's kind and stated size from a headline. `null` if it is not a deal. */
export function dealIn(text: string): DealSignal | null {
  const kind = DEAL_KINDS.find((k) => k.pattern.test(text))?.kind;
  return kind ? { kind, ...amountIn(text) } : null;
}

/** Context that marks an amount as a valuation, not a deal size. */
const VALUATION_BEFORE = /\b(valuation of|valued at|value of|market cap of|m-?cap of|net worth of)\s*(about|around|nearly|over)?\s*$/i;
const VALUATION_AFTER = /^\s*(valuation|market cap|m-?cap)\b/i;

/**
 * The first stated money amount in `text` that is not a valuation, as
 * written and in US$ million. "Seeks ₹90,000 crore valuation in ₹8,981 crore
 * IPO" yields the IPO size, not the valuation.
 */
export function amountIn(text: string): { amount: string | null; usdMillion: number | null } {
  const global = new RegExp(AMOUNT.source, "gi");
  let m: RegExpExecArray | null = null;
  for (let hit = global.exec(text); hit; hit = global.exec(text)) {
    const before = text.slice(Math.max(0, hit.index - 30), hit.index);
    const after = text.slice(hit.index + hit[0].length, hit.index + hit[0].length + 14);
    if (!VALUATION_BEFORE.test(before) && !VALUATION_AFTER.test(after)) {
      m = hit;
      break;
    }
  }
  if (!m) return { amount: null, usdMillion: null };
  let usdMillion: number | null = null;
  if (m[1] || m[7]) {
    const value = Number.parseFloat((m[2] ?? m[7]).replace(/,/g, ""));
    const unit = (m[3] ?? m[8] ?? "").toLowerCase();
    const rupees =
      unit === "lakh crore" ? value * 1e12
      : unit === "crore" || unit === "cr" ? value * 1e7
      : unit === "lakh" ? value * 1e5
      : unit === "billion" || unit === "bn" ? value * 1e9
      : unit === "million" || unit === "mn" ? value * 1e6
      : value;
    usdMillion = rupees / INR_PER_USD / 1e6;
  } else if (m[4]) {
    const value = Number.parseFloat(m[5].replace(/,/g, ""));
    const unit = (m[6] ?? "").toLowerCase();
    usdMillion =
      unit === "trillion" ? value * 1e6
      : unit === "billion" || unit === "bn" || unit === "b" ? value * 1e3
      : unit === "million" || unit === "mn" || unit === "m" ? value
      : value / 1e6;
  }

  return { amount: m[0].trim(), usdMillion };
}

/** Map an exchange-filing category onto a deal kind. `null` if it is not one. */
export function dealKindForFiling(category: string): DealKind | null {
  if (/order|contract/i.test(category)) return "Order or contract";
  if (/acquisition|joint venture/i.test(category)) return "Acquisition or stake";
  if (/fund ?raising|raising of funds/i.test(category)) return "Fundraise";
  if (/capacity|agreement/i.test(category)) return "Investment";
  return null;
}

const INDUSTRY_THEMES: [RegExp, string][] = [
  [/pharma|health|hospital|biotech/i, "pharma"],
  [/bank|financ|nbfc|insur|capital markets/i, "banking"],
  [/information technology|software|it -|computers/i, "it"],
  [/power|electric utilit|renewable/i, "energy"],
  [/oil|gas|petrol|refiner/i, "oilgas"],
  [/defen[cs]e|aerospace|ship/i, "defence"],
  [/construct|infrastructure|engineering|cement|railway|capital goods/i, "infra"],
  [/auto/i, "auto"],
  [/steel|metal|mining|alumin|minerals/i, "metals"],
  [/telecom/i, "telecom"],
  [/fmcg|fast moving|consumer|retail|personal care|food|textile|apparel/i, "consumer"],
];

/** The theme an industry label belongs to, or `null`. */
export function themeForIndustry(industry: string): string | null {
  return INDUSTRY_THEMES.find(([pattern]) => pattern.test(industry))?.[1] ?? null;
}
