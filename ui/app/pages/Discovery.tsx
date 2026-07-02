import React, { useState, useMemo, useEffect, useCallback, useSyncExternalStore } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { settingsObjectsClient, settingsSchemasClient } from "@dynatrace-sdk/client-classic-environment-v2";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text, Strong } from "@dynatrace/strato-components/typography";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { Accordion } from "@dynatrace/strato-components/content";
import { Chip } from "@dynatrace/strato-components/content";
import { HealthIndicator } from "@dynatrace/strato-components/content";
import { Tabs, Tab } from "@dynatrace/strato-components/navigation";
import { TextInput } from "@dynatrace/strato-components/forms";
import { Switch } from "@dynatrace/strato-components/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Sheet } from "@dynatrace/strato-components/overlays";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { CriticalIcon } from "@dynatrace/strato-icons";
import {
  WarningIcon,
  BusinessAnalyticsSignetIcon,
  HttpIcon,
  CodeIcon,
  TargetFilledIcon,
  SettingIcon,
  PlusIcon,
  DeleteIcon,
  ResetIcon,
} from "@dynatrace/strato-icons";

// ─── User Settings ────────────────────────────────────────────────────────────
// Tiny localStorage-backed reactive settings store. Module-level state
// + useSyncExternalStore so the gear-icon toggle re-renders every
// consumer that subscribes via useUserSettings(). The cached snapshot
// keeps the reference stable across reads (required by
// useSyncExternalStore to avoid infinite re-render loops).
const USER_SETTINGS_KEY = "dt.dbm.userSettings";

// Editable business-keyword catalog. Stored verbatim in user settings
// so the Settings sheet's "Manage business signals" editor can add,
// disable, and remove keywords, with a one-click reset back to
// DEFAULT_KEYWORD_CATEGORIES. `enabled=false` keeps the entry visible
// in the UI but excluded from scoring, so users can toggle noisy
// terms off without losing them.
type KeywordEntry = { text: string; enabled: boolean };
type KeywordColor = "success" | "primary" | "warning" | "critical" | "neutral";
type KeywordCategoryConfig = {
  id: string;
  label: string;
  color: KeywordColor;
  enabled: boolean;
  keywords: KeywordEntry[];
};

// Helper that flips a flat string list into the editable KeywordEntry
// shape with every keyword enabled by default. Used only to seed the
// defaults below.
function kw(list: string[]): KeywordEntry[] {
  return list.map((text) => ({ text: text.toLowerCase(), enabled: true }));
}

const DEFAULT_KEYWORD_CATEGORIES: KeywordCategoryConfig[] = [
  {
    id: "financial",
    label: "Financial",
    color: "success",
    enabled: true,
    keywords: kw([
      "amount", "price", "total", "cost", "fee", "charge", "payment", "pay", "refund",
      "credit", "debit", "balance", "revenue", "discount", "tax", "invoice", "subtotal",
      "currency", "wallet", "cashback", "tip", "surcharge", "profit", "billing", "rate",
    ]),
  },
  {
    id: "identity",
    label: "Identity",
    color: "primary",
    enabled: true,
    keywords: kw([
      "user", "customer", "account", "client", "member", "subscriber", "userid",
      "customerid", "identifier", "email", "phone", "username", "profile", "loyalty",
      "tier", "membership", "segment", "buyer", "seller", "shopper",
    ]),
  },
  {
    id: "transaction",
    label: "Transaction",
    color: "warning",
    enabled: true,
    keywords: kw([
      "order", "transaction", "purchase", "booking", "reservation", "checkout",
      "cart", "sale", "buy", "trade", "deal", "fulfillment", "shipment", "delivery",
      "return", "exchange", "basket",
    ]),
  },
  {
    id: "reference",
    label: "Reference",
    color: "neutral",
    enabled: true,
    keywords: kw([
      "reference", "tracking", "confirmation", "voucher", "code", "token",
      "coupon", "promo", "promotional", "barcode", "qr", "number",
    ]),
  },
  {
    id: "product",
    label: "Product",
    color: "primary",
    enabled: true,
    keywords: kw([
      "product", "item", "sku", "catalog", "inventory", "stock", "quantity",
      "qty", "variant", "bundle", "offer", "assortment",
    ]),
  },
];

const DEFAULT_NON_BUSINESS_PHRASES: string[] = ["user agent"];

type UserSettings = {
  allowSqlMethods: boolean;
  includeCrossServiceDescendants: boolean;
  keywordCategories: KeywordCategoryConfig[];
  nonBusinessPhrases: string[];
  // Synthetic detection patterns that don't fit into a plain keyword
  // list (because they require route-pattern matching, not substring
  // matching). Currently the only one is the `get*ById` boost — routes
  // like `getJourneyById` get a +1 score and a synthetic `byId`
  // keyword. Stored in settings so the Manage business signals editor
  // can switch it off when it produces noise.
  getByIdBoost: boolean;
};
const DEFAULT_USER_SETTINGS: UserSettings = {
  allowSqlMethods: false,
  includeCrossServiceDescendants: false,
  keywordCategories: DEFAULT_KEYWORD_CATEGORIES,
  nonBusinessPhrases: DEFAULT_NON_BUSINESS_PHRASES,
  getByIdBoost: true,
};

function loadUserSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(USER_SETTINGS_KEY);
    if (raw) return { ...DEFAULT_USER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* localStorage may throw in sandboxed contexts — fall through to defaults */
  }
  return DEFAULT_USER_SETTINGS;
}

let _userSettingsSnapshot: UserSettings = loadUserSettings();
const _userSettingsListeners = new Set<() => void>();

function getUserSettingsSnapshot(): UserSettings {
  return _userSettingsSnapshot;
}

function setUserSettings(next: UserSettings): void {
  _userSettingsSnapshot = next;
  _activeCatalog = next.keywordCategories;
  _activePhrases = next.nonBusinessPhrases;
  _getByIdBoost = next.getByIdBoost;
  try {
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
  _userSettingsListeners.forEach((cb) => cb());
}

function subscribeUserSettings(cb: () => void): () => void {
  _userSettingsListeners.add(cb);
  return () => {
    _userSettingsListeners.delete(cb);
  };
}

function useUserSettings(): [UserSettings, (next: UserSettings) => void] {
  const snap = useSyncExternalStore(
    subscribeUserSettings,
    getUserSettingsSnapshot,
    getUserSettingsSnapshot,
  );
  return [snap, setUserSettings];
}

// ─── Active Catalog (mirrors UserSettings.keywordCategories) ─────────────────
// Module-level mutable mirrors of the user-editable catalog. scoreText
// and the chip-color helper read these instead of taking the catalog as
// an argument, so we don't have to thread settings through every scoring
// call site. Kept in sync by setUserSettings above, and consumed by
// useMemo blocks via `useUserSettings()[0].keywordCategories` as a
// dependency so downstream scores recompute when the user edits the
// catalog.
let _activeCatalog: KeywordCategoryConfig[] = _userSettingsSnapshot.keywordCategories;
let _activePhrases: string[] = _userSettingsSnapshot.nonBusinessPhrases;
let _getByIdBoost: boolean = _userSettingsSnapshot.getByIdBoost;

function findKeywordCategory(keyword: string): KeywordCategoryConfig | undefined {
  const k = keyword.toLowerCase();
  return _activeCatalog.find((cat) => cat.keywords.some((e) => e.text === k));
}

// ─── Types ────────────────────────────────────────────────────────────────────

// Which top-level view is rendered below the stats bar. Driven by the
// stat-card "tabs" — clicking a card swaps the view in-place.
//   services  — left-side service picker + right-side ServiceDetail (default).
//   endpoints — flat table of HTTP endpoint candidates across the whole fleet.
//   methods   — flat table of method-span candidates across the whole fleet.
type DiscoveryView = "services" | "endpoints" | "methods";

type Confidence = "high" | "medium" | "low";

interface ServiceRecord {
  service_id: string;
  // Classic Dynatrace entity ID (`dt.entity.service`). Often equal to
  // `service_id` (Smartscape ID) but for SOAP/Axis services the
  // per-operation metric rows can carry a different Smartscape ID than
  // the aggregate row, so this is needed as a fallback lookup key when
  // joining endpoint-scan rows back to the services list.
  entity_id: string | null;
  service_name: string;
  total_spans: number;
  http_endpoints: number;
  method_spans: number;
  technology: string | null;
  // Every distinct endpoint.name value observed for this service in
  // the scan window. Populated directly by SERVICES_QUERY via
  // collectDistinct, so the endpoint scan no longer needs a second
  // query to be joined back by ID — routes are intrinsically attached
  // to the service row that owns them.
  routes: string[];
}

interface EndpointRecord {
  route: string;
  http_method: string | null;
  calls: number;
}

interface MethodRecord {
  class_name: string | null;
  method_name: string | null;
  span_name: string | null;
  calls: number;
}

// One row per span in a representative trace for a given endpoint.
// We deliberately return RAW spans (no per-(endpoint, span_name) aggregation)
// so we can walk the span tree client-side and keep only descendants of the
// endpoint's entry-point span — i.e. spans that were genuinely invoked
// inside that endpoint, not unrelated sibling spans of the same trace.
interface EndpointMethodRecord {
  endpoint: string;
  entry_span_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_id: string | null;
  span_name: string;
  span_kind: string | null;
  class_name: string | null;
  method_name: string | null;
  service_id: string | null;
}

// Scored variant rendered inside the Investigate Methods sheet.
interface MethodCandidate {
  id: string;
  span_name: string;
  class_name: string | null;
  method_name: string | null;
  span_kind: string | null;
  displayName: string;
  calls: number;
  score: number;
  keywords: string[];
  confidence: Confidence;
  example_span_id: string | null;
  example_trace_id: string | null;
  // True when this method ran in a service downstream of the endpoint's
  // owner (e.g. an HTTP client call from `easytravel-frontend-java` into
  // `easytravel-business-java` for a `BookingService` method). Surfaced
  // by the cross-service-descendants toggle so the UI can mark these
  // candidates with an "Underlying service" label.
  is_cross_service: boolean;
  // True when the span appears in the rep trace but is NOT a descendant
  // of the endpoint's entry-point span (i.e. it is a sibling, ancestor,
  // or belongs to a different branch of the same trace). Only set when
  // the cross-service toggle is ON (otherwise the BFS filter already
  // ensures every candidate is inside the subtree).
  is_surrounding: boolean;
  owning_service_id: string | null;
}

interface AttributeSuggestion {
  name: string;
  dataSource: string;
  instruction: string;
  confidence: Confidence;
  category: string;
}

interface ScoredItem {
  id: string;
  displayName: string;
  type: "endpoint" | "method";
  calls: number;
  score: number;
  keywords: string[];
  confidence: Confidence;
  suggestions: AttributeSuggestion[];
  raw: EndpointRecord | MethodRecord;
}

// ─── Business Keyword Engine ──────────────────────────────────────────────────
//
// Catalog + suppression phrases live in user settings and are mirrored
// at module level (`_activeCatalog`, `_activePhrases`) above so this
// scorer can stay synchronous and dependency-free. To keep useMemo
// blocks reactive to keyword edits, downstream callers add
// `settings.keywordCategories` / `settings.nonBusinessPhrases` to their
// dependency arrays — setUserSettings replaces those references on
// every save.

function scoreText(text: string): { score: number; keywords: string[]; categories: string[] } {
  if (!text) return { score: 0, keywords: [], categories: [] };
  let normalized = text.toLowerCase().replace(/[._/\-]/g, " ");
  // Neutralise known false-positive phrases by wiping them from the
  // matching surface — keywords like "user" won't be found in the
  // resulting whitespace.
  for (const phrase of _activePhrases) {
    if (!phrase) continue;
    normalized = normalized.split(phrase).join(" ".repeat(phrase.length));
  }
  const matched: string[] = [];
  const cats: string[] = [];
  for (const cat of _activeCatalog) {
    if (!cat.enabled) continue;
    const found = cat.keywords
      .filter((entry) => entry.enabled && entry.text && normalized.includes(entry.text))
      .map((entry) => entry.text);
    if (found.length > 0) {
      matched.push(...found);
      cats.push(cat.id);
    }
  }
  return { score: matched.length, keywords: [...new Set(matched)], categories: [...new Set(cats)] };
}

function getConfidence(score: number): Confidence {
  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

// Infrastructure framework methods — always suppressed. These are pure
// plumbing (request entry points, filter chains, RPC dispatchers, SDK
// outgoing spans, mod_proxy load balancers) that pick up business
// keywords only because their span.name reflects the underlying URL or
// SQL statement — the method itself is never the business unit of work,
// the user is interested in the *implementation* of the request handler
// downstream. mod_proxy_balancer in particular matches "balance" from
// the financial keyword list purely from its class name.
const INFRA_PATTERNS: RegExp[] = [
  /\bAspNet\b/i,
  /\bServiceChannel\b/i,
  /\bmod_proxy/i,
  /\bdoFilter\b/i,
  /\bBaseFilter\b/i,
  /\bJspServlet\b/i,
  /\bOneAgent\s+SDK\b/i,
  /^Outgoing\s+remote\s+call/i,
  // OpenTracing SDK plumbing (tracer/span/scope abstractions). The class
  // name picks up business keywords purely because they are part of the
  // tracing API, not because the method does real work.
  /\bOpenTracing\b/i,
];

// SQL / DB framework methods — suppressed by default, opt-in via the
// gear-icon Settings sheet. When enabled, scoring runs against the SQL
// statement (which OneAgent carries in span.name for these spans) and
// can match business table/column names like `customer`, `order` or
// `payment`. Off by default because most users don't want every
// DbCommand.ExecuteReader showing up as a candidate.
//
// The first pattern is intentionally broad: anything whose class name
// starts with one of the ADO.NET-family prefixes (`Sql`, `SqlCe`, `Db`,
// `OleDb`, `Odbc`) followed by a CamelCase suffix is treated as SQL
// plumbing. This catches SqlCommand, SqlConnection, SqlTransaction,
// SqlCeCommand, SqlCeMultiCommand, SqlCeConnection,
// SqlCeTransaction, DbCommand, DbConnection, DbContext, DbDataReader
// and friends in one rule — including the otherwise-tricky
// SqlCeTransaction.Commit() (the word `transaction` is in the
// business keyword catalog so the per-keyword scorer would otherwise
// flag every commit/rollback as a business operation).
const SQL_PATTERNS: RegExp[] = [
  /\b(Sql|SqlCe|Db|OleDb|Odbc)[A-Z][A-Za-z]*\b/,
  /\bExecute(Reader|NonQuery|Scalar)\b/i,
  /\bConnection\.Open\b/i,
];

// Static resource extensions — endpoints ending in any of these are
// dropped at parse time so they never reach the scoring engine, the
// endpoint table, the method-candidate tally, or the business-signal
// counts. They are pure transport noise (images, stylesheets, fonts,
// JSPs, etc.) and would otherwise dilute every per-service candidacy
// rating with hundreds of zero-business-value rows — for reference see
// "Requests executed in background threads of
// com.dynatrace.easytravel.weblauncher.jar easyTravel".
//
// The list is surfaced to the user verbatim in the Settings sheet (see
// STATIC_RESOURCE_EXTENSIONS) so they know what's being suppressed.
const STATIC_RESOURCE_EXTENSIONS: string[] = [
  "png", "jpg", "jpeg", "gif", "ico", "svg", "webp", "bmp", "tif", "tiff",
  "css", "js", "mjs", "cjs", "map",
  "woff", "woff2", "ttf", "eot", "otf",
  "html", "htm", "xhtml",
  "pdf", "txt", "xml", "csv", "rss", "atom",
  "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov",
  "zip", "gz", "tar", "rar", "7z",
];
const STATIC_RESOURCE_REGEX = new RegExp(
  `\\.(${STATIC_RESOURCE_EXTENSIONS.join("|")})(?:\\?.*)?$`,
  "i",
);
function isStaticResourceRoute(route: string | null | undefined): boolean {
  if (!route) return false;
  // Strip any leading method prefix like `GET /foo.css` before testing.
  const tail = route.includes(" ") ? route.slice(route.lastIndexOf(" ") + 1) : route;
  return STATIC_RESOURCE_REGEX.test(tail);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((p) => p.test(text));
}

// Method/span-aware wrapper around scoreText. Centralises rules that
// apply to anything identified by class + method name (the methods table
// AND every span row in the trace waterfall):
//   1. Suppress framework infrastructure (INFRA_PATTERNS) unconditionally.
//   2. Suppress SQL/DB plumbing (SQL_PATTERNS) unless opts.allowSql=true.
//   3. Suppress "client" methods/classes — these are nearly always
//      transport/infra wrappers (HTTP/gRPC/DB clients, Axis2 operation
//      clients, etc.) and would otherwise score positive because
//      `client` lives in the identity keyword list.
//   4. Bump `get*ById` to at least medium confidence — retrieve-by-id
//      getters are the bread and butter of business operations and
//      should never sit at 0 stars.
function scoreMethodLike(
  className: string | null,
  methodName: string | null,
  spanName: string | null,
  opts: { allowSql?: boolean } = {},
): { score: number; keywords: string[]; categories: string[] } {
  const cn = className ?? "";
  const mn = methodName ?? "";
  const sn = spanName ?? "";

  // Hard suppressions first — these short-circuit all scoring (including
  // get*ById boost) because the method is not a real business unit.
  const combined = `${cn} ${mn} ${sn}`;
  if (matchesAny(combined, INFRA_PATTERNS)) {
    return { score: 0, keywords: [], categories: [] };
  }
  if (!opts.allowSql && matchesAny(combined, SQL_PATTERNS)) {
    return { score: 0, keywords: [], categories: [] };
  }

  // Match `client` either as a standalone word (`Http Client`, `Rest_Client`)
  // or as a camelCase token boundary (`RestClient`, `S3Client`). Genuine
  // identity fields like `ClientId`/`ClientName` are preserved because the
  // camelCase rule requires `Client` to be followed by end-of-string OR an
  // uppercase letter that *isn't* another business word: we only filter out
  // when the token clearly terminates the identifier.
  const looksLikeClient =
    /(^|[^A-Za-z])client([^A-Za-z]|$)/i.test(cn) ||
    /(^|[^A-Za-z])client([^A-Za-z]|$)/i.test(mn) ||
    /(^|[^A-Za-z])client([^A-Za-z]|$)/i.test(sn) ||
    /Client(?=$|[^a-zA-Z])/.test(cn) ||
    /Client(?=$|[^a-zA-Z])/.test(mn) ||
    /Client(?=$|[^a-zA-Z])/.test(sn);

  let score: number;
  let keywords: string[];
  let categories: string[];
  if (looksLikeClient) {
    score = 0;
    keywords = [];
    categories = [];
  } else {
    const scored = scoreText([cn, mn, sn].join(" "));
    score = scored.score;
    keywords = scored.keywords;
    categories = scored.categories;
  }

  const isGetById = !looksLikeClient && _getByIdBoost && /^get[A-Z].*ById$/.test(mn);
  if (isGetById) {
    score = Math.max(score, 1);
    if (!keywords.includes("byId")) keywords = [...keywords, "byId"];
  }

  return { score, keywords, categories };
}

function toDisplayName(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

// ─── Suggestion Generators ────────────────────────────────────────────────────

function generateEndpointSuggestions(route: string, method: string | null): AttributeSuggestion[] {
  const lower = route.toLowerCase();
  const m = method || "ANY";
  const suggestions: AttributeSuggestion[] = [];

  // Extract path parameters {param} or :param
  const pathParams = [...route.matchAll(/\{([^}]+)\}|:([a-zA-Z_][a-zA-Z0-9_]*)/g)];
  for (const match of pathParams) {
    const paramName = match[1] || match[2];
    const displayName = toDisplayName(paramName);
    const regexRoute = route.replace(`{${paramName}}`, "([^/]+)").replace(`:${paramName}`, "([^/]+)");
    suggestions.push({
      name: displayName,
      dataSource: `HTTP URL path parameter: ${paramName}`,
      instruction: [
        `📍 Request Attribute: "${displayName}"`,
        `   Path: Settings → Server-side service monitoring → Request attributes`,
        `   ─`,
        `   • Data source: HTTP request URL path`,
        `   • Capture value from URL matching: ${route}`,
        `   • RegEx to extract value: ${regexRoute}`,
        `   • Representation: First 200 characters`,
      ].join("\n"),
      confidence: "high",
      category: paramName.toLowerCase().includes("id") ? "identity" : "reference",
    });
  }

  // Financial endpoint
  if (/payment|pay|checkout|charge|billing|invoice|transaction/.test(lower)) {
    if (["POST", "PUT", "PATCH", "ANY"].includes(m)) {
      suggestions.push({
        name: "Transaction Amount",
        dataSource: "HTTP Request Body — JSON field: amount / totalAmount / price",
        instruction: [
          `📍 Request Attribute: "Transaction Amount"`,
          `   Path: Settings → Server-side service monitoring → Request attributes`,
          `   ─`,
          `   • Data source: HTTP request body`,
          `   • JSON path expression: $.amount  (also try: $.totalAmount, $.price, $.grandTotal)`,
          `   • Scope: ${m} ${route}`,
          `   • Representation: First 100 characters`,
        ].join("\n"),
        confidence: "high",
        category: "financial",
      });
      suggestions.push({
        name: "Currency Code",
        dataSource: "HTTP Request Body — JSON field: currency / currencyCode",
        instruction: [
          `📍 Request Attribute: "Currency Code"`,
          `   • Data source: HTTP request body`,
          `   • JSON path expression: $.currency  (also try: $.currencyCode, $.currencyIso)`,
        ].join("\n"),
        confidence: "medium",
        category: "financial",
      });
    }
  }

  // Order endpoint
  if (/order/.test(lower)) {
    if (m === "POST") {
      suggestions.push({
        name: "Customer ID",
        dataSource: "HTTP Request Body — JSON field: customerId / userId",
        instruction: [
          `📍 Request Attribute: "Customer ID"`,
          `   • Data source: HTTP request body`,
          `   • JSON path expression: $.customerId  (also try: $.userId, $.buyerId, $.accountId)`,
        ].join("\n"),
        confidence: "high",
        category: "identity",
      });
      suggestions.push({
        name: "Order Total",
        dataSource: "HTTP Request Body — JSON field: total / orderTotal",
        instruction: [
          `📍 Request Attribute: "Order Total"`,
          `   • Data source: HTTP request body`,
          `   • JSON path expression: $.total  (also try: $.orderTotal, $.subtotal, $.amount)`,
        ].join("\n"),
        confidence: "high",
        category: "financial",
      });
    }
  }

  // User/Customer endpoint
  if (/user|customer|account|member|profile/.test(lower)) {
    suggestions.push({
      name: "User Identifier",
      dataSource: "HTTP URL path or Request Body",
      instruction: [
        `📍 Request Attribute: "User Identifier"`,
        `   • Data source: HTTP request URL path (preferred) or request body`,
        `   • For URL path: extract userId / customerId segment using RegEx`,
        `   • For JSON body: $.userId  (also try: $.customerId, $.accountId, $.sub)`,
      ].join("\n"),
      confidence: "high",
      category: "identity",
    });
  }

  return suggestions;
}

function generateMethodSuggestions(className: string | null, methodName: string | null): AttributeSuggestion[] {
  if (!methodName) return [];
  const suggestions: AttributeSuggestion[] = [];
  const funcLower = methodName.toLowerCase();
  const nsLower = (className || "").toLowerCase();
  const full = `${nsLower} ${funcLower}`;
  const shortClass = className?.split(".").pop() || className || "*";

  const isReader = ["get", "find", "fetch", "load", "retrieve", "query", "search", "read", "lookup"].some((p) =>
    funcLower.startsWith(p)
  );
  const isWriter = ["create", "save", "update", "process", "submit", "place", "pay", "charge", "handle", "execute", "apply", "confirm", "cancel", "book"].some((p) =>
    funcLower.startsWith(p)
  );

  if (/payment|pay|charge|debit|billing/.test(full)) {
    suggestions.push({
      name: "Payment Amount",
      dataSource: `Method parameter of ${shortClass}.${methodName}()`,
      instruction: [
        `📍 Request Attribute: "Payment Amount"`,
        `   Path: Settings → Server-side service monitoring → Request attributes → Add new attribute`,
        `   ─`,
        `   • Attribute name: Payment Amount`,
        `   • Data source: Method call — parameter`,
        `   • Class (fully qualified): ${className || shortClass}`,
        `   • Method: ${methodName}`,
        `   • Look for: numeric param named "amount", "price", "total"`,
        `     → Try capturing "1. parameter" — if that's not it, try "2. parameter"`,
        `   • Representation: First 100 characters`,
      ].join("\n"),
      confidence: "high",
      category: "financial",
    });
    if (isReader) {
      suggestions.push({
        name: "Payment Status",
        dataSource: `Return value of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Payment Status"`,
          `   • Data source: Return value`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • If return is an object, getter candidates:`,
          `     getStatus() / getState() / getPaymentStatus() / getResult()`,
          `   • If return is String/enum: capture directly (no getter needed)`,
        ].join("\n"),
        confidence: "medium",
        category: "identity",
      });
    }
  }

  if (/order/.test(full)) {
    if (isWriter) {
      suggestions.push({
        name: "Order ID (Generated)",
        dataSource: `Return value of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Order ID"`,
          `   • Data source: Return value`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • If return is an object, getter candidates:`,
          `     getOrderId() / getId() / getReference() / getReferenceNumber() / getOrderNumber()`,
          `   • If return is a String: capture directly`,
        ].join("\n"),
        confidence: "high",
        category: "transaction",
      });
      suggestions.push({
        name: "Order Amount",
        dataSource: `Method parameter of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Order Amount"`,
          `   • Data source: Method parameter`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • Look for param named "amount", "total", "price"`,
          `   • If param is an object: getTotal() / getAmount() / getTotalPrice()`,
        ].join("\n"),
        confidence: "high",
        category: "financial",
      });
      suggestions.push({
        name: "Customer ID (Order Placer)",
        dataSource: `Method parameter of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Customer ID"`,
          `   • Data source: Method parameter`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • Look for param named "customerId", "userId", "buyerId"`,
          `   • If param is an object: getCustomerId() / getUserId() / getBuyerId()`,
        ].join("\n"),
        confidence: "high",
        category: "identity",
      });
    } else if (isReader) {
      suggestions.push({
        name: "Order ID (Input)",
        dataSource: `1st parameter of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Order ID"`,
          `   • Data source: Method parameter`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • Capture: 1st parameter (the order identifier being looked up)`,
          `   • Representation: ToString`,
        ].join("\n"),
        confidence: "high",
        category: "transaction",
      });
    }
  }

  if (/user|customer|account|member/.test(full)) {
    suggestions.push({
      name: "User Identifier",
      dataSource: `Parameter of ${shortClass}.${methodName}()`,
      instruction: [
        `📍 Request Attribute: "User Identifier"`,
        `   • Data source: Method parameter`,
        `   • Class: ${className || shortClass}`,
        `   • Method: ${methodName}`,
        `   • Capture: 1st String parameter (userId / customerId)`,
        `   • Representation: ToString`,
      ].join("\n"),
      confidence: "high",
      category: "identity",
    });
    if (isReader) {
      suggestions.push({
        name: "Loyalty Tier / Membership Status",
        dataSource: `Return value of ${shortClass}.${methodName}()`,
        instruction: [
          `📍 Request Attribute: "Loyalty Tier"`,
          `   • Data source: Return value`,
          `   • Class: ${className || shortClass}`,
          `   • Method: ${methodName}`,
          `   • Getter candidates:`,
          `     getLoyaltyTier() / getTier() / getMembershipLevel() / getStatus() / getSegment()`,
        ].join("\n"),
        confidence: "medium",
        category: "identity",
      });
    }
  }

  if (/cart|checkout|transaction|basket/.test(full)) {
    suggestions.push({
      name: "Transaction Reference",
      dataSource: isWriter
        ? `Return value of ${shortClass}.${methodName}()`
        : `1st parameter of ${shortClass}.${methodName}()`,
      instruction: isWriter
        ? [
            `📍 Request Attribute: "Transaction Reference"`,
            `   • Data source: Return value`,
            `   • Class: ${className || shortClass}`,
            `   • Method: ${methodName}`,
            `   • Getter candidates:`,
            `     getTransactionId() / getReference() / getId() / getConfirmationNumber()`,
          ].join("\n")
        : [
            `📍 Request Attribute: "Transaction Reference"`,
            `   • Data source: Method parameter`,
            `   • Class: ${className || shortClass}`,
            `   • Method: ${methodName}`,
            `   • Capture: 1st parameter (transaction identifier)`,
          ].join("\n"),
      confidence: "high",
      category: "reference",
    });
  }

  if (/product|sku|catalog|item/.test(full)) {
    suggestions.push({
      name: "Product / SKU",
      dataSource: isWriter
        ? `Method parameter of ${shortClass}.${methodName}()`
        : `Return value or parameter of ${shortClass}.${methodName}()`,
      instruction: [
        `📍 Request Attribute: "Product SKU"`,
        `   • Data source: Method parameter`,
        `   • Class: ${className || shortClass}`,
        `   • Method: ${methodName}`,
        `   • Look for param named "sku", "productId", "itemId"`,
        `   • If param is object: getSku() / getProductId() / getItemCode()`,
      ].join("\n"),
      confidence: "medium",
      category: "product",
    });
  }

  return suggestions;
}

// ─── DQL Queries ──────────────────────────────────────────────────────────────

// Single matchesRegex with all keywords joined as alternation — stays within DQL's
// 250 sub-expression limit (1 call vs 90+ contains() calls which exceeded it).
// _mkey is already lower-cased so the regex match is implicitly case-insensitive.
// Note: now reads from the active (mutable) catalog so user keyword edits flow
// through. The constant is unused at runtime (services list is metrics-based)
// and kept only for documentation/future-DQL use; computed once at module load.
const KEYWORD_REGEX = _activeCatalog
  .flatMap((c) => c.keywords.map((e) => e.text))
  .join("|");

// OneAgent-only services. Mirrors the Services Explorer logic: include only services
// where `dt.agent.module.type` is set on the request-count metric. OpenTelemetry-only
// services have `dt.agent.module.type = null` (only `telemetry.sdk.language` is set).
//
// Also projects `entity_id = dt.entity.service` so the per-service
// drilldown queries can fall back to the classic entity ID when the
// Smartscape ID format doesn't line up, and `routes` — the full set
// of distinct endpoint.name values seen for this service in the
// window. Projecting routes here (instead of via a separate global
// endpoint scan that has to be joined back by service ID) eliminates
// a class of ID-mismatch bugs that hit SOAP/Axis services like
// EasytravelService: when the per-operation metric rows live under a
// different Smartscape / entity ID than the aggregate service row,
// any client-side join across two queries silently drops them and
// the service is wrongly reported as "not a candidate" despite
// having business-keyword endpoints. With routes attached directly
// to the service row there's nothing to join.
const SERVICES_QUERY = `timeseries {
    req = sum(dt.service.request.count, scalar: true)
  },
  union: true,
  by: { dt.smartscape.service, dt.entity.service, dt.service.name, service.name, endpoint.name, dt.agent.module.type, telemetry.sdk.language },
  filter: isNotNull(dt.smartscape.service) AND isNotNull(dt.agent.module.type),
  from: now()-30m
| summarize {
    total_spans    = sum(req),
    http_endpoints = countDistinct(endpoint.name),
    routes         = collectDistinct(endpoint.name),
    service_name   = takeLast(coalesce(dt.service.name, service.name)),
    technology     = takeLast(coalesce(dt.agent.module.type, telemetry.sdk.language)),
    entity_id      = takeLast(dt.entity.service)
  }, by: { service_id = toString(dt.smartscape.service) }
| filter isNotNull(service_name) AND service_name != ""
| fieldsAdd method_spans = 0
| fields service_id, entity_id, service_name, total_spans, http_endpoints, method_spans, technology, routes
| sort total_spans desc
| limit 500`;

// KEYWORD_REGEX is no longer used by the service list query (metrics-based now),
// but is still consumed by the per-service method scoring below. Keep the constant.
void KEYWORD_REGEX;

// Global method-span scan — one row per unique (class, method, span.name)
// across the OneAgent-monitored fleet. Powers the top-of-page "Method
// candidates" tile: a quick global tally of method spans whose
// class/method names match the business keyword catalog. Filtering on
// isNotNull(code.function) limits us to instrumented method spans
// (skipping pure HTTP / DB / messaging spans) so the row count stays
// manageable. The limit is generous because dedup happens server-side
// via summarize-by, not on the raw event count. We compute a `calls`
// aggregate so DQL accepts the summarize step (empty `{}` aggregation
// is rejected by the parser, which would silently produce 0 rows).
const GLOBAL_METHODS_QUERY = `fetch spans, from:now()-30m
| filter isNotNull(code.function)
| summarize { calls = count() }, by: { class_name = code.namespace, method_name = code.function, span_name = span.name }
| limit 20000`;

// Fleet-wide trace-joined endpoint↔method correlation. Powers BOTH global
// views (HTTP endpoint candidates + Method candidates tabs).
//
// Mirrors the per-service Services-tab pipeline (`buildEndpointMethodsQuery`
// + `filterToEndpointSubtree`) at fleet scale so the global views show the
// exact same method candidates as the Services tab.
//
// IMPORTANT: we keep the candidate set INCLUSIVE by pulling the 5
// most-recent server-entry rep traces per (endpoint_service_id, endpoint)
// pair — same traces the Investigate Methods sheet's sample navigator
// can step through. Earlier shapes picked ONE arbitrary trace via
// `takeFirst(span.id)` without a `sort`, which meant the card preview's
// methods came from trace A while the waterfall could open trace B,
// listing a completely different code path (highly dynamic endpoints
// like `/orange-booking-finish.jsf` walk a different subset of services
// each request).
//
// Pipeline (right side of the join):
//   1. Filter to server-entry spans with endpoint.name set — EXACTLY
//      the same filter `buildTraceSamplesQuery` uses to populate the
//      Investigate Methods sample navigator. If a trace shows up in
//      that navigator, it shows up here too (and vice versa).
//   2. Sort by raw timestamp desc, then dedup by (service, endpoint,
//      trace.id) — keeping the most recent server-entry span per
//      unique (service, endpoint, trace) triple. This matches the
//      navigator's `sort timestamp desc | dedup trace.id | limit 5`.
//   3. Re-sort timestamp desc so collectArray sees most-recent-first.
//   4. Summarize collects up to 5 (trace.id, entry_span_id) pairs per
//      (service, endpoint) — same trace IDs the navigator can step
//      through, so any business candidate visible there shows here.
//   5. Expand back into one row per pair so the outer join produces one
//      (endpoint, entry_span_id) tag per rep trace.
//
// Outer fetch is NOT filtered to `code.function` AND NOT filtered to the
// endpoint's owning service. We deliberately include downstream
// cross-service descendants (e.g. an IIS `/Booking` endpoint that calls
// a .NET worker service) so the chip count in the table matches what
// the Investigate Methods sheet's "Endpoint subtree" view shows.
// Without this, business candidates that live in underlying services
// would be hidden from the outer table even though the Investigate
// drill-in surfaces them.
//
// The client-side `filterGlobalToEndpointSubtree` groups by
// (endpoint_service_id, endpoint, entry_span_id) and BFS-walks each
// sample trace's subtree independently before merging candidates.
const GLOBAL_ENDPOINT_METHODS_QUERY = `fetch spans, from:now()-30m
| filter isNotNull(span.name)
  AND (isNotNull(code.function) OR span.kind == "server" OR isNotNull(endpoint.name))
| fieldsAdd trace_join_id = toString(trace.id)
| join [
    fetch spans, from:now()-30m
    | filter span.kind == "server"
      AND isNotNull(endpoint.name) AND endpoint.name != "NON_KEY_REQUESTS"
    | fieldsAdd endpoint = endpoint.name, endpoint_service_id = toString(dt.smartscape.service)
    | fieldsAdd entry_key = concat(toString(toLong(timestamp)), "|", span.id, "|", trace.id)
    | summarize { entries = collectArray(entry_key) }, by: { endpoint_service_id, endpoint }
    | fieldsAdd entries = arraySort(entries, direction: "descending")
    | fieldsAdd entries = arraySlice(entries, from: 0, to: 10)
    | expand entries
    | fieldsAdd parts = splitString(entries, "|")
    | fieldsAdd entry_span_id = parts[1], trace_join_id = parts[2]
    | fields endpoint, endpoint_service_id, entry_span_id, trace_join_id
  ], on: { trace_join_id }, fields: { endpoint, entry_span_id, endpoint_service_id }
| fields
    endpoint,
    endpoint_service_id,
    entry_span_id,
    trace_id = trace.id,
    span_id = span.id,
    parent_id = span.parent_id,
    span_name = span.name,
    span_kind = span.kind,
    class_name = code.namespace,
    method_name = code.function,
    service_id = toString(dt.smartscape.service)
| limit 500000`;

function buildEndpointsQuery(serviceId: string): string {
  const safe = serviceId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Match how the built-in Services UI filters per service: dt.smartscape.service
  // is a smartscape node ref, NOT a plain string, so a direct string equality
  // silently matches 0 rows. Either wrap with toSmartscapeId() or fall back to
  // the classic dt.entity.service field. Also drop the synthetic
  // NON_KEY_REQUESTS bucket that Dynatrace uses for low-volume aggregation.
  // http.request.method is dropped from `by:` because it is null on this metric
  // for OneAgent-monitored services and was contributing nothing.
  return `timeseries req = sum(dt.service.request.count, scalar: true),
  by: { endpoint.name },
  filter: (dt.smartscape.service == toSmartscapeId("${safe}") OR dt.entity.service == "${safe}")
      AND isNotNull(endpoint.name)
      AND endpoint.name != "NON_KEY_REQUESTS",
  from: now()-30m
| summarize { calls = sum(req) }, by: { route = endpoint.name }
| fieldsAdd http_method = null
| filter calls > 0
| sort calls desc
| limit 100`;
}

function buildMethodsQuery(serviceId: string): string {
  // Spans-based — only returns rows for services that emit OpenTelemetry spans.
  // OneAgent-only services have no spans in Grail, so this is intentionally empty
  // for the OneAgent-filtered service list above. Kept for future use.
  const safe = serviceId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `fetch spans, from:now()-30m
| filter dt.entity.service == "${safe}"
| filter isNotNull(code.function) and isNotNull(code.namespace)
| summarize { calls = count() }, by: { class_name = code.namespace, method_name = code.function, span_name = span.name }
| sort calls desc
| limit 200`;
}

// Per-service method scan that returns RAW per-span rows for each endpoint's
// representative trace. We deliberately do NOT aggregate at the DQL layer:
// we need span.id + span.parent_id intact so we can walk the trace tree
// client-side and keep only spans that are inside the endpoint's subtree
// (entry-point + descendants). Without the subtree filter the table would
// show sibling spans that live in the same trace but belong to a different
// endpoint (e.g. a `get User Roles` server span sitting next to a
// `get Loyalty Status` server span in the same trace).
//
// Pipeline:
//   1. Inner join builds one row per (endpoint, trace.id, entry_span_id),
//      where entry_span_id is the entry-point span for that endpoint.
//   2. Outer fetch is restricted to spans of THIS service, then joined onto
//      the inner side by trace.id so each span carries its endpoint label.
//   3. Project only the columns the client tree-walker / scorer needs.
function buildEndpointMethodsQuery(serviceId: string): string {
  const safe = serviceId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Inner subquery is scoped to THIS service so the rep traces are the ones
  // containing this service's endpoint entry-points. Outer fetch is NOT
  // scoped to this service — we deliberately pull every span in those rep
  // traces (including downstream cross-service descendants) so the chip
  // counts in the EndpointsExplorer table can match the Investigate
  // Methods sheet's "Endpoint subtree" view when the user opts in to
  // cross-service descendants via Settings. When the setting is OFF
  // (default), client-side filtering keeps only rows whose `service_id`
  // matches this service — same effect as the old DQL-level filter, but
  // controllable from the UI.
  //
  // IMPORTANT: the rep traces per endpoint MUST line up with the traces
  // the Investigate Methods sheet can show in the waterfall. Otherwise the
  // card preview lists methods from trace A while the waterfall renders
  // trace B — which is what users see for highly dynamic endpoints whose
  // code paths vary per request (e.g. `/orange-booking-finish.jsf` walking
  // a different subset of `AuthenticationService` / `VerificationService`
  // / `BookingService` calls each time).
  //
  // To keep the candidate set INCLUSIVE we pull the SAME 5 most-recent
  // server-entry traces per endpoint that `buildTraceSamplesQuery` shows
  // in the navigator, then merge their subtrees client-side. Any method
  // surfaced on the card preview is therefore reachable from at least one
  // of the sample traces the user can step through.
  //
  // Pipeline (right side of the join):
  //   1. Filter to server-entry spans whose `endpoint.name` is set —
  //      EXACTLY the same filter as `buildTraceSamplesQuery` so the
  //      candidate set is computed from the SAME 5 traces the user can
  //      step through in the Investigate Methods sheet's navigator.
  //   2. Sort by raw timestamp desc, then dedup by (endpoint, trace.id)
  //      — keeps the most recent server-entry span per (endpoint,
  //      trace) pair, matching the navigator's
  //      `sort timestamp desc | dedup trace.id | limit 5`.
  //   3. Re-sort timestamp desc so collectArray sees most-recent-first.
  //   4. Summarize collects up to 5 (trace.id, entry_span_id) pairs per
  //      endpoint into a record array — same trace IDs as the
  //      navigator, so any business candidate visible there shows here.
  //   5. Expand back into one row per pair so the outer join produces
  //      one (endpoint, entry_span_id) tag per rep trace.
  return `fetch spans, from:now()-30m
| filter isNotNull(span.name)
  AND (isNotNull(code.function) OR span.kind == "server" OR isNotNull(endpoint.name))
| fieldsAdd trace_join_id = toString(trace.id)
| join [
    fetch spans, from:now()-30m
    | filter (dt.entity.service == "${safe}" OR dt.smartscape.service == toSmartscapeId("${safe}"))
    | filter span.kind == "server"
      AND isNotNull(endpoint.name) AND endpoint.name != "NON_KEY_REQUESTS"
    | fieldsAdd entry_key = concat(toString(toLong(timestamp)), "|", span.id, "|", trace.id)
    | summarize { entries = collectArray(entry_key) }, by: { endpoint = endpoint.name }
    | fieldsAdd entries = arraySort(entries, direction: "descending")
    | fieldsAdd entries = arraySlice(entries, from: 0, to: 10)
    | expand entries
    | fieldsAdd parts = splitString(entries, "|")
    | fieldsAdd entry_span_id = parts[1], trace_join_id = parts[2]
    | fields endpoint, entry_span_id, trace_join_id
  ], on: { trace_join_id }, fields: { endpoint, entry_span_id }
| fields
    endpoint,
    entry_span_id,
    trace_id = trace.id,
    span_id = span.id,
    parent_id = span.parent_id,
    span_name = span.name,
    span_kind = span.kind,
    class_name = code.namespace,
    method_name = code.function,
    service_id = toString(dt.smartscape.service)
| limit 500000`;
}

// Pulls a single span with all of its attributes for the "Investigate full
// method details" drilldown. Returns at most one row. Both trace.id and
// span.id are uid-typed in Grail, so both go through `toUid()`.
function buildSpanDetailQuery(traceId: string, spanId: string): string {
  const safeTrace = traceId.replace(/[^0-9a-fA-F]/g, "");
  const safeSpan = spanId.replace(/[^0-9a-fA-F]/g, "");
  return `fetch spans, from:now()-30m
| filter trace.id == toUid("${safeTrace}") AND span.id == toUid("${safeSpan}")
| limit 1`;
}

// Pulls every span of a single trace (capped to keep payloads sane).
// Returned spans carry span.id, span.parent_id, span.name, span.kind,
// code.namespace, code.function, start_time, duration, endpoint.name and
// status code so the waterfall can build a parent/child tree and the
// detail panel can render code-level identity. We keep ALL attributes per
// row by NOT projecting (`fields`) — the spans event has a wide schema and
// extra columns are essentially free at this scale.
function buildTraceWaterfallQuery(traceId: string): string {
  const safe = traceId.replace(/[^0-9a-fA-F]/g, "");
  // Window is intentionally much wider than the sample-traces lookup
  // (which uses now()-30m). The sample list is fetched once when the
  // sheet opens, but the waterfall re-runs fresh every time the user
  // clicks the navigator arrows. If the user lingers on the sheet for
  // a while and then steps to an older sample, a tight 30m window on
  // the waterfall would have rolled past the trace's spans and return
  // nothing ("No spans recorded for this trace.") even though the
  // trace is perfectly valid. trace.id is unique so a 24h scan is
  // cheap regardless of window size.
  return `fetch spans, from:now()-24h
| filter trace.id == toUid("${safe}")
| sort start_time asc
| limit 500`;
}

// Up to 5 recent example trace ids for a given (service, endpoint).
// We use this to power the trace-sample navigator in the Investigate
// Methods sheet so the user can step through a handful of representative
// traces instead of being stuck on whichever single trace the broader
// methods query happened to pick.
//
// Restricted to span.kind == server so we always land on the endpoint's
// entry-point span — which is what the waterfall subtree logic anchors
// on. `dedup trace.id` after a recency sort keeps the newest unique
// traces; we never return more than 5 to keep the navigator tight.
function buildTraceSamplesQuery(serviceId: string, route: string): string {
  const safeService = serviceId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeRoute = route.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `fetch spans, from:now()-30m
| filter (dt.entity.service == "${safeService}" OR dt.smartscape.service == toSmartscapeId("${safeService}"))
| filter endpoint.name == "${safeRoute}" AND span.kind == "server"
| sort timestamp desc
| dedup trace.id
| limit 5
| fields trace_id = trace.id, ts = timestamp`;
}

// ─── Data Parsers ─────────────────────────────────────────────────────────────

// Coerce DQL response values (BigInt for `long`, string for serialized numerics,
// number for doubles) to a plain JavaScript number for arithmetic / `> 0` checks.
function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseServices(data: any): ServiceRecord[] {
  if (!data?.records) return [];
  return data.records
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any): ServiceRecord => {
      // `routes` arrives from DQL as an array of strings (some SDK
      // shapes return null when the array is empty). Coerce safely.
      const rawRoutes = Array.isArray(r.routes) ? r.routes : [];
      const routes = rawRoutes
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((v: any) => (v == null ? "" : String(v)))
        .filter((v: string) => v && v !== "NON_KEY_REQUESTS")
        // Drop static resources (images, css, js, fonts, etc.) —
        // they're transport noise and would otherwise inflate the
        // endpoints chip and the business-candidate scoring.
        .filter((v: string) => !isStaticResourceRoute(v));
      return {
        service_id: String(r.service_id ?? r.service_name ?? ""),
        entity_id: r.entity_id ? String(r.entity_id) : null,
        service_name: String(r.service_name ?? ""),
        total_spans: toNum(r.total_spans),
        http_endpoints: toNum(r.http_endpoints),
        method_spans: toNum(r.method_spans),
        technology: r.technology ? String(r.technology) : null,
        routes,
      };
    })
    .filter((s: ServiceRecord) => s.service_name !== "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEndpoints(data: any): EndpointRecord[] {
  if (!data?.records) return [];
  return data.records.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any): EndpointRecord => ({
      route: String(r.route ?? ""),
      http_method: r.http_method ? String(r.http_method) : null,
      calls: toNum(r.calls),
    })
  ).filter(
    // Drop static-resource routes (see STATIC_RESOURCE_EXTENSIONS).
    (e: EndpointRecord) => !isStaticResourceRoute(e.route),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMethods(data: any): MethodRecord[] {
  if (!data?.records) return [];
  return data.records.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r: any): MethodRecord => ({
      class_name: r.class_name ? String(r.class_name) : null,
      method_name: r.method_name ? String(r.method_name) : null,
      span_name: r.span_name ? String(r.span_name) : null,
      calls: toNum(r.calls),
    })
  );
}

// span.id / trace.id come back from DQL as opaque objects or hex strings.
// Coerce to a plain hex string so we can pass them straight back into
// `toUid()` / `toSpanId()` in the detail query.
function spanIdToHex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.hex === "string") return obj.hex;
  }
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEndpointMethods(data: any): EndpointMethodRecord[] {
  if (!data?.records) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.records.map((r: any): EndpointMethodRecord => ({
    endpoint: String(r.endpoint ?? ""),
    entry_span_id: spanIdToHex(r.entry_span_id),
    trace_id: spanIdToHex(r.trace_id ?? r["trace.id"]),
    span_id: spanIdToHex(r.span_id ?? r["span.id"]),
    parent_id: spanIdToHex(r.parent_id ?? r["span.parent_id"]),
    span_name: String(r.span_name ?? ""),
    span_kind: r.span_kind ? String(r.span_kind) : null,
    class_name: r.class_name ? String(r.class_name) : null,
    method_name: r.method_name ? String(r.method_name) : null,
    service_id: r.service_id ? String(r.service_id) : null,
  }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((m: EndpointMethodRecord) =>
      m.endpoint !== "" &&
      m.span_name !== "" &&
      m.span_id !== null &&
      // Drop spans that hang off a static-resource endpoint.
      !isStaticResourceRoute(m.endpoint),
    );
}

// Walks each (endpoint, rep-trace) subtree from its entry-point span and
// keeps only spans inside that subtree (entry-point itself + every
// descendant reachable via parent_id chains). With multiple rep traces
// per endpoint we group by (endpoint, entry_span_id) so each sample
// trace is walked independently — sibling subtrees of the same endpoint
// in different traces don't pollute each other, and a trace that's a
// rep for more than one endpoint contributes correctly to each.
// Spans of THIS service that happen to live in the same trace but belong
// to a different endpoint's subtree (e.g. a sibling server span for `get
// User Roles` next to a `get Loyalty Status` server span in the same
// trace) still get dropped per group.
function filterToEndpointSubtree(records: EndpointMethodRecord[]): EndpointMethodRecord[] {
  // Key = endpoint + entry_span_id. Each key identifies one sample
  // trace's subtree for one endpoint.
  const byGroup = new Map<string, EndpointMethodRecord[]>();
  for (const r of records) {
    if (!r.entry_span_id) continue;
    const key = `${r.endpoint}\u0000${r.entry_span_id}`;
    const list = byGroup.get(key) ?? [];
    list.push(r);
    byGroup.set(key, list);
  }
  const kept: EndpointMethodRecord[] = [];
  for (const [, list] of byGroup) {
    const entryId = list[0].entry_span_id;
    if (!entryId) continue;
    // Build parent_id → [span_id, ...] map across this group's rows.
    const children = new Map<string, string[]>();
    for (const r of list) {
      if (!r.span_id || !r.parent_id) continue;
      const arr = children.get(r.parent_id) ?? [];
      arr.push(r.span_id);
      children.set(r.parent_id, arr);
    }
    // BFS from the entry-point span; collect every descendant span.id.
    const subtree = new Set<string>([entryId]);
    const queue: string[] = [entryId];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const kids = children.get(cur) ?? [];
      for (const k of kids) {
        if (subtree.has(k)) continue;
        subtree.add(k);
        queue.push(k);
      }
    }
    for (const r of list) {
      if (r.span_id && subtree.has(r.span_id)) kept.push(r);
    }
  }
  return kept;
}

// Builds a per-endpoint candidate list, business-scored. The map key is the
// `endpoint` value as returned by Grail (matching `EndpointRecord.route`).
//
// Within each endpoint we dedupe by `displayName` (e.g. `Class.method()`):
// two spans whose names differ only by framework wrappers but resolve to the
// same code identity would otherwise show up as visually identical duplicates
// in the table. We keep the highest-scored candidate, sum the call counts and
// merge the keyword set.
function groupMethodCandidates(
  records: EndpointMethodRecord[],
  opts: { allowSql?: boolean; ownerServiceIds?: Set<string>; subtreeSpanIds?: Set<string> } = {},
): Map<string, MethodCandidate[]> {
  const owners = opts.ownerServiceIds;
  const out = new Map<string, MethodCandidate[]>();
  records.forEach((r, i) => {
    const { score, keywords } = scoreMethodLike(
      r.class_name ?? null,
      r.method_name ?? null,
      r.span_name,
      opts,
    );
    const displayName = r.method_name
      ? `${r.class_name?.split(".").pop() ?? "?"}.${r.method_name}()`
      : r.span_name;
    const isCrossService = Boolean(
      r.service_id && owners && owners.size > 0 && !owners.has(r.service_id),
    );
    const isSurrounding = Boolean(
      opts.subtreeSpanIds && r.span_id && !opts.subtreeSpanIds.has(r.span_id),
    );
    const candidate: MethodCandidate = {
      id: `mc-${i}`,
      span_name: r.span_name,
      class_name: r.class_name,
      method_name: r.method_name,
      span_kind: r.span_kind,
      displayName,
      calls: 1,
      score,
      keywords,
      confidence: getConfidence(score),
      example_span_id: r.span_id,
      example_trace_id: r.trace_id,
      is_cross_service: isCrossService,
      is_surrounding: isSurrounding,
      owning_service_id: r.service_id,
    };
    const list = out.get(r.endpoint) ?? [];
    list.push(candidate);
    out.set(r.endpoint, list);
  });
  // Dedupe within each endpoint by displayName ALONE. The same
  // Class.method() showing up under both `server` and `internal`
  // span kinds is an RA-shadow artefact (see `dropRaShadowSpans`) —
  // OneAgent instruments the method for a Request Attribute capture
  // and produces an internal child of the original server span, so
  // the same method effectively appears twice. Folding them into one
  // row keeps the UI honest (one method = one row), sums the calls,
  // unions the keywords. The surviving span_kind is biased to
  // `server` because that's where the verifier + draft-board tooling
  // is anchored.
  for (const [ep, list] of out) {
    const byKey = new Map<string, MethodCandidate>();
    for (const c of list) {
      const key = c.displayName;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, c);
        continue;
      }
      const mergedKeywords = Array.from(new Set([...existing.keywords, ...c.keywords]));
      const cIsServer = (c.span_kind ?? "").toLowerCase() === "server";
      const eIsServer = (existing.span_kind ?? "").toLowerCase() === "server";
      const winner =
        c.score > existing.score
          ? c
          : existing.score > c.score
            ? existing
            : cIsServer && !eIsServer
              ? c
              : existing;
      const loser = winner === c ? existing : c;
      byKey.set(key, {
        ...winner,
        calls: existing.calls + c.calls,
        keywords: mergedKeywords,
        confidence: getConfidence(winner.score),
        class_name: winner.class_name ?? loser.class_name,
        method_name: winner.method_name ?? loser.method_name,
        span_kind:
          cIsServer || eIsServer ? "server" : winner.span_kind ?? loser.span_kind,
        example_span_id: winner.example_span_id ?? loser.example_span_id,
        example_trace_id: winner.example_trace_id ?? loser.example_trace_id,
        // A method is NOT surrounding if ANY occurrence is inside the
        // subtree — at least one trace confirms it's a direct descendant.
        is_surrounding: existing.is_surrounding && c.is_surrounding,
        // A method IS cross-service if ANY occurrence came from a
        // downstream service — the highest-scored variant might happen
        // to be a same-service span, but we must not drop the label.
        is_cross_service: existing.is_cross_service || c.is_cross_service,
      });
    }
    const deduped = Array.from(byKey.values()).sort(
      (a, b) => b.score - a.score || b.calls - a.calls,
    );
    out.set(ep, deduped);
  }
  return out;
}

// Fleet-wide trace-joined record: one row per span in a representative
// trace of (endpoint_service_id, endpoint), restricted to spans whose
// owning service matches the endpoint's. Includes parent_id and
// entry_span_id so `filterGlobalToEndpointSubtree` can walk the tree and
// drop spans that belong to sibling endpoints sharing the same trace.
//
// Same shape as the per-service `EndpointMethodRecord` plus
// `endpoint_service_id` so the global grouper can key by
// `${endpoint_service_id}::${endpoint}`.
interface GlobalEndpointMethodRecord {
  endpoint: string;
  endpoint_service_id: string;
  entry_span_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_id: string | null;
  span_name: string;
  span_kind: string | null;
  class_name: string | null;
  method_name: string | null;
  service_id: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGlobalEndpointMethods(data: any): GlobalEndpointMethodRecord[] {
  if (!data?.records) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data.records
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any): GlobalEndpointMethodRecord => ({
      endpoint: String(r.endpoint ?? ""),
      endpoint_service_id: String(r.endpoint_service_id ?? ""),
      entry_span_id: spanIdToHex(r.entry_span_id),
      trace_id: spanIdToHex(r.trace_id ?? r["trace.id"]),
      span_id: spanIdToHex(r.span_id ?? r["span.id"]),
      parent_id: spanIdToHex(r.parent_id ?? r["span.parent_id"]),
      span_name: String(r.span_name ?? ""),
      span_kind: r.span_kind ? String(r.span_kind) : null,
      class_name: r.class_name ? String(r.class_name) : null,
      method_name: r.method_name ? String(r.method_name) : null,
      service_id: r.service_id ? String(r.service_id) : null,
    }))
    .filter(
      (r: GlobalEndpointMethodRecord) =>
        r.endpoint !== "" &&
        r.endpoint_service_id !== "" &&
        r.span_name !== "" &&
        r.span_id !== null &&
        // Drop spans that hang off a static-resource endpoint.
        !isStaticResourceRoute(r.endpoint),
    );
}

// Global twin of `filterToEndpointSubtree`. Groups rows by
// `(endpoint_service_id, endpoint, entry_span_id)` — each group's rep
// trace is identified by its entry_span_id, so with up to 5 rep traces
// per (service, endpoint) we walk each subtree independently and merge
// the kept rows. Walks parent_id downward from entry_span_id (BFS),
// collects every descendant span_id, then keeps only rows whose span_id
// is in that descendant set. Spans that belong to a sibling endpoint's
// subtree but happen to live in the same trace get dropped here — same
// rule as the Services tab.
function filterGlobalToEndpointSubtree(
  records: GlobalEndpointMethodRecord[],
): GlobalEndpointMethodRecord[] {
  const byKey = new Map<string, GlobalEndpointMethodRecord[]>();
  for (const r of records) {
    if (!r.entry_span_id) continue;
    const k = `${r.endpoint_service_id}\u0000${r.endpoint}\u0000${r.entry_span_id}`;
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const kept: GlobalEndpointMethodRecord[] = [];
  for (const [, list] of byKey) {
    const entryId = list[0].entry_span_id;
    if (!entryId) continue;
    const children = new Map<string, string[]>();
    for (const r of list) {
      if (!r.span_id || !r.parent_id) continue;
      const arr = children.get(r.parent_id) ?? [];
      arr.push(r.span_id);
      children.set(r.parent_id, arr);
    }
    const subtree = new Set<string>([entryId]);
    const queue: string[] = [entryId];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const kids = children.get(cur) ?? [];
      for (const k of kids) {
        if (subtree.has(k)) continue;
        subtree.add(k);
        queue.push(k);
      }
    }
    for (const r of list) {
      if (r.span_id && subtree.has(r.span_id)) kept.push(r);
    }
  }
  return kept;
}

// Group fleet-wide records by (endpoint_service_id, endpoint) and score
// each method via the same `scoreMethodLike` rules used everywhere else.
// Honours the SQL methods setting. Within an endpoint we dedupe by
// (displayName, span.kind) — same rule as `groupMethodCandidates` — so
// the table doesn't show duplicates that differ only in trace-internal
// noise. Expects records already filtered to each endpoint's subtree
// (see `filterGlobalToEndpointSubtree`).
function groupGlobalMethodCandidates(
  records: GlobalEndpointMethodRecord[],
  opts: { allowSql?: boolean; subtreeSpanIds?: Set<string> } = {},
): Map<string, MethodCandidate[]> {
  const out = new Map<string, MethodCandidate[]>();
  records.forEach((r, i) => {
    const key = `${r.endpoint_service_id}::${r.endpoint}`;
    const { score, keywords } = scoreMethodLike(
      r.class_name,
      r.method_name,
      r.span_name,
      opts,
    );
    const displayName = r.method_name
      ? `${r.class_name?.split(".").pop() ?? "?"}.${r.method_name}()`
      : r.span_name;
    const isCrossService = Boolean(
      r.service_id && r.endpoint_service_id && r.service_id !== r.endpoint_service_id,
    );
    const isSurrounding = Boolean(
      opts.subtreeSpanIds && r.span_id && !opts.subtreeSpanIds.has(r.span_id),
    );
    const candidate: MethodCandidate = {
      id: `gem-${i}`,
      span_name: r.span_name,
      class_name: r.class_name,
      method_name: r.method_name,
      span_kind: r.span_kind,
      displayName,
      calls: 1,
      score,
      keywords,
      confidence: getConfidence(score),
      example_span_id: r.span_id,
      example_trace_id: r.trace_id,
      is_cross_service: isCrossService,
      is_surrounding: isSurrounding,
      owning_service_id: r.service_id,
    };
    const list = out.get(key) ?? [];
    list.push(candidate);
    out.set(key, list);
  });
  // Same dedup-by-displayName policy as `groupMethodCandidates` — see
  // its comment for the rationale. Server+internal variants of the same
  // method collapse to one row, span_kind biased to `server`.
  for (const [key, list] of out) {
    const byKey = new Map<string, MethodCandidate>();
    for (const c of list) {
      const dKey = c.displayName;
      const existing = byKey.get(dKey);
      if (!existing) {
        byKey.set(dKey, c);
        continue;
      }
      const mergedKeywords = Array.from(new Set([...existing.keywords, ...c.keywords]));
      const cIsServer = (c.span_kind ?? "").toLowerCase() === "server";
      const eIsServer = (existing.span_kind ?? "").toLowerCase() === "server";
      const winner =
        c.score > existing.score
          ? c
          : existing.score > c.score
            ? existing
            : cIsServer && !eIsServer
              ? c
              : existing;
      const loser = winner === c ? existing : c;
      byKey.set(dKey, {
        ...winner,
        calls: existing.calls + c.calls,
        keywords: mergedKeywords,
        confidence: getConfidence(winner.score),
        class_name: winner.class_name ?? loser.class_name,
        method_name: winner.method_name ?? loser.method_name,
        span_kind:
          cIsServer || eIsServer ? "server" : winner.span_kind ?? loser.span_kind,
        example_span_id: winner.example_span_id ?? loser.example_span_id,
        example_trace_id: winner.example_trace_id ?? loser.example_trace_id,
        is_surrounding: existing.is_surrounding && c.is_surrounding,
        is_cross_service: existing.is_cross_service || c.is_cross_service,
      });
    }
    const deduped = Array.from(byKey.values()).sort(
      (a, b) => b.score - a.score || b.calls - a.calls,
    );
    out.set(key, deduped);
  }
  return out;
}

// ─── Trace waterfall: parse + tree-ify ────────────────────────────────────────

// One row in the rendered waterfall. `depth` lets us indent without recursing
// during render, `business.score` colours the row so business-relevant spans
// pop visually.
interface WaterfallNode {
  spanId: string;
  parentId: string | null;
  depth: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  span: Record<string, any>;
  className: string | null;
  methodName: string | null;
  spanName: string;
  spanKind: string | null;
  endpointName: string | null;
  durationNs: number;
  startTimeNs: number;
  statusCode: number | null;
  business: { score: number; keywords: string[]; categories: string[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeWaterfallSpan(
  r: Record<string, any>,
  opts: { allowSql?: boolean } = {},
): WaterfallNode | null {
  const id = spanIdToHex(r["span.id"]);
  if (!id) return null;
  const parent = spanIdToHex(r["span.parent_id"]);
  const className = r["code.namespace"] ? String(r["code.namespace"]) : null;
  const methodName = r["code.function"] ? String(r["code.function"]) : null;
  const spanName = r["span.name"] ? String(r["span.name"]) : "(unnamed)";
  const score = scoreMethodLike(className, methodName, spanName, opts);
  // duration / start_time may come back as bigint (long) — coerce.
  const dur = toNum(r["duration"]);
  const start = toNum(r["start_time"]);
  // span.kind in OneAgent is typically lowercase already; normalise.
  const kind = r["span.kind"] ? String(r["span.kind"]).toLowerCase() : null;
  const status = r["http.response.status_code"] ?? r["http.status_code"];
  const statusNum = status === null || status === undefined ? null : toNum(status) || null;
  return {
    spanId: id,
    parentId: parent,
    depth: 0,
    span: r,
    className,
    methodName,
    spanName,
    spanKind: kind,
    endpointName: r["endpoint.name"] ? String(r["endpoint.name"]) : null,
    durationNs: dur,
    startTimeNs: start,
    statusCode: statusNum,
    business: score,
  };
}

// Build a parent/child tree of waterfall rows from a flat span list, then
// flatten back out in DFS order with `depth` set. The flat output is what
// the UI iterates over — each row knows its indent level so render is a
// simple `.map`, not a recursive component.
function buildWaterfallRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  records: Array<Record<string, any>>,
  opts: { allowSql?: boolean } = {},
): WaterfallNode[] {
  const nodes = records
    .map((r) => normalizeWaterfallSpan(r, opts))
    .filter((n): n is WaterfallNode => n !== null);
  const byId = new Map<string, WaterfallNode>();
  for (const n of nodes) byId.set(n.spanId, n);

  // ─── RA-shadow collapse ────────────────────────────────────────────
  // When OneAgent instruments a method that's already a span entry-point
  // (server kind), the resulting trace carries TWO spans for the same
  // method: the original server span and a child `internal` span emitted
  // by the bytecode instrumentation. The internal child carries any
  // Request Attribute / bizevent values OneAgent extracts; the server
  // span is the request entry. Showing both in the waterfall (and in the
  // methods candidate list) is pure noise — they represent the same
  // call. We collapse the internal "shadow" into its server parent:
  //   1. Mark the shadow span hidden so it doesn't render.
  //   2. Re-parent the shadow's children to its server parent (so e.g.
  //      `OutInAxisOperationClient.send` still appears under the
  //      server span instead of disappearing with its shadow parent).
  //   3. LIFT every span-level capture attribute from the shadow onto
  //      the server parent's raw span record, so when the user clicks
  //      the server span the SpanDetailPanel sees the captured values
  //      that the RA actually persisted on the (now hidden) internal
  //      child. Existing values on the parent are preserved.
  const shadowIds = new Set<string>();
  for (const n of nodes) {
    if (n.spanKind !== "internal") continue;
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    if (!parent || parent.spanKind !== "server") continue;
    if (!n.className || !n.methodName) continue;
    if (
      parent.className !== n.className ||
      parent.methodName !== n.methodName
    ) {
      continue;
    }
    shadowIds.add(n.spanId);
    // Re-parent the shadow's parent_id chain in the child map below by
    // pointing it at the shadow's parent for any subsequent lookup.
    for (const [k, v] of Object.entries(n.span)) {
      if (v === null || v === undefined || v === "") continue;
      const lower = k.toLowerCase();
      const isCapture =
        lower.startsWith("dt.request_attribute.") ||
        lower.startsWith("captured_attribute.") ||
        lower.startsWith("method.argument.");
      if (!isCapture) continue;
      // Only lift if the parent doesn't already have a value for the key
      // (don't clobber a value that OneAgent already promoted to the
      // server span).
      const existing = parent.span[k];
      if (existing === null || existing === undefined || existing === "") {
        parent.span[k] = v;
      }
    }
  }

  // Bucket children by parent id; parents that aren't present in this trace
  // (e.g. truncated parent in a cross-process trace) get treated as roots.
  // Shadow spans never appear as parents — their children are walked
  // through the shadow to the surviving server grandparent, AND their
  // own `parentId` is rewritten in-place so downstream consumers that
  // navigate the tree via `node.parentId` (e.g. the waterfall's
  // `subtreeIds` BFS that scopes the default view to the endpoint
  // root's subtree) still see them as descendants of the server span.
  // Without this rewrite, the children would be orphaned from the
  // server span's subtree and silently dropped from the default view.
  const childrenOf = new Map<string | null, WaterfallNode[]>();
  for (const n of nodes) {
    if (shadowIds.has(n.spanId)) continue;
    // Walk up through any chain of shadow parents to the first real one
    // — handles the (unusual) case of nested instrumentation.
    let effectiveParent: string | null =
      n.parentId && byId.has(n.parentId) ? n.parentId : null;
    while (effectiveParent && shadowIds.has(effectiveParent)) {
      const grandParent = byId.get(effectiveParent)?.parentId ?? null;
      effectiveParent =
        grandParent && byId.has(grandParent) ? grandParent : null;
    }
    // Rewrite the node's own parentId so subtree walks via `parentId`
    // (e.g. the waterfall's endpoint-root BFS) keep finding this node.
    if (effectiveParent !== n.parentId) {
      n.parentId = effectiveParent;
    }
    const arr = childrenOf.get(effectiveParent) ?? [];
    arr.push(n);
    childrenOf.set(effectiveParent, arr);
  }
  // Sort each bucket by start_time so the waterfall reads top-to-bottom in
  // execution order.
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.startTimeNs - b.startTimeNs);
  }

  const out: WaterfallNode[] = [];
  const walk = (id: string | null, depth: number) => {
    const kids = childrenOf.get(id) ?? [];
    for (const k of kids) {
      k.depth = depth;
      out.push(k);
      walk(k.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Format a nanosecond duration as a short human string.
function formatDurationNs(ns: number): string {
  if (!ns || ns <= 0) return "—";
  const ms = ns / 1_000_000;
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function scoreEndpoints(endpoints: EndpointRecord[]): ScoredItem[] {
  return endpoints
    .map((ep, i): ScoredItem => {
      // Treat the route as a "method-like" identifier so endpoint scoring
      // gets the same Client suppression + get*ById medium-boost as the
      // methods table and trace waterfall — otherwise a SOAP/JAX-WS
      // operation called `getJourneyById` would stay stuck at ☆low.
      const { score, keywords } = scoreMethodLike(null, ep.route, ep.http_method ?? null);
      return {
        id: `ep-${i}`,
        displayName: ep.route,
        type: "endpoint",
        calls: ep.calls,
        score,
        keywords,
        confidence: getConfidence(score),
        suggestions: generateEndpointSuggestions(ep.route, ep.http_method),
        raw: ep,
      };
    })
    .sort((a, b) => b.score - a.score || b.calls - a.calls);
}

function scoreMethods(methods: MethodRecord[]): ScoredItem[] {
  return methods
    .map((m, i): ScoredItem => {
      const className = m.class_name ?? "";
      const methodName = m.method_name ?? "";
      const spanName = m.span_name ?? "";
      const { score, keywords } = scoreMethodLike(className, methodName, spanName);

      return {
        id: `m-${i}`,
        displayName: methodName
          ? `${className.split(".").pop() || "?"}.${methodName}()`
          : spanName || "unknown",
        type: "method",
        calls: m.calls,
        score,
        keywords,
        confidence: getConfidence(score),
        suggestions: generateMethodSuggestions(m.class_name, m.method_name),
        raw: m,
      };
    })
    .sort((a, b) => b.score - a.score || b.calls - a.calls);
}

// ─── Chip helpers ─────────────────────────────────────────────────────────────

const CHIP_COLORS: Record<string, string> = {
  financial: "#18a558",
  identity: "#3b82f6",
  transaction: "#f59e0b",
  reference: "#8b5cf6",
  product: "#06b6d4",
};

function KeywordChips({ keywords, categories }: { keywords: string[]; categories?: string[] }) {
  // Suppress redundant substring matches: if both "username" and "user"
  // are present, drop the shorter one so the chip strip isn't noisy. We
  // case-insensitively check whether each keyword is a substring of any
  // OTHER (longer) keyword in the same list.
  const deduped = (() => {
    const lower = keywords.map((k) => k.toLowerCase());
    return keywords.filter((kw, i) => {
      const lkw = lower[i];
      return !lower.some((other, j) => j !== i && other.length > lkw.length && other.includes(lkw));
    });
  })();
  return (
    <Flex gap={4} flexWrap="wrap">
      {deduped.slice(0, 6).map((kw) => {
        const cat = findKeywordCategory(kw);
        return (
          <Chip key={kw} color={cat?.color ?? "neutral"}>
            {kw}
          </Chip>
        );
      })}
      {deduped.length > 6 && (
        <Chip color="neutral">+{deduped.length - 6}</Chip>
      )}
    </Flex>
  );
}

// Inline keyword highlighter — wraps each matched keyword inside `text` in a
// soft purple <span> so business-relevant portions of an endpoint name pop out
// at a glance (e.g. `/api/orders/create` → highlights `orders` and `create`).
function HighlightedText({ text, keywords }: { text: string; keywords: string[] }) {
  if (!text) return null;
  if (!keywords || keywords.length === 0) return <>{text}</>;
  // Longest-first so a more specific match wins over a shorter overlapping one.
  const sorted = [...new Set(keywords)].sort((a, b) => b.length - a.length).filter(Boolean);
  if (sorted.length === 0) return <>{text}</>;
  const escaped = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            style={{
              background: Colors.Background.Container.Primary.Default,
              color: Colors.Text.Primary.Default,
              padding: "0 4px",
              borderRadius: 3,
              fontWeight: 700,
            }}
          >
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

// ─── Config Panel ─────────────────────────────────────────────────────────────

function ConfigPanel({ item }: { item: ScoredItem }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  if (item.suggestions.length === 0) {
    return (
      <Flex padding={16} flexDirection="column" gap={8}>
        <Text>No automated suggestions available for this item.</Text>
        <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
          This {item.type === "endpoint" ? "endpoint" : "method"} was detected based on keyword matching.
          Review it manually to determine if it carries business-relevant data.
        </Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={12} padding={16}>
      <Flex gap={8} alignItems="center">
        <Strong>Suggested Request Attributes</Strong>
        <Chip color="neutral">{item.suggestions.length} candidates</Chip>
      </Flex>
      <Accordion multiple defaultExpanded={[0]}>
        {item.suggestions.map((s, idx) => (
          <Accordion.Section key={idx} id={idx} color={s.confidence === "high" ? "success" : s.confidence === "medium" ? "warning" : "neutral"}>
            <Accordion.SectionLabel>
              <Flex gap={12} alignItems="center">
                <Text>{s.name}</Text>
                <Chip color={s.confidence === "high" ? "success" : s.confidence === "medium" ? "warning" : "neutral"}>
                  {s.confidence} confidence
                </Chip>
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>{s.dataSource}</Text>
              </Flex>
            </Accordion.SectionLabel>
            <Accordion.SectionContent>
              <Flex flexDirection="column" gap={8}>
                <Surface>
                  <Flex padding={12} flexDirection="column" gap={8}>
                    <pre
                      style={{
                        fontFamily: "monospace",
                        fontSize: "13px",
                        whiteSpace: "pre-wrap",
                        margin: 0,
                        lineHeight: 1.6,
                        color: Colors.Text.Primary.Default,
                      }}
                    >
                      {s.instruction}
                    </pre>
                    <Flex justifyContent="flex-end">
                      <Button
                        variant="default"
                        onClick={() => copyToClipboard(s.instruction, `${idx}-${s.name}`)}
                      >
                        {copied === `${idx}-${s.name}` ? "✓ Copied!" : "Copy instructions"}
                      </Button>
                    </Flex>
                  </Flex>
                </Surface>
              </Flex>
            </Accordion.SectionContent>
          </Accordion.Section>
        ))}
      </Accordion>
    </Flex>
  );
}

// ─── Collect Parameters Sheet ─────────────────────────────────────────────────

type CollectPhase = "creating" | "listening" | "error";

type ParamSource = "RequestBody" | "ResponseBody" | "QueryParameter" | "RequestHeader";
type ParamValueType = "string" | "number" | "boolean";

interface ExtractedParam {
  source: ParamSource;
  path: string;
  sampleValue: string;
  sampleValues: string[];
  type: ParamValueType;
  occurrences: number;
  score: number;
  keywords: string[];
}

// Per-bizevent-field top-level name (case-insensitive) → logical source
const SOURCE_FOR_FIELD: Record<string, ParamSource> = {
  allrequest: "RequestBody",
  allresponse: "ResponseBody",
  allqueryparameters: "QueryParameter",
  allrequestheaders: "RequestHeader",
};

// Try to coerce a captured payload (usually a string JSON blob or a query string)
// into a JS value we can introspect.
function parseCapturedValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // JSON object / array
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // Dynatrace `request.parameters` (AllQueryParameters) captures are rendered
  // as one `Key: value` per line, e.g. `ReturnUrl: /Journey\nfoo: bar`. Treat
  // these as objects so each query parameter becomes its own row.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (
    lines.length > 0 &&
    lines.every((l) => /^[A-Za-z0-9_.\-]+\s*:\s/.test(l))
  ) {
    const obj: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const k = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      if (k) obj[k] = v;
    }
    if (Object.keys(obj).length > 0) return obj;
  }
  // Query-string style (foo=bar&baz=qux or ?foo=bar)
  if (/^\??[A-Za-z0-9_.\-]+=/.test(trimmed)) {
    const q = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
    const obj: Record<string, string> = {};
    for (const pair of q.split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      try {
        // Preserve raw parameter keys exactly as captured in the body/query string.
        // This keeps encoded field names such as iceform%3AcreditCardType intact.
        const k = pair.slice(0, eq);
        const v = decodeURIComponent(pair.slice(eq + 1));
        obj[k] = v;
      } catch { /* skip malformed pair */ }
    }
    if (Object.keys(obj).length > 0) return obj;
  }
  return trimmed;
}

// Flatten a JS value (object/array/primitive) into leaf entries keyed by
// dot-notation path. Caps recursion to keep huge payloads tractable.
function flattenLeaves(
  value: unknown,
  prefix: string,
  out: Array<{ path: string; value: unknown }>,
  limit = 200,
  depth = 0,
): void {
  if (out.length >= limit || depth > 8) return;
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    out.push({ path: prefix || "(value)", value });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    // Use only the first element to represent shape (avoid combinatorial blowup).
    const arrPrefix = prefix ? `${prefix}[*]` : "[*]";
    flattenLeaves(value[0], arrPrefix, out, limit, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= limit) return;
    const next = prefix ? `${prefix}.${k}` : k;
    flattenLeaves(v, next, out, limit, depth + 1);
  }
}

// Generate a safe field name for a per-parameter capture rule from a JSON path.
// IMPORTANT: array markers ([*]) are preserved as `_arr` so `items[*].id` and
// `items.id` produce different field names and don't collide in the dedupe check.
function sanitizeFieldName(path: string): string {
  return (
    path
      .replace(/\[\*\]/g, "_arr")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "value"
  );
}

// Short, stable prefix per source so the same field name from request vs response
// vs query string don't dedupe against each other.
function sourcePrefix(s: ParamSource): string {
  return s === "RequestBody"
    ? "req"
    : s === "ResponseBody"
    ? "res"
    : s === "RequestHeader"
    ? "hdr"
    : "qry";
}

// Deterministic data-field name for a per-parameter capture inside the parent
// rule. Prefixed with the source so `RequestBody:user.id` and
// `ResponseBody:user.id` produce distinct field names (and so we can detect
// already-added params on reopen).
function perParamFieldName(source: ParamSource, path: string): string {
  return `${sourcePrefix(source)}_${sanitizeFieldName(path)}`.slice(0, 60);
}

// Template bundle captured during createRule() so the per-param "Add Biz Event"
// button can clone the exact shape Dynatrace expects in this env.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RuleTemplateBundle = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseRule: Record<string, any>;          // ruleValue with event.data emptied
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestField: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseField: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryField: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headerField: Record<string, any> | null;
};

export function CollectParamsSheet({
  serviceName,
  route,
  httpMethod,
  show,
  onClose,
}: {
  serviceName: string;
  route: string;
  httpMethod: string | null;
  show: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<CollectPhase>("creating");
  const [errorMsg, setErrorMsg] = useState("");
  const [ruleObjectId, setRuleObjectId] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [bizeventQuery, setBizeventQuery] = useState("fetch bizevents | limit 0");

  const { data: bizeventData, isLoading: bizeventLoading, refetch } = useDql({ query: bizeventQuery });

  const [discoveredSchemaId, setDiscoveredSchemaId] = useState<string | null>(null);
  const [triggerPath, setTriggerPath] = useState<string>(route);

  // Saved during createRule so the per-parameter "Add Biz Event" button can clone
  // the same shape (triggers + provider + a typed data-field template).
  const [ruleTemplate, setRuleTemplate] = useState<RuleTemplateBundle | null>(null);

  // Per-parameter creation status. Key is `${source}:${path}`.
  // Values: "creating" | "created" | error-message-string
  const [paramStatus, setParamStatus] = useState<Record<string, string>>({});

  // Existing capture rules in this env — fetched during createRule for the
  // template lookup, but not held in component state anymore. The single
  // source of truth for per-parameter dedupe is `parentRuleFields` below.

  // The parent rule's current `event.data` array — single source of truth for
  // which per-parameter fields have already been appended into THIS rule. We
  // refresh this after every PUT so `isCovered` and the Stop & Delete logic
  // see the latest state without an extra GET.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [parentRuleFields, setParentRuleFields] = useState<Array<Record<string, any>>>([]);

  // Per-row sample-value navigation index. Key is `${source}:${path}`.
  const [sampleIdx, setSampleIdx] = useState<Record<string, number>>({});

  // Source filters — default all enabled.
  const [sourceFilter, setSourceFilter] = useState<Set<ParamSource>>(
    () => new Set<ParamSource>(["RequestBody", "ResponseBody", "QueryParameter", "RequestHeader"]),
  );

  // When true, the parameters table is restricted to rows whose keyword
  // score > 0 (i.e. business candidates only). Default off so the user sees
  // everything that was captured.
  const [businessOnly, setBusinessOnly] = useState(false);

  const createRule = useCallback(async () => {
    setPhase("creating");
    setErrorMsg("");
    try {
      const SCHEMA_ID = "builtin:bizevents.http.incoming";
      setDiscoveredSchemaId(SCHEMA_ID);

      // Compute the trigger path early so we can use it to look up any existing
      // parent rule for this endpoint and avoid duplicating.
      const rawRoute = route.trim();
      const pathOnly = rawRoute.replace(/^[A-Z]+\s+/, ""); // drop "GET ", "POST " etc. prefix if present
      const triggerPath = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
      const eventType = `dt-business-discovery.${triggerPath}`;

      // Fetch all rules in this env once, with objectId so we can reuse them.
      const allRulesResp = await settingsObjectsClient.getSettingsObjects({
        schemaIds: SCHEMA_ID,
        fields: "objectId,schemaId,value",
      });
      const allRules = allRulesResp.items ?? [];

      // Look for an existing parent rule for this endpoint, matched purely by
      // the deterministic event.type. We do NOT require AllRequest /
      // AllResponse to be present — a previous "Stop & Delete" may have
      // stripped the wildcard collectors while leaving user-added per-param
      // fields behind. In that case we want to reuse this rule and re-inject
      // the wildcards so the next listening session captures everything again.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchingParent = allRules.find((item) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = item.value as Record<string, any> | undefined;
        return !!v && v.event?.type?.source === eventType;
      });

      if (matchingParent) {
        // Reuse the existing parent rule — no duplicate creation.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = matchingParent.value as Record<string, any>;
        v.event = v.event ?? {};
        if (!Array.isArray(v.event.data)) v.event.data = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = v.event.data as any[];

        // Self-heal: older rules created by this app (or a previous broken
        // version) may have an AllQueryParameters field whose source still
        // points at "request.body". If we detect that, rewrite the field to
        // the canonical query-string enum before reusing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const qField = data.find((d: any) => String(d?.name ?? "").toLowerCase() === "allqueryparameters");
        const isMisrouted = (() => {
          if (!qField) return false;
          const probe = JSON.stringify({
            a: qField.dataSource,
            b: qField.sourceType,
            c: qField.source?.dataSource,
            d: qField.source?.sourceType,
          }).toLowerCase();
          if (/body|header|cookie|response|method|status|querystring/.test(probe)) return true;
          return !/request\.parameters/.test(probe);
        })();

        let dirty = false;
        if (isMisrouted && qField) {
          const FIX_ENUM = "request.parameters";
          if ("dataSource" in qField) qField.dataSource = FIX_ENUM;
          if ("sourceType" in qField) qField.sourceType = FIX_ENUM;
          if (qField.source && typeof qField.source === "object") {
            if ("dataSource" in qField.source) qField.source.dataSource = FIX_ENUM;
            if ("sourceType" in qField.source) qField.source.sourceType = FIX_ENUM;
            if ("path" in qField.source) qField.source.path = "*";
          }
          if ("path" in qField) qField.path = "*";
          dirty = true;
        }

        // Re-inject any missing wildcard collectors so the listening session
        // sees AllRequest / AllResponse / AllQueryParameters bizevents again.
        // We source the templates from other rules in the env when available.
        const presentNames = new Set(data.map((d) => String(d?.name ?? "").toLowerCase()));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const findInAnyRule = (predicate: (d: any) => boolean) => {
          for (const item of allRules) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rv = item.value as Record<string, any> | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const arr = (rv?.event?.data as any[] | undefined) ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hit = arr.find(predicate);
            if (hit) return hit;
          }
          return null;
        };

        // Body wildcards — clone any AllRequest/AllResponse field from any rule,
        // or fall back to the minimal schema-valid shape if none exists.
        if (!presentNames.has("allrequest")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tmpl = findInAnyRule((d: any) => String(d?.name ?? "").toLowerCase() === "allrequest");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const clone: any = tmpl
            ? JSON.parse(JSON.stringify(tmpl))
            : { name: "AllRequest", source: { sourceType: "request.body", path: "*" } };
          clone.name = "AllRequest";
          if (clone.source && typeof clone.source === "object" && "path" in clone.source) clone.source.path = "*";
          if ("path" in clone) clone.path = "*";
          data.push(clone);
          dirty = true;
        }
        if (!presentNames.has("allresponse")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tmpl = findInAnyRule((d: any) => String(d?.name ?? "").toLowerCase() === "allresponse");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const clone: any = tmpl
            ? JSON.parse(JSON.stringify(tmpl))
            : { name: "AllResponse", source: { sourceType: "response.body", path: "*" } };
          clone.name = "AllResponse";
          if (clone.source && typeof clone.source === "object" && "path" in clone.source) clone.source.path = "*";
          if ("path" in clone) clone.path = "*";
          data.push(clone);
          dirty = true;
        }
        if (!presentNames.has("allqueryparameters")) {
          // Prefer a real query-string field from any env rule.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tmpl = findInAnyRule((d: any) => {
            const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
            return srcType === "request.parameters";
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let clone: any;
          if (tmpl) {
            clone = JSON.parse(JSON.stringify(tmpl));
            clone.name = "AllQueryParameters";
            if (clone.source && typeof clone.source === "object" && "path" in clone.source) clone.source.path = "*";
            if ("path" in clone) clone.path = "*";
          } else {
            // Synthesize from the AllRequest skeleton we may have just added.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const skel = data.find((d: any) => String(d?.name ?? "").toLowerCase() === "allrequest");
            const QENUM = "request.parameters";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            clone = { name: "AllQueryParameters" };
            if (skel && typeof skel === "object") {
              if ("path" in skel) clone.path = "*";
              if ("dataSource" in skel) clone.dataSource = QENUM;
              if ("sourceType" in skel) clone.sourceType = QENUM;
              if (skel.source && typeof skel.source === "object") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const src: Record<string, any> = {};
                if ("sourceType" in skel.source) src.sourceType = QENUM;
                if ("dataSource" in skel.source) src.dataSource = QENUM;
                if ("path" in skel.source) src.path = "*";
                clone.source = src;
              }
              if (!("source" in clone) && !("dataSource" in clone) && !("sourceType" in clone)) {
                clone.source = { sourceType: QENUM, path: "*" };
              }
            } else {
              clone.source = { sourceType: QENUM, path: "*" };
            }
          }
          data.push(clone);
          dirty = true;
        }
        // Header wildcard — same pattern as AllQueryParameters but for
        // `request.headers`. Looked at the EasyTrade-QuickSell rule for the
        // exact shape (a single field with source.sourceType === "request.headers"
        // and path "*"). Falls back to mirroring AllRequest's structural keys
        // when no header field exists anywhere in the env.
        if (!presentNames.has("allrequestheaders")) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tmpl = findInAnyRule((d: any) => {
            const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
            return srcType === "request.headers";
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let clone: any;
          if (tmpl) {
            clone = JSON.parse(JSON.stringify(tmpl));
            clone.name = "AllRequestHeaders";
            if (clone.source && typeof clone.source === "object" && "path" in clone.source) clone.source.path = "*";
            if ("path" in clone) clone.path = "*";
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const skel = data.find((d: any) => String(d?.name ?? "").toLowerCase() === "allrequest");
            const HENUM = "request.headers";
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            clone = { name: "AllRequestHeaders" };
            if (skel && typeof skel === "object") {
              if ("path" in skel) clone.path = "*";
              if ("dataSource" in skel) clone.dataSource = HENUM;
              if ("sourceType" in skel) clone.sourceType = HENUM;
              if (skel.source && typeof skel.source === "object") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const src: Record<string, any> = {};
                if ("sourceType" in skel.source) src.sourceType = HENUM;
                if ("dataSource" in skel.source) src.dataSource = HENUM;
                if ("path" in skel.source) src.path = "*";
                clone.source = src;
              }
              if (!("source" in clone) && !("dataSource" in clone) && !("sourceType" in clone)) {
                clone.source = { sourceType: HENUM, path: "*" };
              }
            } else {
              clone.source = { sourceType: HENUM, path: "*" };
            }
          }
          data.push(clone);
          dirty = true;
        }

        if (dirty && matchingParent.objectId) {
          try {
            await settingsObjectsClient.putSettingsObjectByObjectId({
              objectId: matchingParent.objectId,
              body: { value: v },
            });
            // eslint-disable-next-line no-console
            console.debug(
              "[Discovery] reused parent rule",
              matchingParent.objectId,
              "(re-injected/healed wildcards; data now =",
              data.map((d) => d?.name),
              ")",
            );
          } catch (healErr) {
            // eslint-disable-next-line no-console
            console.warn("[Discovery] failed to PUT reused rule:", healErr);
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const findField = (n: string) =>
          data.find((d) => String(d?.name ?? "").toLowerCase() === n) ?? null;
        const baseRule = JSON.parse(JSON.stringify(v));
        if (baseRule.event && Array.isArray(baseRule.event.data)) baseRule.event.data = [];
        setRuleTemplate({
          baseRule,
          requestField:  findField("allrequest")        ? JSON.parse(JSON.stringify(findField("allrequest")))        : null,
          responseField: findField("allresponse")       ? JSON.parse(JSON.stringify(findField("allresponse")))       : null,
          queryField:    findField("allqueryparameters")? JSON.parse(JSON.stringify(findField("allqueryparameters"))): null,
          headerField:   findField("allrequestheaders") ? JSON.parse(JSON.stringify(findField("allrequestheaders"))) : null,
        });
        setRuleObjectId(matchingParent.objectId ?? null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setParentRuleFields([...data]);
        setTriggerPath(triggerPath);
        const safeType = eventType.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        setBizeventQuery(
          `fetch bizevents, from:now()-5m\n| filter event.provider == "dt-business-discovery"\n| filter event.type == "${safeType}"\n| sort timestamp desc\n| limit 200`,
        );
        setLastRefresh(new Date());
        setPhase("listening");
        // eslint-disable-next-line no-console
        console.debug(
          "[Discovery] reusing existing parent rule",
          matchingParent.objectId,
          "for event.type", eventType,
        );
        return;
      }

      const schemaDef = await settingsSchemasClient.getSchemaDefinition({ schemaId: SCHEMA_ID });
      // Discover query-related enum values from schema metadata so generated fields map to
      // "Query String Parameters" in the Dynatrace UI.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collectEnumStrings = (node: any, out: string[] = []): string[] => {
        if (!node || typeof node !== "object") return out;
        if (Array.isArray(node.enum)) {
          for (const v of node.enum) {
            if (typeof v === "string") out.push(v);
          }
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") collectEnumStrings(value, out);
        }
        return out;
      };
      const enumStrings = Array.from(new Set(collectEnumStrings(schemaDef)));
      // The OneAgent bizevent capture schema for `source.sourceType` is a
      // closed enum: `request.path | request.method | request.headers |
      // request.parameters | request.body | response.body | response.headers
      // | response.statusCode | constant.string`. The value that represents
      // "Request — Query String parameters" (as shown in the manual UI) is
      // `request.parameters`. There is no `request.querystring` enum — a
      // previous heuristic that guessed it produced 400 schema validation
      // failures. Prefer the schema-found value if present, otherwise fall
      // back to the known canonical value.
      const queryDataSourceValue =
        enumStrings.find((v) => v.toLowerCase() === "request.parameters") ??
        "request.parameters";
      const querySourceTypeValue = queryDataSourceValue;
      // eslint-disable-next-line no-console
      console.debug(
        "[Discovery] bizevent schema enumStrings:", enumStrings,
        "→ queryDataSourceValue:", queryDataSourceValue,
        "querySourceTypeValue:", querySourceTypeValue,
      );

      // Reuse the same list we already fetched as the structural template source.
      const existing = allRulesResp;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingValues = (existing.items ?? []).map((i) => i.value as Record<string, any> | undefined).filter(Boolean);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const templateValue = existing.items?.[0]?.value as Record<string, any> | undefined;

      // Reuse a known valid "Query String parameters" field shape from any existing rule.
      // The schema-correct source is `sourceType === "request.parameters"` —
      // we match on that first so existing rules like `EasyTrade-QuickSell`
      // (whose field is just named `Param` etc.) are recognised. We also keep
      // name-based heuristics as a safety net.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryTemplateField = existingValues
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((v) => (Array.isArray(v?.event?.data) ? (v.event.data as any[]) : []))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((d: any) => {
          const name = String(d?.name ?? "").toLowerCase();
          const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
          return (
            srcType === "request.parameters" ||
            name === "allqueryparameters" ||
            name.includes("query")
          );
        });
      // eslint-disable-next-line no-console
      console.debug("[Discovery] queryTemplateField from existing rules:", queryTemplateField);

      // Same template lookup but for `request.headers` — informed by the
      // `EasyTrade-QuickSell` rule which contains a header capture field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const headerTemplateField = existingValues
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((v) => (Array.isArray(v?.event?.data) ? (v.event.data as any[]) : []))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((d: any) => {
          const name = String(d?.name ?? "").toLowerCase();
          const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
          return (
            srcType === "request.headers" ||
            name === "allrequestheaders" ||
            name.includes("header")
          );
        });
      // eslint-disable-next-line no-console
      console.debug("[Discovery] headerTemplateField from existing rules:", headerTemplateField);

      // Same lookup for `request.body` and `response.body`. Without these,
      // when the picked templateValue happens to be a header-only rule (e.g.
      // EasyTrade-QuickSell), the per-source filter below would drop
      // AllRequest / AllResponse and never re-add them — so the resulting
      // capture would only see request headers. This was the cause of the
      // empty Request Body / Response Body / Query String columns in the
      // "Collect Parameters" sheet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestTemplateField = existingValues
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((v) => (Array.isArray(v?.event?.data) ? (v.event.data as any[]) : []))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((d: any) => {
          const name = String(d?.name ?? "").toLowerCase();
          const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
          return srcType === "request.body" || name === "allrequest";
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseTemplateField = existingValues
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((v) => (Array.isArray(v?.event?.data) ? (v.event.data as any[]) : []))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((d: any) => {
          const name = String(d?.name ?? "").toLowerCase();
          const srcType = String(d?.source?.sourceType ?? d?.sourceType ?? "").toLowerCase();
          return srcType === "response.body" || name === "allresponse";
        });
      // eslint-disable-next-line no-console
      console.debug(
        "[Discovery] body templates:",
        { requestTemplateField, responseTemplateField },
      );

      // Build ruleValue — either clone an existing rule's shape (preferred, avoids
      // schema surprises) or construct a minimal known-good skeleton from scratch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schemaDef2 = schemaDef as unknown as Record<string, any>;
      // Extract the first allowed value for event.category from the schema.
      // The field is required and non-null; for HTTP-incoming rules it is typically
      // "HTTP_REQUEST". We read it directly from the schema enum so we never hardcode
      // a value that might differ across environments.
      const categoryValue: string =
        schemaDef2?.properties?.event?.properties?.category?.enum?.[0] ??
        schemaDef2?.properties?.event?.items?.properties?.category?.enum?.[0] ??
        "HTTP_REQUEST";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ruleValue: Record<string, any> = templateValue
        ? JSON.parse(JSON.stringify(templateValue))
        : {
            enabled: true,
            ruleName: "",
            triggers: [],
            event: {
              category: { sourceType: "constant.string", source: categoryValue },
              provider: { sourceType: "constant.string", source: "dt-business-discovery" },
              type: { sourceType: "constant.string", source: "" },
              data: [],
            },
          };
      ruleValue.enabled  = true;
      ruleValue.ruleName = `${httpMethod ?? "ANY"} ${route} — ${serviceName}`;

      // triggerPath / eventType were computed at the top of createRule so the
      // dedupe lookup above could use them.

      // Triggers: flat array where each entry has source.dataSource, type, value, caseSensitive
      ruleValue.triggers = [
        {
          source: { dataSource: "request.path" },
          type: "CONTAINS",
          value: triggerPath,
          caseSensitive: false,
        },
        ...(httpMethod
          ? [{
              source: { dataSource: "request.method" },
              type: "EQUALS",
              value: httpMethod.toUpperCase(),
              caseSensitive: false,
            }]
          : []),
      ];

      // Event provider and type — identify events from this tool
      if (ruleValue.event?.provider) {
        ruleValue.event.provider.sourceType = "constant.string";
        ruleValue.event.provider.source     = "dt-business-discovery";
      }
      if (ruleValue.event?.type) {
        ruleValue.event.type.sourceType = "constant.string";
        ruleValue.event.type.source     = eventType;
      }

      // Data: rebuild deterministically so every new rule always carries all
      // four wildcard collectors — AllRequest, AllResponse, AllQueryParameters,
      // AllRequestHeaders — regardless of which existing rule happened to be
      // picked as the structural template.
      //
      // Previous behaviour FILTERED templateValue.event.data down to the four
      // wildcard names and then only synthesized the missing query/header
      // fields. If templateValue was a header-only rule (EasyTrade-QuickSell)
      // the new rule ended up with ONLY AllRequestHeaders and discovery
      // sessions showed "Request Body (0) / Response Body (0) / Query (0) /
      // Headers (N)" — that's the regression this block fixes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (ruleValue.event && typeof ruleValue.event === "object") {
        const headerSourceTypeValue =
          enumStrings.find((v) => v.toLowerCase() === "request.headers") ?? "request.headers";
        // The template rule may carry user-curated narrow fields (e.g.
        // `accountId`, `amount` from an EasyTrade rule). Those belong to
        // that endpoint, NOT the brand-new one we're minting — a fresh
        // Collect Parameters session should start with ONLY the four
        // wildcard collectors so the user picks up just what's flowing
        // through *this* endpoint.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const original: any[] = Array.isArray(ruleValue.event.data)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (ruleValue.event.data as any[])
          : [];
        const WILDCARD_NAMES = new Set([
          "allrequest",
          "allresponse",
          "allqueryparameters",
          "allrequestheaders",
        ]);

        // Use any wildcard field from the original template (or env-wide
        // body field as a fallback) as the structural skeleton — copies
        // ONLY the property names so the resulting field matches the
        // schema's nested shape (some envs use {source:{...}}, some flat).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anySkeleton: any =
          original.find((d) => WILDCARD_NAMES.has(String(d?.name ?? "").toLowerCase())) ??
          requestTemplateField ??
          responseTemplateField ??
          queryTemplateField ??
          headerTemplateField ??
          null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const buildWildcard = (
          name: string,
          sourceType: string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          templateField: any | null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ): any => {
          // 1. Clone an env-wide field of the same source if one exists —
          //    its shape is already known-good for the schema.
          if (templateField) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const clone: any = JSON.parse(JSON.stringify(templateField));
            clone.name = name;
            if (clone.source && typeof clone.source === "object" && "path" in clone.source) {
              clone.source.path = "*";
            }
            if ("path" in clone) clone.path = "*";
            return clone;
          }
          // 2. Mirror the structural keys of any available skeleton.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const out: Record<string, any> = { name };
          if (anySkeleton && typeof anySkeleton === "object") {
            if ("path" in anySkeleton) out.path = "*";
            if ("dataSource" in anySkeleton) out.dataSource = sourceType;
            if ("sourceType" in anySkeleton) out.sourceType = sourceType;
            if (anySkeleton.source && typeof anySkeleton.source === "object") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const src: Record<string, any> = {};
              if ("sourceType" in anySkeleton.source) src.sourceType = sourceType;
              if ("dataSource" in anySkeleton.source) src.dataSource = sourceType;
              if ("path" in anySkeleton.source) src.path = "*";
              out.source = src;
            }
          }
          // 3. Last-resort minimal known-good shape.
          if (!("source" in out) && !("dataSource" in out) && !("sourceType" in out)) {
            out.source = { sourceType, path: "*" };
          }
          return out;
        };

        // Prefer the field exactly as it lives on the template rule
        // (already known to pass schema), otherwise build from env+skeleton.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pickWildcard = (
          name: string,
          sourceType: string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          envTemplate: any | null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ): any => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const onTemplate = original.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (d: any) => String(d?.name ?? "").toLowerCase() === name.toLowerCase(),
          );
          if (onTemplate) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const c: any = JSON.parse(JSON.stringify(onTemplate));
            if (c.source && typeof c.source === "object" && "path" in c.source) c.source.path = "*";
            if ("path" in c) c.path = "*";
            return c;
          }
          return buildWildcard(name, sourceType, envTemplate);
        };

        ruleValue.event.data = [
          pickWildcard("AllRequest", "request.body", requestTemplateField),
          pickWildcard("AllResponse", "response.body", responseTemplateField),
          pickWildcard("AllQueryParameters", queryDataSourceValue, queryTemplateField),
          pickWildcard("AllRequestHeaders", headerSourceTypeValue, headerTemplateField),
        ];

        // eslint-disable-next-line no-console
        console.debug(
          "[Discovery] rebuilt event.data with 4 wildcards only:",
          ruleValue.event.data,
        );
      }

      // Capture a reusable bundle for the per-parameter "Add Biz Event" buttons:
      // a base rule shell (without event.data) plus a clean clone of each source's
      // template field so we can mint a new rule with a single targeted data field.
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eventData = (ruleValue.event?.data as any[] | undefined) ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const findField = (n: string) =>
          eventData.find((d) => String(d?.name ?? "").toLowerCase() === n) ?? null;
        const baseRule = JSON.parse(JSON.stringify(ruleValue));
        if (baseRule.event && Array.isArray(baseRule.event.data)) {
          baseRule.event.data = [];
        }
        setRuleTemplate({
          baseRule,
          requestField:  findField("allrequest")        ? JSON.parse(JSON.stringify(findField("allrequest")))        : null,
          responseField: findField("allresponse")       ? JSON.parse(JSON.stringify(findField("allresponse")))       : null,
          queryField:    findField("allqueryparameters")? JSON.parse(JSON.stringify(findField("allqueryparameters"))): null,
          headerField:   findField("allrequestheaders") ? JSON.parse(JSON.stringify(findField("allrequestheaders"))) : null,
        });
      }

      // (Cross-rule existingRules cache removed — dedupe is now driven by the
      // parent rule's own event.data via parentRuleFields.)

      // eslint-disable-next-line no-console
      console.debug(
        "[Discovery] final ruleValue being posted:",
        JSON.parse(JSON.stringify(ruleValue)),
      );

      const result = await settingsObjectsClient.postSettingsObjects({
        body: [{ schemaId: SCHEMA_ID, scope: "environment", value: ruleValue }],
      });
      setRuleObjectId(result[0]?.objectId ?? null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setParentRuleFields(Array.isArray(ruleValue.event?.data) ? (ruleValue.event.data as any[]) : []);
      setPhase("listening");
      // Query only events emitted by our capture rule
      const safeType = eventType.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      setBizeventQuery(
        `fetch bizevents, from:now()-5m\n| filter event.provider == "dt-business-discovery"\n| filter event.type == "${safeType}"\n| sort timestamp desc\n| limit 200`
      );
      setTriggerPath(triggerPath);
      setLastRefresh(new Date());
    } catch (e) {
      // Surface as much detail as possible from the server response. The
      // SDK error usually has a `body` or `response` with the validation
      // message; fall back to String(e) otherwise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyErr = e as any;
      let detail = "";
      try {
        detail =
          typeof anyErr?.body === "string" ? anyErr.body
          : anyErr?.body ? JSON.stringify(anyErr.body)
          : anyErr?.response?.data ? JSON.stringify(anyErr.response.data)
          : anyErr?.errorEnvelope ? JSON.stringify(anyErr.errorEnvelope)
          : "";
      } catch { /* ignore stringify errors */ }
      // eslint-disable-next-line no-console
      console.error("[Discovery] createRule failed:", anyErr, "detail:", detail);
      setErrorMsg(detail ? `${String(e)} — ${detail}` : String(e));
      setPhase("error");
    }
  }, [route, httpMethod]);

  // Create rule on open
  useEffect(() => {
    if (show) {
      void createRule();
    } else {
      setPhase("creating");
      setRuleObjectId(null);
      setBizeventQuery("fetch bizevents | limit 0");
      setLastRefresh(null);
      setRuleTemplate(null);
      setParamStatus({});
      setParentRuleFields([]);
      setSampleIdx({});
      setSourceFilter(new Set<ParamSource>(["RequestBody", "ResponseBody", "QueryParameter", "RequestHeader"]));
      setBusinessOnly(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  // Auto-refresh while listening. Constant 5s cadence so newly-captured
  // bizevents (especially request bodies, which OneAgent buffers and emits
  // slightly later than headers/responses) surface as quickly as possible.
  useEffect(() => {
    if (phase !== "listening") return;
    const timer = setInterval(() => {
      void refetch();
      setLastRefresh(new Date());
    }, 5000);
    return () => clearInterval(timer);
  }, [phase, refetch]);

  // Stop & Delete behavior:
  // - Strip ONLY the wildcard collector fields (those whose path / source.path
  //   is "*", i.e. AllRequest / AllResponse / AllQueryParameters).
  // - If any narrowly-targeted user-added fields remain, PUT the rule back
  //   with the wildcard fields removed (the rule keeps capturing the
  //   per-parameter fields the user explicitly added).
  // - If nothing remains, the rule has no useful purpose anymore — delete it.
  const deleteRuleAndClose = useCallback(async () => {
    if (!ruleObjectId) {
      onClose();
      return;
    }
    try {
      const current = await settingsObjectsClient.getSettingsObjectByObjectId({
        objectId: ruleObjectId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parentValue: Record<string, any> = JSON.parse(JSON.stringify(current.value ?? {}));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any[] = Array.isArray(parentValue.event?.data) ? parentValue.event.data : [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isWildcard = (d: any) => {
        const topPath = typeof d?.path === "string" ? d.path : "";
        const srcPath = typeof d?.source?.path === "string" ? d.source.path : "";
        // A wildcard collector has "*" in whichever path slot the schema uses.
        if (topPath === "*" || srcPath === "*") return true;
        // Defensive: also treat empty/missing paths combined with our known
        // wildcard names as wildcards.
        const n = String(d?.name ?? "").toLowerCase();
        if (!topPath && !srcPath && (n === "allrequest" || n === "allresponse" || n === "allqueryparameters" || n === "allrequestheaders")) {
          return true;
        }
        return false;
      };

      const kept = data.filter((d) => !isWildcard(d));

      if (kept.length === 0) {
        // Nothing user-added left — safe to delete the whole rule.
        await settingsObjectsClient
          .deleteSettingsObjectByObjectId({ objectId: ruleObjectId })
          .catch(() => null);
        // eslint-disable-next-line no-console
        console.debug("[Discovery] deleted rule entirely:", ruleObjectId);
      } else {
        parentValue.event = parentValue.event ?? {};
        parentValue.event.data = kept;
        await settingsObjectsClient.putSettingsObjectByObjectId({
          objectId: ruleObjectId,
          body: { value: parentValue },
        });
        // eslint-disable-next-line no-console
        console.debug(
          "[Discovery] stripped wildcard collectors from rule:",
          ruleObjectId,
          "kept",
          kept.map((d) => d?.name),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[Discovery] deleteRuleAndClose failed:", err);
    }
    onClose();
  }, [ruleObjectId, onClose]);

  // Parse bizevents → extracted leaf parameters from AllRequest / AllResponse /
  // AllQueryParameters. Each top-level field is JSON-parsed (with query-string
  // fallback), then flattened into dot-notation leaves. Leaves are aggregated by
  // (source, path) with sample values, observed JS type, and a business score
  // computed from the JSON path name.
  const params = useMemo((): ExtractedParam[] => {
    if (!bizeventData?.records?.length) return [];

    type Bucket = {
      source: ParamSource;
      path: string;
      values: string[];
      types: Set<string>;
      count: number;
    };
    const map = new Map<string, Bucket>();

    for (const record of bizeventData.records) {
      const rec = record as Record<string, unknown>;
      for (const [topKey, rawValue] of Object.entries(rec)) {
        const source = SOURCE_FOR_FIELD[topKey.toLowerCase()];
        if (!source) continue;
        const parsed = parseCapturedValue(rawValue);
        if (parsed === null || parsed === undefined) continue;

        const leaves: Array<{ path: string; value: unknown }> = [];
        if (typeof parsed !== "object") {
          leaves.push({ path: "(value)", value: parsed });
        } else {
          flattenLeaves(parsed, "", leaves);
        }

        for (const { path, value } of leaves) {
          if (value === null || value === undefined) continue;
          const key = `${source}:${path}`;
          let entry = map.get(key);
          if (!entry) {
            entry = { source, path, values: [], types: new Set(), count: 0 };
            map.set(key, entry);
          }
          entry.count++;
          entry.types.add(typeof value);
          if (entry.values.length < 10) {
            const strVal = String(value).slice(0, 120);
            if (!entry.values.includes(strVal)) entry.values.push(strVal);
          }
        }
      }
    }

    return Array.from(map.values())
      .map(({ source, path, values, types, count }): ExtractedParam => {
        // Score from the JSON path itself (e.g. "user.email" matches both
        // "user" and "email" keywords because scoreText normalises separators).
        const { score, keywords } = scoreText(path);
        const type: ParamValueType = types.has("number")
          ? "number"
          : types.has("boolean")
          ? "boolean"
          : "string";
        return {
          source,
          path,
          sampleValue: values[0] ?? "",
          sampleValues: values,
          type,
          occurrences: count,
          score,
          keywords,
        };
      })
      // Sort by score then occurrences, but push Request Header rows that
      // have NO business-keyword match (score === 0) to the bottom — those
      // are the noisy ones (User-Agent, Accept, Connection, …). Headers
      // that DO score (e.g. `X-Customer-Id`) compete normally with body /
      // query / response rows for the top positions.
      .sort((a, b) => {
        const aNoisy = a.source === "RequestHeader" && a.score === 0 ? 1 : 0;
        const bNoisy = b.source === "RequestHeader" && b.score === 0 ? 1 : 0;
        if (aNoisy !== bNoisy) return aNoisy - bNoisy;
        return b.score - a.score || b.occurrences - a.occurrences;
      });
  }, [bizeventData]);

  // Append a single per-parameter capture FIELD to the parent rule (instead of
  // creating a new settings object). We PUT the parent rule with the new field
  // pushed onto event.data, so all extracted parameters live inside one rule
  // and Stop & Delete can prune them selectively.
  const addBizEventForParam = useCallback(
    async (param: ExtractedParam) => {
      const statusKey = `${param.source}:${param.path}`;
      if (!ruleObjectId) {
        setParamStatus((s) => ({ ...s, [statusKey]: "No parent rule object id" }));
        return;
      }
      if (!ruleTemplate) {
        setParamStatus((s) => ({ ...s, [statusKey]: "No rule template available" }));
        return;
      }
      const { requestField, responseField, queryField, headerField } = ruleTemplate;
      const sourceField =
        param.source === "RequestBody"
          ? requestField
          : param.source === "ResponseBody"
          ? responseField
          : param.source === "RequestHeader"
          ? headerField
          : queryField;
      if (!sourceField) {
        setParamStatus((s) => ({ ...s, [statusKey]: `No template field for source ${param.source}` }));
        return;
      }

      setParamStatus((s) => ({ ...s, [statusKey]: "creating" }));
      try {
        // Fetch the latest value of the parent rule (other users may have
        // edited it; or we may be operating on stale state after several adds).
        const current = await settingsObjectsClient.getSettingsObjectByObjectId({
          objectId: ruleObjectId,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parentValue: Record<string, any> = JSON.parse(JSON.stringify(current.value ?? {}));
        parentValue.event = parentValue.event ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingData: any[] = Array.isArray(parentValue.event.data) ? parentValue.event.data : [];

        const fieldName = perParamFieldName(param.source, param.path);

        // Idempotency: if a field with this name is already in the parent
        // rule, treat as success without re-PUTting.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (existingData.some((d: any) => String(d?.name ?? "") === fieldName)) {
          setParentRuleFields(existingData);
          setParamStatus((s) => ({ ...s, [statusKey]: "created" }));
          return;
        }

        // Build the new field by cloning the matching wildcard template, then
        // narrowing its name + path. We use the path as-is (no `$.` prefix).
        const newField = JSON.parse(JSON.stringify(sourceField));
        newField.name = fieldName;
        if (typeof newField.path === "string") newField.path = param.path;
        if (newField.source && typeof newField.source === "object") {
          if (typeof newField.source.path === "string") newField.source.path = param.path;
        }

        const newData = [...existingData, newField];
        parentValue.event.data = newData;

        // eslint-disable-next-line no-console
        console.debug("[Discovery] addBizEventForParam PUT parent rule:", { ruleObjectId, fieldName, newField });

        await settingsObjectsClient.putSettingsObjectByObjectId({
          objectId: ruleObjectId,
          body: { value: parentValue },
        });

        setParentRuleFields(newData);
        setParamStatus((s) => ({ ...s, [statusKey]: "created" }));
      } catch (err) {
        // Try to surface the server-side reason if present.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anyErr = err as any;
        const detail =
          typeof anyErr?.body === "string" ? anyErr.body :
          anyErr?.body ? JSON.stringify(anyErr.body) :
          String(err);
        // eslint-disable-next-line no-console
        console.error("[Discovery] addBizEventForParam failed:", anyErr);
        setParamStatus((s) => ({ ...s, [statusKey]: detail.slice(0, 240) }));
      }
    },
    [ruleObjectId, ruleTemplate],
  );

  // Set of data-field names already present in the PARENT rule's event.data,
  // so we can mark a parameter as already added (avoiding a duplicate field).
  const parentFieldNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of parentRuleFields) {
      const n = typeof f?.name === "string" ? f.name : "";
      if (n) set.add(n);
    }
    return set;
  }, [parentRuleFields]);

  // Predicate: is this parameter already added as a dedicated field inside the
  // parent rule? Matches by the deterministic per-param field name, which
  // encodes (source, path-with-arrays) so RequestBody:user.id and
  // ResponseBody:user.id, and `items[*].id` vs `items.id`, stay distinct.
  const isCovered = useCallback(
    (p: ExtractedParam) => parentFieldNames.has(perParamFieldName(p.source, p.path)),
    [parentFieldNames],
  );

  // Apply source filter chips + the optional "business only" toggle.
  const filteredParams = useMemo(
    () => params.filter((p) => sourceFilter.has(p.source) && (!businessOnly || p.score > 0)),
    [params, sourceFilter, businessOnly],
  );

  const businessCandidateCount = useMemo(
    () => filteredParams.filter((p) => p.score > 0).length,
    [filteredParams],
  );

  const toggleSource = useCallback((s: ParamSource) => {
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const paramColumns = useMemo<DataTableColumnDef<ExtractedParam>[]>(
    () => [
      {
        id: "path",
        header: "Parameter",
        accessor: "path",
        cell: ({ value, rowData }: { value: string; rowData: ExtractedParam }) => (
          <Flex flexDirection="column" gap={2} style={{ minHeight: 44, justifyContent: "center" }}>
            <Strong style={{ fontFamily: "monospace", fontSize: "12px" }}>{value}</Strong>
            {rowData.keywords.length > 0 && <KeywordChips keywords={rowData.keywords} />}
          </Flex>
        ),
      },
      {
        id: "sampleValue",
        header: "Sample Value",
        accessor: "sampleValue",
        cell: ({ rowData }: { value: string; rowData: ExtractedParam }) => {
          const key = `${rowData.source}:${rowData.path}`;
          const samples = rowData.sampleValues.length > 0 ? rowData.sampleValues : [""];
          const idx = Math.min(sampleIdx[key] ?? 0, samples.length - 1);
          const current = samples[idx] || "—";
          const hasMultiple = samples.length > 1;
          const goPrev = () =>
            setSampleIdx((s) => ({ ...s, [key]: (idx - 1 + samples.length) % samples.length }));
          const goNext = () =>
            setSampleIdx((s) => ({ ...s, [key]: (idx + 1) % samples.length }));
          return (
            <Flex gap={6} alignItems="center" style={{ minWidth: 0, minHeight: 44 }}>
              {/* Navigation cluster: arrows + value + counter */}
              <Flex gap={4} alignItems="center" style={{ flex: 1, minWidth: 0 }}>
                {hasMultiple && (
                  <Button
                    variant="default"
                    onClick={goPrev}
                    aria-label="Previous sample"
                    style={{ padding: "0 4px", minWidth: 24 }}
                  >
                    ‹
                  </Button>
                )}
                <Text
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: Colors.Text.Neutral.Default,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                  title={current}
                >
                  {current}
                </Text>
                {hasMultiple && (
                  <>
                    <Text style={{ fontSize: "10px", color: Colors.Text.Neutral.Default }}>
                      {idx + 1}/{samples.length}
                    </Text>
                    <Button
                      variant="default"
                      onClick={goNext}
                      aria-label="Next sample"
                      style={{ padding: "0 4px", minWidth: 24 }}
                    >
                      ›
                    </Button>
                  </>
                )}
              </Flex>
              {/* Type chip sits outside the navigation cluster */}
              <Chip color="neutral">{rowData.type}</Chip>
            </Flex>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessor: "source",
        width: 160,
        cell: ({ value }: { value: ParamSource }) => {
          const color: "primary" | "warning" | "success" | "neutral" =
            value === "RequestBody"
              ? "primary"
              : value === "ResponseBody"
              ? "warning"
              : value === "RequestHeader"
              ? "neutral"
              : "success";
          const label =
            value === "RequestBody"
              ? "Request Body"
              : value === "ResponseBody"
              ? "Response Body"
              : value === "RequestHeader"
              ? "Request Header"
              : "Query String";
          return <Chip color={color}>{label}</Chip>;
        },
      },
      {
        id: "occurrences",
        header: "Seen",
        accessor: "occurrences",
        width: 80,
        cell: ({ value }: { value: number }) => <Text>{value}×</Text>,
      },
      {
        id: "score",
        header: "Business",
        accessor: "score",
        width: 110,
        cell: ({ value }: { value: number }) => (
          <Chip color={value >= 3 ? "success" : value >= 1 ? "warning" : "neutral"}>
            {value >= 3 ? "★★★ High" : value >= 1 ? "★★☆ Mid" : "★☆☆"}
          </Chip>
        ),
      },
      {
        id: "add",
        header: "",
        accessor: "path",
        width: 200,
        cell: ({ rowData }: { value: string; rowData: ExtractedParam }) => {
          const key = `${rowData.source}:${rowData.path}`;
          const status = paramStatus[key];
          // Already-covered takes precedence to dedupe duplicate rule creation.
          if (status === "created" || isCovered(rowData)) {
            const createdFieldName = perParamFieldName(rowData.source, rowData.path);
            return (
              <Flex flexDirection="column" gap={4}>
                <Chip color="success">✓ Rule exists</Chip>
                <Text
                  style={{
                    color: Colors.Text.Neutral.Default,
                    fontSize: "11px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                  title={createdFieldName}
                >
                  {createdFieldName}
                </Text>
              </Flex>
            );
          }
          if (status === "creating") {
            return <Button variant="default" disabled>Creating…</Button>;
          }
          if (status) {
            // Error path — show retry button + truncated message
            return (
              <Flex flexDirection="column" gap={2}>
                <Button variant="default" onClick={() => void addBizEventForParam(rowData)}>
                  Retry
                </Button>
                <Text style={{ color: Colors.Text.Critical.Default, fontSize: "10px" }}>
                  {status}
                </Text>
              </Flex>
            );
          }
          return (
            <Button variant="accent" onClick={() => void addBizEventForParam(rowData)}>
              + Add Biz Event
            </Button>
          );
        },
      },
    ],
    [paramStatus, addBizEventForParam, sampleIdx, isCovered],
  );

  return (
    <Sheet
      show={show}
      title={`Collect Parameters — ${httpMethod ?? "ANY"} ${route}`}
      onDismiss={onClose}
      actions={
        <Flex gap={8}>
          {phase === "listening" && ruleObjectId && (
            <Button color="critical" variant="emphasized" onClick={() => void deleteRuleAndClose()}>
              Stop & Delete Rule
            </Button>
          )}
          <Button variant="emphasized" onClick={onClose}>Close</Button>
        </Flex>
      }
    >
      <Flex flexDirection="column" gap={16} padding={16}>
        {/* Status bar */}
        <Flex gap={12} alignItems="center">
          {phase === "creating" && (
            <>
              <Chip color="warning">⏳ Creating capture rule…</Chip>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                {discoveredSchemaId
                  ? <>Using schema <Strong>{discoveredSchemaId}</Strong> — adding <Strong>*</Strong> wildcard for {route}</>
                  : <>Discovering schema ID, then adding <Strong>*</Strong> wildcard rule for {route}</>}
              </Text>
            </>
          )}
          {phase === "listening" && (
            <>
              <Chip color="success">● Live — capturing all parameters</Chip>
              {lastRefresh && (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  Last updated {lastRefresh.toLocaleTimeString()} · auto-refreshes every 5s
                </Text>
              )}
            </>
          )}
          {phase === "error" && (
            <Flex flexDirection="column" gap={4}>
              <Chip color="critical">✕ Rule creation failed</Chip>
              <Text style={{ color: Colors.Text.Critical.Default, fontSize: "12px" }}>{errorMsg}</Text>
              <Button onClick={() => void createRule()}>Retry</Button>
            </Flex>
          )}
        </Flex>

        {/* Parameters table */}
        {phase === "listening" && (
          <Flex flexDirection="column" gap={12}>
            {/* Prominent business candidates banner */}
            {params.length > 0 && (
              <Flex
                gap={12}
                alignItems="center"
                style={{
                  padding: "12px 16px",
                  background: Colors.Background.Container.Success.Default,
                  borderRadius: 6,
                }}
              >
                <Strong style={{ fontSize: "28px", color: Colors.Text.Success.Default, lineHeight: 1 }}>
                  {businessCandidateCount}
                </Strong>
                <Flex flexDirection="column" gap={2}>
                  <Strong style={{ fontSize: "14px", color: Colors.Text.Success.Default }}>
                    Business candidate{businessCandidateCount === 1 ? "" : "s"} detected
                  </Strong>
                  <Text style={{ fontSize: "12px", color: Colors.Text.Success.Default }}>
                    out of {filteredParams.length} parameter{filteredParams.length === 1 ? "" : "s"} captured
                    {sourceFilter.size < 4 ? " (filtered)" : ""}
                  </Text>
                </Flex>
              </Flex>
            )}

            {/* Source filters */}
            <Flex gap={8} alignItems="center" flexWrap="wrap">
              <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>Filter sources:</Text>
              {(
                [
                  { key: "RequestBody" as ParamSource, label: "Request Body" },
                  { key: "ResponseBody" as ParamSource, label: "Response Body" },
                  { key: "QueryParameter" as ParamSource, label: "Query String Parameters" },
                  { key: "RequestHeader" as ParamSource, label: "Request Headers" },
                ]
              ).map(({ key, label }) => {
                const active = sourceFilter.has(key);
                const count = params.filter((p) => p.source === key).length;
                return (
                  <Button
                    key={key}
                    variant={active ? "accent" : "default"}
                    onClick={() => toggleSource(key)}
                  >
                    {active ? "✓ " : ""}{label} ({count})
                  </Button>
                );
              })}
              <Flex style={{ marginLeft: "auto" }} alignItems="center">
                <Switch
                  value={businessOnly}
                  onChange={(v) => setBusinessOnly(v)}
                  name="business-candidates-only"
                >
                  Business candidates only
                </Switch>
              </Flex>
            </Flex>

            <Flex justifyContent="space-between" alignItems="center">
              <Strong>
                {filteredParams.length > 0
                  ? `${filteredParams.length} parameter${filteredParams.length === 1 ? "" : "s"} shown`
                  : params.length > 0
                  ? "No parameters match the current source filter"
                  : bizeventLoading
                  ? "Waiting for first request to hit the endpoint…"
                  : "No events captured yet — trigger a request to the endpoint"}
              </Strong>
            </Flex>

            {filteredParams.length > 0 ? (
              <DataTable
                data={filteredParams}
                columns={paramColumns}
                loading={bizeventLoading}
                fullWidth
                sortable
                rowId={(r) => `${r.source}:${r.path}`}
                variant={{ rowDensity: "condensed" }}
              />
            ) : (
              <Surface>
                <Flex padding={32} justifyContent="center" alignItems="center" flexDirection="column" gap={8}>
                  <Paragraph style={{ color: Colors.Text.Neutral.Default, textAlign: "center" }}>
                    {params.length > 0
                      ? "Toggle a source filter to see parameters."
                      : <>The capture rule is active. Make a request to <Strong>{route}</Strong> and the parameters will appear here automatically.</>}
                  </Paragraph>
                </Flex>
              </Surface>
            )}
          </Flex>
        )}
      </Flex>
    </Sheet>
  );
}

// ─── Endpoints Tab ────────────────────────────────────────────────────────────

function EndpointsTab({ endpoints, isLoading, error, serviceName }: { endpoints: ScoredItem[]; isLoading: boolean; error?: Error | null; serviceName: string }) {
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [collectTarget, setCollectTarget] = useState<ScoredItem | null>(null);
  const activeItem = endpoints.find((e) => e.id === activeRow);

  const columns = useMemo<DataTableColumnDef<ScoredItem>[]>(
    () => [
      {
        id: "confidence",
        header: "",
        accessor: "confidence",
        width: 40,
        cell: ({ value }: { value: Confidence }) => (
          <HealthIndicator
            status={value === "high" ? "ideal" : value === "medium" ? "warning" : "neutral"}
          />
        ),
      },
      {
        id: "displayName",
        header: "Route / Endpoint",
        accessor: "displayName",
        cell: ({ value, rowData }: { value: string; rowData: ScoredItem }) => (
          <Flex flexDirection="column" gap={2}>
            <Strong>{value}</Strong>
            {(rowData.raw as EndpointRecord).http_method && (
              <Chip color="neutral">{(rowData.raw as EndpointRecord).http_method}</Chip>
            )}
          </Flex>
        ),
      },
      {
        id: "keywords",
        header: "Business Keywords",
        accessor: "keywords",
        cell: ({ value }: { value: string[] }) =>
          value.length > 0 ? (
            <KeywordChips keywords={value} />
          ) : (
            <Text style={{ color: Colors.Text.Neutral.Default }}>—</Text>
          ),
      },
      {
        id: "calls",
        header: "Calls (24h)",
        accessor: "calls",
        cell: ({ value }: { value: number }) => (
          <Text>{value.toLocaleString()}</Text>
        ),
      },
      {
        id: "score",
        header: "Relevance",
        accessor: "score",
        cell: ({ value }: { value: number }) => (
          <Chip color={value >= 3 ? "success" : value >= 1 ? "warning" : "neutral"}>
            {value >= 3 ? "★★★" : value >= 1 ? "★★☆" : "★☆☆"}
          </Chip>
        ),
      },
      {
        id: "collect",
        header: "",
        accessor: "id",
        width: 160,
        cell: ({ rowData }: { value: string; rowData: ScoredItem }) => (
          <Button
            variant="accent"
            onClick={(e) => {
              e.stopPropagation();
              setCollectTarget(rowData);
            }}
          >
            Collect Parameters
          </Button>
        ),
      },
    ],
    []
  );

  if (error) {
    return (
      <Flex padding={16} gap={8} alignItems="center" style={{ color: Colors.Text.Critical.Default }}>
        <CriticalIcon />
        <Paragraph>{error.message}</Paragraph>
      </Flex>
    );
  }

  const collectEndpoint = collectTarget?.raw as EndpointRecord | undefined;

  return (
    <>
      <Flex flexDirection="column" gap={0}>
        <DataTable
          data={endpoints}
          columns={columns}
          loading={isLoading}
          fullWidth
          sortable
          interactiveRows
          activeRow={activeRow}
          onActiveRowChange={(id) => setActiveRow(id === activeRow ? null : id)}
          rowId={(row) => row.id}
          variant={{ rowDensity: "comfortable" }}
        >
          <DataTable.EmptyState>
            <Flex padding={32} justifyContent="center">
              <Paragraph>No HTTP endpoints found in the last 24 hours for this service.</Paragraph>
            </Flex>
          </DataTable.EmptyState>
        </DataTable>

        {activeItem && (
          <Surface style={{ borderTop: `2px solid ${Colors.Border.Neutral.Accent}` }}>
            <Flex padding={8} gap={8} alignItems="center" style={{ background: Colors.Background.Container.Neutral.Accent }}>
              <Strong>Configuration guide for: {activeItem.displayName}</Strong>
              <Button variant="default" onClick={() => setActiveRow(null)}>✕</Button>
            </Flex>
            <ConfigPanel item={activeItem} />
          </Surface>
        )}
      </Flex>

      <CollectParamsSheet
        show={collectTarget !== null}
        serviceName={serviceName}
        route={collectEndpoint?.route ?? ""}
        httpMethod={collectEndpoint?.http_method ?? null}
        onClose={() => setCollectTarget(null)}
      />
    </>
  );
}

// ─── Methods Tab ──────────────────────────────────────────────────────────────

function MethodsTab({ methods, isLoading, error }: { methods: ScoredItem[]; isLoading: boolean; error?: Error | null }) {
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const activeItem = methods.find((m) => m.id === activeRow);

  const displayed = showAll ? methods : methods.filter((m) => m.score > 0);

  const columns = useMemo<DataTableColumnDef<ScoredItem>[]>(
    () => [
      {
        id: "confidence",
        header: "",
        accessor: "confidence",
        width: 40,
        cell: ({ value }: { value: Confidence }) => (
          <HealthIndicator
            status={value === "high" ? "ideal" : value === "medium" ? "warning" : "neutral"}
          />
        ),
      },
      {
        id: "displayName",
        header: "Class.Method",
        accessor: "displayName",
        cell: ({ value, rowData }: { value: string; rowData: ScoredItem }) => {
          const m = rowData.raw as MethodRecord;
          return (
            <Flex flexDirection="column" gap={2}>
              <Strong>{value}</Strong>
              {m.class_name && (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>{m.class_name}</Text>
              )}
            </Flex>
          );
        },
      },
      {
        id: "keywords",
        header: "Business Keywords",
        accessor: "keywords",
        cell: ({ value }: { value: string[] }) =>
          value.length > 0 ? (
            <KeywordChips keywords={value} />
          ) : (
            <Text style={{ color: Colors.Text.Neutral.Default }}>—</Text>
          ),
      },
      {
        id: "calls",
        header: "Calls (24h)",
        accessor: "calls",
        cell: ({ value }: { value: number }) => <Text>{value.toLocaleString()}</Text>,
      },
      {
        id: "score",
        header: "Relevance",
        accessor: "score",
        cell: ({ value }: { value: number }) => (
          <Chip color={value >= 3 ? "success" : value >= 1 ? "warning" : "neutral"}>
            {value >= 3 ? "★★★" : value >= 1 ? "★★☆" : "★☆☆"}
          </Chip>
        ),
      },
    ],
    []
  );

  if (error) {
    return (
      <Flex padding={16} gap={8} alignItems="center" style={{ color: Colors.Text.Critical.Default }}>
        <CriticalIcon />
        <Paragraph>{error.message}</Paragraph>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={0}>
      <Flex padding={8} justifyContent="space-between" alignItems="center">
        <Text style={{ color: Colors.Text.Neutral.Default }}>
          Showing {displayed.length} of {methods.length} internal method spans
          {!showAll && methods.length > displayed.length && ` (${methods.length - displayed.length} without business keywords hidden)`}
        </Text>
        <Button variant="default" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show candidates only" : "Show all methods"}
        </Button>
      </Flex>

      <DataTable
        data={displayed}
        columns={columns}
        loading={isLoading}
        fullWidth
        sortable
        interactiveRows
        activeRow={activeRow}
        onActiveRowChange={(id) => setActiveRow(id === activeRow ? null : id)}
        rowId={(row) => row.id}
        variant={{ rowDensity: "comfortable" }}
      >
        <DataTable.EmptyState>
          <Flex padding={32} justifyContent="center">
            <Paragraph>No internal method spans with business keywords found. Try "Show all methods" to see all spans.</Paragraph>
          </Flex>
        </DataTable.EmptyState>
      </DataTable>

      {activeItem && (
        <Surface style={{ borderTop: `2px solid ${Colors.Border.Neutral.Accent}` }}>
          <Flex padding={8} gap={8} alignItems="center" style={{ background: Colors.Background.Container.Neutral.Accent }}>
            <Strong>Configuration guide for: {activeItem.displayName}</Strong>
            <Button variant="default" onClick={() => setActiveRow(null)}>✕</Button>
          </Flex>
          <ConfigPanel item={activeItem} />
        </Surface>
      )}
    </Flex>
  );
}

// ─── Headers Rule Tab ─────────────────────────────────────────────────────────

const HEADER_RULE_INSTRUCTION = `📍 Rule: "HTTP Request Header Discovery" (Wildcard Capture)
   Path: Settings → Server-side service monitoring → Request attributes → Add new attribute

   Step 1 — Create the Discovery Attribute:
   ─────────────────────────────────────────
   • Attribute name:     HTTP Header Discovery
   • Data type:          Text
   • Aggregation:        First value

   Step 2 — Add Data Source:
   ─────────────────────────────────────────
   • Request attribute source: HTTP request header
   • Header name:        *          ← wildcard captures ALL headers
   • Capture what:       Value
   • Representation:     First 200 characters
   • Apply to:           All services

   Step 3 — Review Captured Headers:
   ─────────────────────────────────────────
   After 24h of traffic, check captured values in:
   • Dynatrace → Distributed Traces → any trace → Request Attributes tab
   • Look for headers like:
       X-Customer-ID, X-User-ID, X-Account-Type,
       X-Loyalty-Tier, X-Correlation-ID, X-Session-ID,
       Authorization (carries user identity via JWT),
       X-B3-TraceId, baggage, tracestate

   Step 4 — Create Specific Rules:
   ─────────────────────────────────────────
   For each valuable header discovered, create a dedicated rule:
   • Attribute name: [Descriptive name, e.g., "Customer Loyalty Tier"]
   • Data source:    HTTP request header
   • Header name:    X-Loyalty-Tier    ← exact header name
   • Remove the wildcard rule once you've identified all valuable headers.`;

function HeadersRuleTab() {
  const [copied, setCopied] = useState(false);
  const copyAll = () => {
    void navigator.clipboard.writeText(HEADER_RULE_INSTRUCTION);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      <Flex gap={12} alignItems="flex-start" flexDirection="column">
        <Heading level={3}>HTTP Request Header Discovery Rule</Heading>
        <Paragraph>
          This wildcard rule captures <Strong>all HTTP request headers</Strong> across your services,
          allowing you to identify which headers carry business context (user identity, loyalty tier,
          correlation IDs, etc.) without knowing them upfront.
        </Paragraph>
      </Flex>

      <Surface>
        <Flex padding={16} flexDirection="column" gap={12}>
          <Flex justifyContent="space-between" alignItems="center">
            <Strong>Configuration Instructions</Strong>
            <Button variant="default" onClick={copyAll}>
              {copied ? "✓ Copied!" : "Copy all instructions"}
            </Button>
          </Flex>
          <pre
            style={{
              fontFamily: "monospace",
              fontSize: "13px",
              whiteSpace: "pre-wrap",
              margin: 0,
              lineHeight: 1.7,
              color: Colors.Text.Primary.Default,
            }}
          >
            {HEADER_RULE_INSTRUCTION}
          </pre>
        </Flex>
      </Surface>

      <Flex gap={12} flexDirection="column">
        <Strong>Commonly Found Business Headers</Strong>
        <Flex gap={8} flexWrap="wrap">
          {[
            "X-Customer-ID", "X-User-ID", "X-Account-Type", "X-Loyalty-Tier",
            "X-Session-ID", "X-Correlation-ID", "X-Request-ID", "X-Tenant-ID",
            "X-Market", "X-Region", "Authorization", "X-B3-TraceId",
          ].map((h) => (
            <Chip key={h} color="primary">{h}</Chip>
          ))}
        </Flex>
      </Flex>
    </Flex>
  );
}

// ─── Config Summary Tab ───────────────────────────────────────────────────────

function ConfigSummaryTab({ endpoints, methods }: { endpoints: ScoredItem[]; methods: ScoredItem[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const allSuggestions = [
    ...endpoints.filter((e) => e.score > 0).flatMap((e) => e.suggestions.map((s) => ({ ...s, source: e.displayName, type: "HTTP" }))),
    ...methods.filter((m) => m.score > 0).flatMap((m) => m.suggestions.map((s) => ({ ...s, source: m.displayName, type: "Method" }))),
  ];

  // Deduplicate by attribute name
  const unique = allSuggestions.filter(
    (s, idx, arr) => arr.findIndex((a) => a.name === s.name) === idx
  );

  const copy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyAll = () => {
    const full = unique.map((s) => `${s.name}\n${"─".repeat(40)}\n${s.instruction}`).join("\n\n");
    void navigator.clipboard.writeText(full);
    setCopied("all");
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      <Flex justifyContent="space-between" alignItems="center">
        <Flex flexDirection="column" gap={4}>
          <Heading level={3}>Configuration Nominations</Heading>
          <Paragraph>
            All suggested Request Attribute configurations discovered across HTTP endpoints and method spans.
            Create these in <Strong>Settings → Server-side service monitoring → Request attributes</Strong>.
          </Paragraph>
        </Flex>
        <Button onClick={copyAll}>{copied === "all" ? "✓ All Copied!" : "Copy All"}</Button>
      </Flex>

      {unique.length === 0 ? (
        <Flex padding={32} justifyContent="center">
          <Paragraph>No candidates found yet. Ensure business-logic spans are present in the last 24h.</Paragraph>
        </Flex>
      ) : (
        <Flex flexDirection="column" gap={8}>
          {unique.map((s, idx) => (
            <Surface key={idx}>
              <Flex padding={16} flexDirection="column" gap={8}>
                <Flex justifyContent="space-between" alignItems="center">
                  <Flex gap={8} alignItems="center">
                    <Strong>{s.name}</Strong>
                    <Chip color={s.confidence === "high" ? "success" : s.confidence === "medium" ? "warning" : "neutral"}>
                      {s.confidence}
                    </Chip>
                    <Chip color="neutral">{s.type}: {s.source}</Chip>
                  </Flex>
                  <Button
                    variant="default"
                    onClick={() => copy(s.instruction, `sum-${idx}`)}
                  >
                    {copied === `sum-${idx}` ? "✓ Copied" : "Copy"}
                  </Button>
                </Flex>
                <pre
                  style={{
                    fontFamily: "monospace",
                    fontSize: "12px",
                    whiteSpace: "pre-wrap",
                    margin: 0,
                    lineHeight: 1.6,
                    color: Colors.Text.Neutral.Default,
                  }}
                >
                  {s.instruction}
                </pre>
              </Flex>
            </Surface>
          ))}
        </Flex>
      )}
    </Flex>
  );
}

// ─── Endpoints Explorer (new per-service layout) ─────────────────────────────────

function RelevanceBadge({ score }: { score: number }) {
  if (score >= 3) return <Chip color="success">★★★ relevant</Chip>;
  if (score >= 1) return <Chip color="warning">★★☆ likely</Chip>;
  return <Chip color="neutral">★☆☆ low</Chip>;
}

function EndpointsExplorer({
  endpoints,
  methodsByEndpoint,
  endpointsLoading,
  endpointsError,
  methodsLoading,
  methodsError,
  serviceName,
  serviceId,
}: {
  endpoints: ScoredItem[];
  methodsByEndpoint: Map<string, MethodCandidate[]>;
  endpointsLoading: boolean;
  endpointsError?: Error | null;
  methodsLoading: boolean;
  methodsError?: Error | null;
  serviceName: string;
  serviceId: string;
}) {
  const [collectTarget, setCollectTarget] = useState<ScoredItem | null>(null);
  // Endpoint currently opened in the Investigate Methods sheet (null = closed).
  const [methodsTarget, setMethodsTarget] = useState<ScoredItem | null>(null);
  // Toggle to hide low-relevance candidates (score 0 / ★☆☆ low). Defaults to
  // OFF so all endpoints stay visible until the user opts in.
  const [hideLow, setHideLow] = useState(false);

  // An endpoint counts as "relevant" if EITHER its own URL/route scores
  // medium-or-better, OR at least one method span inside it does. The
  // earlier version only checked the route score, which hid endpoints
  // like `getReportPage` whose URL didn't match any business keyword
  // even though the inner Investigate-methods view turned up real
  // business candidates (visible in the column on the right). Looking
  // at both signals avoids losing those rows when the user toggles
  // "Hide low-relevance" on.
  const endpointHasBusinessMethod = useCallback(
    (e: ScoredItem): boolean => {
      const ep = e.raw as EndpointRecord;
      const methods = methodsByEndpoint.get(ep.route) ?? [];
      return methods.some((m) => m.score >= 1);
    },
    [methodsByEndpoint],
  );

  const visibleEndpoints = useMemo(
    () =>
      hideLow
        ? endpoints.filter((e) => e.score >= 1 || endpointHasBusinessMethod(e))
        : endpoints,
    [endpoints, hideLow, endpointHasBusinessMethod],
  );
  const lowCount =
    endpoints.length -
    endpoints.filter((e) => e.score >= 1 || endpointHasBusinessMethod(e)).length;

  const columns = useMemo<DataTableColumnDef<ScoredItem>[]>(
    () => [
      {
        id: "displayName",
        header: "Endpoint",
        accessor: "displayName",
        cell: ({ value, rowData }: { value: string; rowData: ScoredItem }) => {
          const ep = rowData.raw as EndpointRecord;
          return (
            <Flex flexDirection="column" gap={4} padding={4}>
              <Strong>
                <HighlightedText text={value} keywords={rowData.keywords} />
              </Strong>
              <Flex gap={6} alignItems="center">
                {ep.http_method && <Chip color="neutral">{ep.http_method}</Chip>}
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  {rowData.calls.toLocaleString()} calls (30m)
                </Text>
              </Flex>
            </Flex>
          );
        },
      },
      {
        id: "http_params",
        header: "HTTP parameters",
        accessor: "score",
        width: 220,
        cell: ({ rowData }: { value: number; rowData: ScoredItem }) => (
          <Flex flexDirection="column" gap={8} padding={4}>
            <Flex gap={6} alignItems="center" flexWrap="wrap">
              <RelevanceBadge score={rowData.score} />
            </Flex>
            <Flex>
              <Button
                variant="accent"
                style={{
                  background: Colors.Background.Container.Primary.Accent,
                  borderColor: Colors.Background.Container.Primary.Accent,
                  color: Colors.Text.Primary.OnAccent.Default,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollectTarget(rowData);
                }}
              >
                Collect HTTP Parameters
              </Button>
            </Flex>
          </Flex>
        ),
      },
      {
        id: "method_candidates",
        header: "Method candidates",
        accessor: "id",
        cell: ({ rowData }: { value: string; rowData: ScoredItem }) => {
          const ep = rowData.raw as EndpointRecord;
          const methods = methodsByEndpoint.get(ep.route) ?? [];
          const businessMatches = methods.filter((m) => m.score > 0);
          const totalMethods = methods.length;
          return (
            <Flex flexDirection="column" gap={8} padding={4}>
              {methodsError ? (
                <Text style={{ color: Colors.Text.Critical.Default, fontSize: "12px" }}>
                  {methodsError.message}
                </Text>
              ) : methodsLoading ? (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  Scanning trace spans…
                </Text>
              ) : totalMethods === 0 ? (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  No method spans recorded for this endpoint in the last 30m.
                </Text>
              ) : (
                <Flex flexDirection="column" gap={4}>
                  <Flex gap={6} alignItems="center" flexWrap="wrap">
                    {businessMatches.length > 0 ? (
                      <Chip color="success">
                        <Strong>{businessMatches.length}</Strong>&nbsp;business candidate
                        {businessMatches.length === 1 ? "" : "s"}
                      </Chip>
                    ) : (
                      <Chip color="neutral">No business keyword matches</Chip>
                    )}
                  </Flex>
                  {businessMatches.length > 0 ? (
                    <Flex flexDirection="column" gap={2}>
                      {businessMatches.slice(0, 3).map((m) => (
                        <Flex key={m.id} gap={6} alignItems="center" flexWrap="wrap">
                          <Text
                            style={{
                              color: Colors.Text.Neutral.Default,
                              fontSize: "12px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <HighlightedText text={m.displayName} keywords={m.keywords} />
                          </Text>
                          {m.is_cross_service ? (
                            <Chip color="warning">Underlying service</Chip>
                          ) : m.is_surrounding ? (
                            <Chip color="primary">Co-occurring</Chip>
                          ) : null}
                          {/* Span-kind chip intentionally suppressed — see
                              `groupMethodCandidates` for the dedup rationale.
                              Server / internal variants of the same method are
                              merged into a single row and Request Attribute
                              captures are persisted on the server span, so
                              surfacing the kind only confused users. */}
                        </Flex>
                      ))}
                      {businessMatches.length > 3 ? (
                        <Text
                          style={{
                            color: Colors.Text.Neutral.Default,
                            fontSize: "11px",
                            fontStyle: "italic",
                          }}
                        >
                          +{businessMatches.length - 3} more
                        </Text>
                      ) : null}
                    </Flex>
                  ) : null}
                </Flex>
              )}
              <Flex gap={6} alignItems="center">
                <Button
                  variant="accent"
                  disabled={totalMethods === 0}
                  style={{
                    background: Colors.Background.Container.Primary.Accent,
                    borderColor: Colors.Background.Container.Primary.Accent,
                    color: Colors.Text.Primary.OnAccent.Default,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMethodsTarget(rowData);
                  }}
                >
                  Investigate methods
                  {totalMethods > 0 ? (
                    <span
                      style={{
                        marginLeft: 8,
                        padding: "1px 8px",
                        borderRadius: 999,
                        background: "rgba(255, 255, 255, 0.22)",
                        color: Colors.Text.Primary.OnAccent.Default,
                        fontSize: 11,
                        fontWeight: 700,
                        lineHeight: "16px",
                      }}
                    >
                      {totalMethods}
                    </span>
                  ) : null}
                </Button>
              </Flex>
            </Flex>
          );
        },
      },
    ],
    [methodsByEndpoint, methodsLoading, methodsError]
  );

  if (endpointsError) {
    return (
      <Flex padding={16} gap={8} alignItems="center" style={{ color: Colors.Text.Critical.Default }}>
        <CriticalIcon />
        <Paragraph>{endpointsError.message}</Paragraph>
      </Flex>
    );
  }

  const collectEndpoint = collectTarget?.raw as EndpointRecord | undefined;

  return (
    <>
      <Flex
        padding={12}
        gap={12}
        alignItems="center"
        justifyContent="space-between"
        style={{
          borderBottom: `1px solid ${Colors.Border.Neutral.Default}`,
        }}
      >
        <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
          {hideLow
            ? `Showing ${visibleEndpoints.length} of ${endpoints.length} endpoints (${lowCount} low hidden)`
            : `Showing all ${endpoints.length} endpoints${lowCount > 0 ? ` (${lowCount} low)` : ""}`}
        </Text>
        <Switch value={hideLow} onChange={(v) => setHideLow(v)} name="hide-low-endpoints">
          Hide low-relevance endpoints
        </Switch>
      </Flex>
      <DataTable
        data={visibleEndpoints}
        columns={columns}
        loading={endpointsLoading}
        fullWidth
        sortable
        rowId={(row) => row.id}
        variant={{ rowDensity: "comfortable" }}
      >
        <DataTable.EmptyState>
          <Flex padding={32} justifyContent="center">
            <Paragraph>
              {hideLow && endpoints.length > 0
                ? "All endpoints are low-relevance. Toggle off to see them."
                : "No HTTP endpoints found in the last 30 minutes for this service."}
            </Paragraph>
          </Flex>
        </DataTable.EmptyState>
      </DataTable>

      <CollectParamsSheet
        show={collectTarget !== null}
        serviceName={serviceName}
        route={collectEndpoint?.route ?? ""}
        httpMethod={collectEndpoint?.http_method ?? null}
        onClose={() => setCollectTarget(null)}
      />

      <InvestigateMethodsSheet
        show={methodsTarget !== null}
        serviceName={serviceName}
        serviceId={serviceId}
        route={(methodsTarget?.raw as EndpointRecord | undefined)?.route ?? ""}
        httpMethod={(methodsTarget?.raw as EndpointRecord | undefined)?.http_method ?? null}
        candidates={
          methodsTarget
            ? methodsByEndpoint.get((methodsTarget.raw as EndpointRecord).route) ?? []
            : []
        }
        onClose={() => setMethodsTarget(null)}
      />
    </>
  );
}

// ─── Investigate Methods Sheet ───────────────────────────────────────────────

// Build a deep-link URL into the Dynatrace classic Settings UI so the user
// can land directly in the native "Add Request Attribute" wizard with their
// class+method already on the clipboard. The settings UI is reached via the
// app shell's settings route. We don't try to pre-fill the form fields via
// URL (the classic UI doesn't read those from query params) — instead we
// copy `className`+`methodName` to the clipboard so the user can paste them
// straight into the "Search methods" picker.
function settingsDeepLink(): string {
  // Build the URL off the environment URL (e.g. https://<env>.apps.dynatrace.com)
  // rather than window.location.origin / window.location.href — inside the
  // app shell, the app iframe is served under
  //   /ui/apps/<app.id>/...
  // and a relative or origin+location-based path was being re-rooted to
  //   /ui/apps/<our.app.id>/ui/apps/dynatrace.settings/...
  // breaking the link. getEnvironmentUrl() always returns the bare
  // environment origin, so concatenating /ui/apps/dynatrace.settings/...
  // produces a clean absolute URL that the browser opens directly.
  const base = getEnvironmentUrl().replace(/\/+$/, "");
  return `${base}/ui/apps/dynatrace.settings/settings/service-request-attributes`;
}

// React panel offering two paths to learn the method signature now that
// we've confirmed there is no public "Search methods" API:
//   B. Deep-link the user to the native Settings UI picker (one-click flow
//      to the supported way of getting the signature into a real rule).
//   C. Probe the documented validator endpoint with placeholder arg/return
//      types to see whether it does live OneAgent method-existence checks
//      (and if so, what the error response reveals about the real signature).

// Map OneAgent / OTel technology hints to the exact label that appears in
// the "Request attribute source" dropdown of the native picker. The wizard
// only exposes a method-parameter source per technology — there is no
// generic "method parameter" row.
function technologySourceLabel(technology: string | null): string {
  if (!technology) return "Java method parameter(s)";
  const t = technology.toLowerCase();
  if (t.includes("dotnet") || t.includes(".net") || t === "net") return ".Net method parameter(s)";
  if (t.includes("php")) return "PHP method parameter(s)";
  if (t.includes("node") || t.includes("nodejs")) return "Node.js method parameter(s)";
  if (t.includes("go")) return "Go method parameter(s)";
  // Java is the default fallback — the most common case by far.
  return "Java method parameter(s)";
}

// Small inline "value + Copy button" row that's used three times below to
// surface each piece of info the user needs to paste into the wizard.
function CopyableField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  // Compact one-line layout so the panel reads as supporting info, not a
  // form. Hint is rendered as a small italic suffix on the same column as
  // the value (tooltipped via `title`) instead of taking a second line.
  return (
    <Flex gap={8} alignItems="center" style={{ minHeight: 24 }}>
      <Text
        style={{
          width: 140,
          color: Colors.Text.Neutral.Default,
          fontSize: "11px",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: "monospace",
          fontSize: "12px",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={hint ? `${value ?? "—"} · ${hint}` : (value ?? undefined)}
      >
        {value ?? <em style={{ color: Colors.Text.Neutral.Default }}>not available</em>}
      </Text>
      <Button
        variant="default"
        disabled={!value}
        onClick={onCopy}
        style={{ padding: "2px 8px", minHeight: 22, fontSize: "11px" }}
      >
        {copied ? "Copied!" : "Copy"}
      </Button>
    </Flex>
  );
}

function MethodSignatureDiscovery({
  className,
  methodName,
  processGroupId,
  processGroupFallbackName,
  technology,
}: {
  className: string | null;
  methodName: string | null;
  processGroupId: string | null;
  processGroupFallbackName: string | null;
  technology: string | null;
}) {
  // `dt.process_group.detected_name` is a span attribute — already resolved
  // to the human-friendly display name by the time it reaches here as
  // processGroupFallbackName (e.g. "com.dynatrace.easytravel.business.backend.jar easyTravel (x*)").
  const processGroupDisplay = processGroupFallbackName ?? processGroupId;

  const sourceLabel = technologySourceLabel(technology);

  return (
    <Flex flexDirection="column" gap={12}>
      {/* ── Required information for the native Settings picker ──────────
          Styled as a tight, supporting info panel: small uppercase label,
          one-line copyable rows, subtle background so it doesn't compete
          with the captured-value panel or the steps below. */}
      <Flex
        padding={8}
        flexDirection="column"
        gap={4}
        style={{
          background: Colors.Background.Container.Neutral.Subdued,
          border: `1px solid ${Colors.Border.Neutral.Default}`,
          borderRadius: 6,
        }}
      >
        <Text
          style={{
            color: Colors.Text.Neutral.Default,
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.5px",
            textTransform: "uppercase",
            marginBottom: 2,
          }}
        >
          Required information · paste into the wizard
        </Text>

        <Flex flexDirection="column" gap={2}>
          <CopyableField
            label="1. Request attribute source"
            value={sourceLabel}
            hint={`derived from technology: ${technology ?? "unknown (defaulted to Java)"}`}
          />
          <CopyableField
            label="2. Process group"
            value={processGroupDisplay}
            hint={
              processGroupFallbackName
                ? "resolved from dt.process_group.detected_name span attribute"
                : processGroupId
                  ? `couldn't resolve display name — falling back to ID ${processGroupId}`
                  : "no process-group attribute on this span"
            }
          />
          <CopyableField
            label="3. Class name"
            value={className}
            hint="paste into the 'Find entry point' search box, then click Search"
          />
          <CopyableField
            label="4. Method name"
            value={methodName}
            hint="select this row in the matched-methods list shown by the wizard"
          />
        </Flex>
      </Flex>
    </Flex>
  );
}

// ─── Post-wizard "next steps" flow ───────────────────────────────────────────
// Renders a compact vertical stepper with three actionable steps that pick up
// where the Settings wizard leaves off. Step 3 actually queries Grail for any
// `dt.request_attribute.*` values being captured on this class right now, so
// the user gets a live confirmation that their rule fired.

function StepRow({
  num,
  total,
  title,
  body,
  action,
  state = "active",
}: {
  num: number;
  total: number;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  state?: "active" | "done";
}) {
  const ringColor =
    state === "done"
      ? Colors.Background.Container.Success.Default
      : Colors.Background.Container.Primary.Accent;
  return (
    <Flex gap={12} alignItems="stretch" style={{ position: "relative" }}>
      {/* Left rail: numbered badge + vertical connector */}
      <Flex
        flexDirection="column"
        alignItems="center"
        style={{ width: 28, flexShrink: 0 }}
      >
        <Flex
          alignItems="center"
          justifyContent="center"
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: ringColor,
            color: Colors.Text.Primary.OnAccent.Default,
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {num}
        </Flex>
        {num < total && (
          <div
            style={{
              flex: 1,
              width: 2,
              background: Colors.Border.Neutral.Default,
              marginTop: 4,
            }}
          />
        )}
      </Flex>
      {/* Right content */}
      <Flex
        flexDirection="column"
        gap={4}
        style={{ flex: 1, paddingBottom: num < total ? 16 : 0 }}
      >
        <Text style={{ fontSize: "13px", fontWeight: 600 }}>{title}</Text>
        {body && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
            {body}
          </Text>
        )}
        {action}
      </Flex>
    </Flex>
  );
}

// Step 4 — pings Grail for recent server-kind spans on this service and
// surfaces any attributes whose key matches a known Dynatrace capture
// prefix. The query is gated behind a button so we don't spam Grail until
// the user asks.
//
// We target the **server** span (the request entry) regardless of which
// method the user just attached an RA to. Why: Request Attribute and
// bizevent extraction values are *request-scoped* in Dynatrace — even
// when the extraction rule reads from a method argument or return value
// deep inside the call tree, OneAgent persists the captured value on
// the request itself, which in Grail is the server span. Filtering by
// `code.namespace`/`code.function` would silently miss those captures
// (the server span typically doesn't carry method-level code attributes;
// those live on the internal method span the rule extracted from). And
// filtering by `span.kind == "internal"` would require the method to be
// explicitly instrumented — if the user hasn't yet created the RA, no
// internal span exists and the verifier would return zero rows, even
// when other RAs on the service are working fine.
//
// Scoping by service keeps the noise reasonable: the user sees every
// captured-attribute key currently flowing on this service's requests,
// which is exactly what they need to confirm "my new RA is producing
// values" (the key they just created will appear in the list).
function LiveRequestAttributePreview({
  className,
  methodName,
  spanKind,
  serviceId,
}: {
  className: string | null;
  methodName: string | null;
  spanKind: string | null;
  serviceId: string | null;
}) {
  // spanKind is kept in the prop list for API stability with the rest
  // of the NextStepsFlow surface (the draft panel and signature
  // discovery tabs still use it). The verification query only needs
  // service + class + method to scope correctly.
  void spanKind;
  const [enabled, setEnabled] = useState(false);
  // Bumped every time the user clicks Refresh so the query string
  // changes and `useDql` re-runs instead of returning cached data.
  // Without this, clicking Refresh after the first fetch is a no-op:
  // setEnabled(true) when enabled is already true produces no
  // re-render, the query string stays identical, and useDql skips
  // the network round-trip.
  const [nonce, setNonce] = useState(0);
  const safeSvc = (serviceId ?? "").replace(/"/g, '\\"');
  const safeClass = (className ?? "").replace(/"/g, '\\"');
  const safeMethod = (methodName ?? "").replace(/"/g, '\\"');
  // Capture values can land on EITHER the request-entry server span OR
  // the instrumented method's internal shadow span (the one we collapse
  // in the waterfall). Pre-v0.0.130 this filter was `span.kind ==
  // "server"` only, so SOAP/Axis services whose request-attribute or
  // bizevent rule captures from a method body (and therefore writes
  // onto the internal child span) reported "no captured attributes
  // found" even when capture was working perfectly. Including
  // "internal" here mirrors the lift we do in buildWaterfallRows.
  //
  // Capture values can land on EITHER the request-entry server span
  // (classic Request Attribute rules) OR the instrumented method's
  // internal shadow span (bizevent extraction, method-argument capture
  // — the same shadow we collapse in the waterfall). We have to scan
  // both to verify either type.
  //
  // When we know the target class + method, we narrow the INTERNAL
  // branch to spans of THAT method only. Note the field names: on raw
  // `fetch spans` rows the per-method identity lives in `code.namespace`
  // (class) and `code.function` (method) — `class_name` / `method_name`
  // are summarize-aliases we use elsewhere and DO NOT exist on raw
  // span records. v0.0.132–v0.0.134 filtered on the alias names by
  // mistake, so the internal branch matched zero rows and the panel
  // reported "no captured attributes" even when capture was healthy.
  const filters: string[] = [];
  if (className && methodName) {
    filters.push(
      `(span.kind == "server" OR (span.kind == "internal" AND code.namespace == "${safeClass}" AND code.function == "${safeMethod}"))`,
    );
  } else {
    filters.push(`in(span.kind, "server", "internal")`);
  }
  if (serviceId) {
    filters.push(
      `(dt.entity.service == "${safeSvc}" OR dt.smartscape.service == toSmartscapeId("${safeSvc}"))`,
    );
  }
  const query = enabled && serviceId
    ? `// nonce ${nonce}\nfetch spans, from:now()-15m\n| filter ${filters.join("\n| filter ")}\n| limit 500`
    : `fetch spans | limit 0`;
  const { data, isLoading, error } = useDql({ query });

  const stats = useMemo(() => {
    if (!enabled || !data?.records) return null;
    const counts = new Map<
      string,
      { hits: number; samples: string[]; source: string }
    >();
    let totalSpans = 0;
    // We surface ANY OneAgent / OTel capture surface that ends up as a
    // span attribute, not just the legacy Request Attribute prefix. In
    // practice we see at least three different prefixes in the wild:
    //   - dt.request_attribute.<name>   → classic Request Attribute rules
    //   - captured_attribute.<name>     → bizevent / data extraction rules
    //   - method.argument.<name>        → method-argument capture (older)
    // The user's Collect HTTP Parameters wizard creates a bizevent rule,
    // which lands values under captured_attribute.* — so a verifier that
    // only looks for dt.request_attribute.* would (incorrectly) say "no
    // values found" even when capture is working fine.
    const PREFIXES: Array<{ prefix: string; source: string }> = [
      { prefix: "dt.request_attribute.", source: "Request Attribute" },
      { prefix: "captured_attribute.", source: "Bizevent extraction" },
      { prefix: "method.argument.", source: "Method argument" },
    ];
    for (const rec of data.records) {
      totalSpans++;
      for (const [k, v] of Object.entries(rec)) {
        const match = PREFIXES.find((p) => k.startsWith(p.prefix));
        if (!match) continue;
        if (v === null || v === undefined || v === "") continue;
        const slot =
          counts.get(k) ?? { hits: 0, samples: [], source: match.source };
        slot.hits++;
        // Collect up to 10 distinct samples so the user can flip through
        // the actual captured values (same UX as Collect HTTP Parameters).
        if (slot.samples.length < 10) {
          const strVal = String(v).slice(0, 200);
          if (!slot.samples.includes(strVal)) slot.samples.push(strVal);
        }
        counts.set(k, slot);
      }
    }
    return { totalSpans, attrs: Array.from(counts.entries()) };
  }, [enabled, data]);

  // Per-attribute sample-navigation index (key → which sample is showing).
  const [sampleIdx, setSampleIdx] = useState<Record<string, number>>({});

  return (
    <Flex flexDirection="column" gap={8}>
      <Flex gap={8} alignItems="center" flexWrap="wrap">
        <Button
          variant="emphasized"
          disabled={!serviceId || isLoading}
          onClick={() => {
            setEnabled(true);
            // Bump the nonce so the query string changes and useDql
            // actually re-runs. On the very first click `enabled`
            // flips false→true which already changes the query, so
            // the bump here only matters from the 2nd click onward
            // (the "Refresh" press) — but it's cheap to always do.
            setNonce((n) => n + 1);
          }}
        >
          {isLoading
            ? "Checking…"
            : enabled
              ? "Refresh"
              : "Check live data now"}
        </Button>
        {!serviceId && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            service required
          </Text>
        )}
      {enabled && stats && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            scanned {stats.totalSpans} server/internal span
            {stats.totalSpans === 1 ? "" : "s"} in the last 15 min
          </Text>
        )}
      </Flex>

      {error && (
        <Text style={{ color: Colors.Text.Critical.Default, fontSize: "11px" }}>
          {error.message}
        </Text>
      )}

      {enabled && !isLoading && stats && stats.attrs.length === 0 && (
        <Surface>
          <Flex padding={12} flexDirection="column" gap={4}>
            <Text style={{ fontSize: "12px" }}>
              No captured attributes found on {stats.totalSpans} recent
              server or internal span{stats.totalSpans === 1 ? "" : "s"} for
              this service.
            </Text>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
              Checked for{" "}
              <code>dt.request_attribute.*</code>,{" "}
              <code>captured_attribute.*</code> and{" "}
              <code>method.argument.*</code> prefixes on the request entry
              span (where classic Request Attribute values land) and on
              the internal shadow span
              {className && methodName
                ? ` of ${className}.${methodName} (where bizevent / method-argument captures land)`
                : " (where bizevent / method-argument captures land)"}
              . Either no extraction rule is active yet, or the rule was
              just saved and OneAgent hasn&apos;t picked it up (give it
              ~60 s and replay a request).
            </Text>
          </Flex>
        </Surface>
      )}

      {enabled && !isLoading && stats && stats.attrs.length > 0 && (
        <Surface>
          <Flex padding={12} flexDirection="column" gap={8}>
            <Flex gap={6} alignItems="center">
              <Chip color="success">{stats.attrs.length} live attribute{stats.attrs.length === 1 ? "" : "s"}</Chip>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                already being captured on this class
              </Text>
            </Flex>
            <Flex flexDirection="column" gap={6}>
              {stats.attrs.map(([k, info]) => {
                const shortName = k.replace(
                  /^(dt\.request_attribute\.|captured_attribute\.|method\.argument\.)/,
                  "",
                );
                const { keywords } = scoreText(shortName);
                const samples = info.samples.length > 0 ? info.samples : [""];
                const idx = Math.min(sampleIdx[k] ?? 0, samples.length - 1);
                const current = samples[idx] || "—";
                const hasMultiple = samples.length > 1;
                const goPrev = () =>
                  setSampleIdx((s) => ({
                    ...s,
                    [k]: (idx - 1 + samples.length) % samples.length,
                  }));
                const goNext = () =>
                  setSampleIdx((s) => ({ ...s, [k]: (idx + 1) % samples.length }));
                return (
                  <Flex
                    key={k}
                    gap={8}
                    alignItems="center"
                    flexWrap="wrap"
                    padding={8}
                    style={{
                      background: Colors.Background.Container.Neutral.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      borderRadius: 6,
                      minHeight: 44,
                    }}
                  >
                    {/* Attribute name (keyword-highlighted) */}
                    <Text
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        color: Colors.Text.Primary.Default,
                        fontWeight: 700,
                        minWidth: 200,
                      }}
                    >
                      <HighlightedText text={shortName} keywords={keywords} />
                    </Text>

                    {/* Equals sign */}
                    <Text
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        color: Colors.Text.Neutral.Default,
                      }}
                    >
                      =
                    </Text>

                    {/* Value navigator (prev | value | n/N | next) */}
                    <Flex gap={4} alignItems="center" style={{ flex: 1, minWidth: 0 }}>
                      {hasMultiple && (
                        <Button
                          variant="default"
                          onClick={goPrev}
                          aria-label="Previous sample"
                          style={{ padding: "0 4px", minWidth: 24 }}
                        >
                          ‹
                        </Button>
                      )}
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: Colors.Text.Primary.OnAccent.Default,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: Colors.Background.Container.Primary.Accent,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 360,
                        }}
                        title={current}
                      >
                        {current}
                      </Text>
                      {hasMultiple && (
                        <>
                          <Text
                            style={{
                              fontSize: "10px",
                              color: Colors.Text.Neutral.Default,
                            }}
                          >
                            {idx + 1}/{samples.length}
                          </Text>
                          <Button
                            variant="default"
                            onClick={goNext}
                            aria-label="Next sample"
                            style={{ padding: "0 4px", minWidth: 24 }}
                          >
                            ›
                          </Button>
                        </>
                      )}
                    </Flex>

                    {/* Source + hits chips */}
                    <Chip color="neutral">{info.source}</Chip>
                    <Chip color="neutral">
                      {info.hits} hit{info.hits === 1 ? "" : "s"}
                    </Chip>
                  </Flex>
                );
              })}
            </Flex>
          </Flex>
        </Surface>
      )}
    </Flex>
  );
}

// ─── Capture draft board ──────────────────────────────────────────────────────
// Small scratchpad opened from Step 2 of the wizard. While the user is
// chasing nested objects across multiple data-source rows in the native
// Request attributes UI, they need somewhere to record the class names and
// getter signatures they keep discovering. We keep the entries in
// localStorage keyed by the method signature so the values stick around
// while they tab between Dynatrace and their IDE.

type DraftRow = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onCopy: () => void;
};

function DraftSection({
  title,
  subtitle,
  rows,
  onRemove,
}: {
  title: string;
  subtitle: string;
  rows: DraftRow[];
  onRemove?: () => void;
}) {
  return (
    <Flex
      flexDirection="column"
      gap={8}
      padding={12}
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        background: Colors.Background.Container.Neutral.Subdued,
      }}
    >
      <Flex alignItems="center" justifyContent="space-between" gap={8}>
        <Flex flexDirection="column" gap={2}>
          <Text style={{ fontSize: "12px", fontWeight: 700 }}>{title}</Text>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            {subtitle}
          </Text>
        </Flex>
        {onRemove && (
          <Button variant="default" onClick={onRemove}>
            Remove
          </Button>
        )}
      </Flex>
      {rows.map((row) => (
        <Flex key={row.label} gap={8} alignItems="center">
          <Text
            style={{
              width: 200,
              flexShrink: 0,
              fontSize: "11px",
              color: Colors.Text.Neutral.Default,
            }}
          >
            {row.label}
          </Text>
          <div style={{ flex: 1 }}>
            <TextInput
              value={row.value}
              // Strato's TextInput historically called onChange either with
              // the raw string or with a DOM event — normalise both shapes
              // so this works across versions.
              onChange={(e: unknown) => {
                const v =
                  typeof e === "string"
                    ? e
                    : (e as React.ChangeEvent<HTMLInputElement>)?.target?.value ?? "";
                row.onChange(v);
              }}
              placeholder={row.placeholder}
            />
          </div>
          <Button variant="default" onClick={row.onCopy} disabled={!row.value}>
            Copy
          </Button>
        </Flex>
      ))}
    </Flex>
  );
}

function MethodCaptureDraftPanel({
  className,
  methodName,
  spanKind,
  onClose,
}: {
  className: string | null;
  methodName: string | null;
  spanKind: string | null;
  onClose: () => void;
}) {
  type InputRow = { class: string; getter: string };
  type DraftState = {
    returnClass: string;
    returnGetter: string;
    inputs: InputRow[];
  };

  const storageKey = useMemo(() => {
    const c = (className ?? "").trim();
    const m = (methodName ?? "").trim();
    const k = (spanKind ?? "").trim();
    return `dt.dbm.captureDraft::${k}::${c}::${m}`;
  }, [className, methodName, spanKind]);

  const initial = useMemo<DraftState>(
    () => ({
      returnClass: "",
      returnGetter: "",
      inputs: [
        { class: "", getter: "" },
        { class: "", getter: "" },
      ],
    }),
    [],
  );

  const [state, setState] = useState<DraftState>(initial);

  // Load whenever the method signature (and therefore the storage key)
  // changes. The sheet is reused across methods, so this keeps each
  // method's draft isolated.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DraftState>;
        setState({
          returnClass: parsed.returnClass ?? "",
          returnGetter: parsed.returnGetter ?? "",
          inputs:
            Array.isArray(parsed.inputs) && parsed.inputs.length > 0
              ? parsed.inputs.map((r) => ({
                  class: r?.class ?? "",
                  getter: r?.getter ?? "",
                }))
              : initial.inputs,
        });
      } else {
        setState(initial);
      }
    } catch {
      setState(initial);
    }
  }, [storageKey, initial]);

  // Persist on every change. Failures (quota, disabled storage, SSR) are
  // swallowed — a missing draft is recoverable; an exception in the
  // render path is not.
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [storageKey, state]);

  const updateReturn = (field: "class" | "getter", value: string) => {
    setState((s) => ({
      ...s,
      ...(field === "class"
        ? { returnClass: value }
        : { returnGetter: value }),
    }));
  };
  const updateInput = (
    idx: number,
    field: "class" | "getter",
    value: string,
  ) => {
    setState((s) => {
      const next = [...s.inputs];
      next[idx] = { ...next[idx], [field]: value };
      return { ...s, inputs: next };
    });
  };
  const addInput = () => {
    setState((s) => ({
      ...s,
      inputs: [...s.inputs, { class: "", getter: "" }],
    }));
  };
  const removeInput = (idx: number) => {
    setState((s) => ({
      ...s,
      inputs: s.inputs.filter((_, i) => i !== idx),
    }));
  };
  const clearAll = () => setState(initial);

  const copy = (value: string) => {
    if (!value) return;
    try {
      void navigator.clipboard.writeText(value);
    } catch {
      // ignore — secure-context failures
    }
  };

  const heading = methodName
    ? `${className ? `${className}.` : ""}${methodName}()`
    : "this method";

  return (
    <Flex
      flexDirection="column"
      gap={12}
      padding={12}
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        background: Colors.Background.Container.Neutral.Default,
      }}
    >
      <Flex alignItems="center" justifyContent="space-between" gap={8}>
        <Flex flexDirection="column" gap={2}>
          <Text style={{ fontSize: "13px", fontWeight: 700 }}>
            Capture draft board
          </Text>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            Scratchpad for the values you'll paste into the Request
            attributes wizard. Saved in your browser, per method (
            <code>{heading}</code>), so you can keep digging through getters
            without losing track. Nothing here is sent to Dynatrace.
          </Text>
        </Flex>
        <Flex gap={8} alignItems="center" style={{ flexShrink: 0 }}>
          <Button variant="default" onClick={clearAll}>Clear all</Button>
          <Button variant="default" onClick={onClose}>Hide</Button>
        </Flex>
      </Flex>

      <DraftSection
        title="Return value"
        subtitle="The object the method returns, plus the getter that drills into the field you care about."
        rows={[
          {
            label: "Return variable class",
            value: state.returnClass,
            onChange: (v) => updateReturn("class", v),
            placeholder: "com.example.OrderResponse",
            onCopy: () => copy(state.returnClass),
          },
          {
            label: "Return variable getter",
            value: state.returnGetter,
            onChange: (v) => updateReturn("getter", v),
            placeholder: "getOrderTotal()",
            onCopy: () => copy(state.returnGetter),
          },
        ]}
      />

      {state.inputs.map((row, idx) => (
        <DraftSection
          key={idx}
          title={`Input variable ${idx + 1}`}
          subtitle={
            idx === 0
              ? "First argument passed into the method."
              : `Argument #${idx + 1} passed into the method.`
          }
          onRemove={
            state.inputs.length > 1 ? () => removeInput(idx) : undefined
          }
          rows={[
            {
              label: `Input variable ${idx + 1} class`,
              value: row.class,
              onChange: (v) => updateInput(idx, "class", v),
              placeholder: "com.example.OrderRequest",
              onCopy: () => copy(row.class),
            },
            {
              label: `Input variable ${idx + 1} getter`,
              value: row.getter,
              onChange: (v) => updateInput(idx, "getter", v),
              placeholder: "getCustomerId()",
              onCopy: () => copy(row.getter),
            },
          ]}
        />
      ))}

      <Flex>
        <Button variant="default" onClick={addInput}>
          + Add another input
        </Button>
      </Flex>
    </Flex>
  );
}

function NextStepsFlow({
  className,
  methodName,
  spanKind,
  serviceId,
  processGroupId,
  processGroupFallbackName,
  technology,
}: {
  className: string | null;
  methodName: string | null;
  spanKind: string | null;
  serviceId: string | null;
  processGroupId: string | null;
  processGroupFallbackName: string | null;
  technology: string | null;
}) {
  const settingsUrl = settingsDeepLink();
  const settingsDisabled = !className || !methodName;
  const [draftOpen, setDraftOpen] = useState(false);
  return (
    <Flex flexDirection="column" gap={0}>
      <StepRow
        num={1}
        total={4}
        title="Open Request attributes settings to search for the method signature"
        body={
          <>
            Open the native <Strong>Settings → Request attributes</Strong>{" "}
            wizard in a new tab. Use the values from{" "}
            <em>Required information</em> below to find this method:{" "}
            click <em>Add new data source</em>, pick the{" "}
            <Strong>Request attribute source</Strong>, select the{" "}
            <Strong>Process group</Strong>, paste the <Strong>Class name</Strong>{" "}
            into <em>Find entry point</em> and click Search, then pick the{" "}
            <Strong>Method name</Strong> from the matched list.
          </>
        }
        action={
          <Flex flexDirection="column" gap={8}>
            <Flex gap={8} alignItems="center" flexWrap="wrap">
              {/* Plain <a> so the app shell doesn't re-root the absolute URL */}
              <a
                href={settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                <Button variant="accent" type="button">
                  Open Settings → Request attributes
                </Button>
              </a>
              {settingsDisabled && (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  class + method name required
                </Text>
              )}
            </Flex>
            {/* Supporting info: the four values to paste into the wizard. */}
            <MethodSignatureDiscovery
              className={className}
              methodName={methodName}
              processGroupId={processGroupId}
              processGroupFallbackName={processGroupFallbackName}
              technology={technology}
            />
          </Flex>
        }
      />
      <StepRow
        num={2}
        total={4}
        title="Capture an input parameter or the return value"
        body={
          <>
            In <em>Select scope</em>, choose what to capture:
            <br />
            • <Strong>Input parameter</Strong> — set{" "}
            <Strong>Capture = Method argument</Strong> and pick an{" "}
            <Strong>Argument index</Strong>. If the argument is an object,
            add another data source on its <Strong>class name</Strong> and
            pick the right getter.
            <br />
            • <Strong>Return value</Strong> — set{" "}
            <Strong>Capture = Method return value</Strong>. If the return
            type is an object, add another data source on its{" "}
            <Strong>class name</Strong> and pick the right getter to drill
            into the field you care about.
          </>
        }
        action={
          <Flex flexDirection="column" gap={8}>
            <Flex gap={8} alignItems="center" flexWrap="wrap">
              <Button variant="default" onClick={() => setDraftOpen((v) => !v)}>
                {draftOpen ? "Hide draft board" : "Open draft board"}
              </Button>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                Scratchpad for class names + getters you uncover while exploring.
              </Text>
            </Flex>
            {draftOpen && (
              <MethodCaptureDraftPanel
                className={className}
                methodName={methodName}
                spanKind={spanKind}
                onClose={() => setDraftOpen(false)}
              />
            )}
          </Flex>
        }
      />
      <StepRow
        num={3}
        total={4}
        title="Save the rule"
        body={
          <>
            Click <Strong>Save changes</Strong>. OneAgent picks the rule up
            within ~60 s. A <Strong>restart is only needed</Strong> when the
            target class is already loaded and can't be re-transformed (wizard
            shows a yellow badge), the method is in a JDK / system class
            (<code>java.*</code>, <code>javax.*</code>, <code>sun.*</code>), or
            the technology is <Strong>.NET / PHP / Node.js / Go</Strong>.
          </>
        }
      />
      <StepRow
        num={4}
        total={4}
        title="Verify live capture"
        body={
          <>
            Query the last 15 min of <Strong>server-kind spans</Strong> on
            this service to confirm any captured-attribute values are
            flowing. Dynatrace persists Request Attribute / bizevent
            captures on the request entry span regardless of which method
            the extraction rule reads from, so this scan catches your new
            rule as soon as OneAgent picks it up. We check the three
            prefixes Dynatrace uses for span-level captures:{" "}
            <code>dt.request_attribute.*</code> (Request Attribute rules),{" "}
            <code>captured_attribute.*</code> (bizevent extraction) and{" "}
            <code>method.argument.*</code> (method-argument capture).
          </>
        }
        action={<LiveRequestAttributePreview className={className} methodName={methodName} spanKind={spanKind} serviceId={serviceId} />}
      />
    </Flex>
  );
}

// Renders the selected waterfall node as a method-detail card. Operates on
// the span data already loaded for the trace — no second DQL fetch. The
// "Parameters" and "Return value" sections look for OpenTelemetry / OneAgent
// conventional attribute names (code.parameters.*, *.arg.*, *return*); when
// nothing is found we surface a CTA pointing the user at the "Define request
// attribute" workflow so they can opt in to capturing those values.
function SpanDetailPanel({ node }: { node: WaterfallNode }) {
  const span = node.span;

  const groups = useMemo(() => {
    const params: Array<[string, unknown]> = [];
    const returns: Array<[string, unknown]> = [];
    const codeAttrs: Array<[string, unknown]> = [];
    const other: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(span)) {
      if (v === null || v === undefined || v === "") continue;
      const lower = k.toLowerCase();
      // Anything Dynatrace recognises as a span-level capture surface
      // (Request Attribute rule, bizevent extraction, or method-argument
      // capture) is treated as a "captured param" so the header chip and
      // the verifier stay in sync. Without this, a captured_attribute.*
      // value would render in `other` and the chip would stay at 0
      // even though we just confirmed a live capture below.
      if (
        lower.startsWith("dt.request_attribute.") ||
        lower.startsWith("captured_attribute.") ||
        lower.startsWith("method.argument.") ||
        lower.includes("parameter") ||
        /\barg\b|\bargs\b|\bparam\b/.test(lower)
      ) {
        params.push([k, v]);
      } else if (lower.includes("return")) {
        returns.push([k, v]);
      } else if (lower.startsWith("code.") || lower.startsWith("dt.code.")) {
        codeAttrs.push([k, v]);
      } else {
        other.push([k, v]);
      }
    }
    return { params, returns, codeAttrs, other };
  }, [span]);

  const fullClass = node.className;
  const fullMethod = node.methodName;
  const displayHeading = fullMethod
    ? `${fullClass ? `${fullClass}.` : ""}${fullMethod}()`
    : node.spanName;

  return (
    <Flex flexDirection="column" gap={16}>
      {/* Method details — header + code-level identity live in a single
          Surface so they read as one cohesive section. The header zone
          keeps its accent stripe to signal "this is the method we're
          drilling into"; the identity rows sit flush below, separated
          only by a subtle divider line. */}
      <Surface>
        <Flex flexDirection="column">
          {/* Header zone */}
          <Flex
            padding={12}
            gap={12}
            alignItems="center"
            style={{
              background: Colors.Background.Container.Neutral.Default,
              borderLeft: `3px solid ${Colors.Background.Container.Primary.Accent}`,
            }}
          >
            <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  color: Colors.Text.Neutral.Default,
                  fontSize: "10px",
                  fontWeight: 600,
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                }}
              >
                Method details
              </Text>
              <Text
                style={{
                  fontFamily: "monospace",
                  fontSize: "13px",
                  color: Colors.Text.Primary.Default,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={displayHeading}
              >
                <HighlightedText text={displayHeading} keywords={node.business.keywords} />
              </Text>
              <Flex gap={6} alignItems="center" flexWrap="wrap">
                {node.spanKind && <Chip color="neutral">{node.spanKind}</Chip>}
                <Chip color="neutral">{formatDurationNs(node.durationNs)}</Chip>
                {node.statusCode && (
                  <Chip color={node.statusCode >= 400 ? "critical" : "success"}>
                    HTTP {node.statusCode}
                  </Chip>
                )}
                {node.business.score > 0 && (
                  <Chip color={node.business.score >= 3 ? "success" : "warning"}>
                    {node.business.score >= 3 ? "★★★ business-relevant" : "★★☆ likely business"}
                  </Chip>
                )}
              </Flex>
            </Flex>
          </Flex>

          {/* Code-level identity — flush continuation of the header */}
          <Flex
            padding={16}
            flexDirection="column"
            gap={12}
            style={{ borderTop: `1px solid ${Colors.Border.Neutral.Default}` }}
          >
            <Text
              style={{
                color: Colors.Text.Neutral.Default,
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
              }}
            >
              Code-level identity
            </Text>
            <Flex flexDirection="column" gap={6}>
              <Flex gap={12} alignItems="baseline">
                <Text style={{ width: 130, color: Colors.Text.Neutral.Default, fontSize: "12px", fontWeight: 600 }}>
                  Class (full)
                </Text>
                <Text style={{ fontFamily: "monospace", fontSize: "13px" }}>
                  {fullClass ?? (
                    <em style={{ color: Colors.Text.Neutral.Default }}>
                      not available — span has no code.namespace
                    </em>
                  )}
                </Text>
              </Flex>
              <Flex gap={12} alignItems="baseline">
                <Text style={{ width: 130, color: Colors.Text.Neutral.Default, fontSize: "12px", fontWeight: 600 }}>
                  Method
                </Text>
                <Text style={{ fontFamily: "monospace", fontSize: "13px" }}>
                  {fullMethod ? `${fullMethod}()` : (
                    <em style={{ color: Colors.Text.Neutral.Default }}>
                      not available — span has no code.function
                    </em>
                  )}
                </Text>
              </Flex>
              <Flex gap={12} alignItems="baseline">
                <Text style={{ width: 130, color: Colors.Text.Neutral.Default, fontSize: "12px", fontWeight: 600 }}>
                  Span name
                </Text>
                <Text style={{ fontFamily: "monospace", fontSize: "13px" }}>
                  <HighlightedText text={node.spanName} keywords={node.business.keywords} />
                </Text>
              </Flex>
              {span["code.filepath"] && (
                <Flex gap={12} alignItems="baseline">
                  <Text style={{ width: 130, color: Colors.Text.Neutral.Default, fontSize: "12px", fontWeight: 600 }}>
                    Source file
                  </Text>
                  <Text style={{ fontFamily: "monospace", fontSize: "12px", color: Colors.Text.Neutral.Default }}>
                    {String(span["code.filepath"])}
                    {span["code.lineno"] !== undefined && `:${String(span["code.lineno"])}`}
                  </Text>
                </Flex>
              )}
            {node.endpointName && (
              <Flex gap={12} alignItems="baseline">
                <Text style={{ width: 130, color: Colors.Text.Neutral.Default, fontSize: "12px", fontWeight: 600 }}>
                  Endpoint
                </Text>
                <Text style={{ fontFamily: "monospace", fontSize: "12px" }}>
                  {node.endpointName}
                </Text>
              </Flex>
            )}
          </Flex>
        </Flex>
        </Flex>
      </Surface>

      {/* Business Metric Capture */}
      <Surface>
        <Flex padding={16} flexDirection="column" gap={12}>
          <Flex gap={8} alignItems="center">
            <Strong>Business Metric Capture</Strong>
            {(() => {
              const captured = groups.params.length + groups.returns.length;
              return (
                <Chip color={captured > 0 ? "success" : "neutral"}>
                  {captured} captured
                </Chip>
              );
            })()}
          </Flex>

          {/* If anything is already captured on this span, surface it
              FIRST so the user sees their progress at a glance. */}
          {(groups.params.length > 0 || groups.returns.length > 0) && (
            <Flex
              padding={12}
              flexDirection="column"
              gap={8}
              style={{
                background: Colors.Background.Container.Success.Default,
                borderLeft: `3px solid ${Colors.Background.Container.Success.Accent}`,
                borderRadius: 6,
              }}
            >
              <Flex gap={8} alignItems="center">
                <Text
                  style={{
                    color: Colors.Text.Neutral.Default,
                    fontSize: "10px",
                    fontWeight: 600,
                    letterSpacing: "0.5px",
                    textTransform: "uppercase",
                  }}
                >
                  Currently captured on this span
                </Text>
                <Chip color="success">
                  {groups.params.length + groups.returns.length} value
                  {groups.params.length + groups.returns.length === 1 ? "" : "s"}
                </Chip>
              </Flex>
              <Flex flexDirection="column" gap={6}>
                {[...groups.params, ...groups.returns].map(([k, v]) => {
                  const shortName = k.replace(
                    /^(dt\.request_attribute\.|captured_attribute\.|method\.argument\.)/,
                    "",
                  );
                  const value = String(v);
                  return (
                    <Flex key={k} gap={8} alignItems="center" flexWrap="wrap">
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: Colors.Text.Primary.Default,
                          fontWeight: 700,
                          minWidth: 200,
                        }}
                      >
                        {shortName}
                      </Text>
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: Colors.Text.Neutral.Default,
                        }}
                      >
                        =
                      </Text>
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: "12px",
                          color: Colors.Text.Primary.OnAccent.Default,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: Colors.Background.Container.Primary.Accent,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 360,
                        }}
                        title={value}
                      >
                        {value}
                      </Text>
                    </Flex>
                  );
                })}
              </Flex>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                Want to capture more? Use the steps below.
              </Text>
            </Flex>
          )}

          {/* Supporting info now lives inside Step 1, where it is actually
              used — see NextStepsFlow below. */}

          {/* Section heading + the actual wizard steps. */}
          <Flex flexDirection="column" gap={6}>
            <Text
              style={{
                color: Colors.Text.Neutral.Default,
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.5px",
                textTransform: "uppercase",
              }}
            >
              Steps to capture Business metrics
            </Text>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              Follow these four steps in the native Request attributes
              wizard to start capturing a value from{" "}
              <code>{fullMethod ?? "this method"}()</code>.
            </Text>
            <NextStepsFlow
              className={fullClass}
              methodName={fullMethod}
              spanKind={node.spanKind}
              serviceId={
                (span["dt.entity.service"] as string | undefined) ??
                (span["dt.smartscape.service"] as string | undefined) ??
                null
              }
              processGroupId={
                (span["dt.entity.process_group"] as string | undefined) ?? null
              }
              processGroupFallbackName={
                (span["dt.process_group.detected_name"] as string | undefined) ??
                (span["process.group.name"] as string | undefined) ??
                (span["dt.process.name"] as string | undefined) ??
                null
              }
              technology={
                (span["dt.agent.module.type"] as string | undefined) ??
                (span["telemetry.sdk.language"] as string | undefined) ??
                null
              }
            />
          </Flex>
        </Flex>
      </Surface>

      {/* All other span attributes */}
      {(groups.codeAttrs.length > 0 || groups.other.length > 0) && (
        <Surface>
          <Flex padding={16} flexDirection="column" gap={12}>
            <Accordion>
              <Accordion.Section id="span-attrs">
                <Accordion.SectionLabel>
                  All span attributes ({groups.codeAttrs.length + groups.other.length})
                </Accordion.SectionLabel>
                <Accordion.SectionContent>
                  <Flex flexDirection="column" gap={4} padding={8}>
                    {[...groups.codeAttrs, ...groups.other].map(([k, v]) => (
                      <Flex key={k} gap={12} alignItems="baseline">
                        <Text style={{ width: 240, fontFamily: "monospace", fontSize: "11px", color: Colors.Text.Neutral.Default, fontWeight: 600 }}>
                          {k}
                        </Text>
                        <Text style={{ fontFamily: "monospace", fontSize: "11px" }}>{String(v)}</Text>
                      </Flex>
                    ))}
                  </Flex>
                </Accordion.SectionContent>
              </Accordion.Section>
            </Accordion>
          </Flex>
        </Surface>
      )}
    </Flex>
  );
}

// Pick the colour stripe + label for a span's `kind` — mirrors the icons in
// the native Dynatrace trace waterfall.
function kindBadge(kind: string | null): { label: string; color: string } {
  switch ((kind ?? "").toLowerCase()) {
    case "server":
      return { label: "server", color: Colors.Charts.Categorical.Color01.Default };
    case "client":
      return { label: "client", color: Colors.Charts.Categorical.Color02.Default };
    case "internal":
      return { label: "internal", color: Colors.Charts.Categorical.Color03.Default };
    case "producer":
      return { label: "producer", color: Colors.Charts.Categorical.Color04.Default };
    case "consumer":
      return { label: "consumer", color: Colors.Charts.Categorical.Color05.Default };
    default:
      return { label: kind ?? "?", color: Colors.Border.Neutral.Default };
  }
}

// Single row in the waterfall — pure display, click target raises the
// selected span id to the parent.
function WaterfallRow({
  node,
  selected,
  onClick,
}: {
  node: WaterfallNode;
  selected: boolean;
  onClick: () => void;
}) {
  const badge = kindBadge(node.spanKind);
  const indentPx = node.depth * 22;
  const label = node.methodName
    ? `${node.className?.split(".").pop() ?? "?"}.${node.methodName}`
    : node.spanName;

  return (
    <Flex
      onClick={onClick}
      alignItems="center"
      gap={8}
      padding={8}
      style={{
        cursor: "pointer",
        background: selected
          ? Colors.Background.Container.Primary.Accent
          : "transparent",
        borderLeft: `3px solid ${selected ? badge.color : "transparent"}`,
        borderRadius: 4,
        transition: "background 80ms linear",
      }}
    >
      <div style={{ width: indentPx, flexShrink: 0 }} />
      <div
        style={{
          width: 6,
          height: 24,
          background: badge.color,
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
      <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Flex gap={8} alignItems="center" flexWrap="wrap">
          <Text
            style={{
              fontFamily: "monospace",
              fontSize: "12px",
              fontWeight: 600,
              color: selected
                ? Colors.Text.Primary.OnAccent.Default
                : Colors.Text.Primary.Default,
            }}
          >
            <HighlightedText text={label} keywords={node.business.keywords} />
          </Text>
          {node.business.score > 0 && (
            <Chip color={node.business.score >= 3 ? "success" : "warning"}>
              {node.business.score >= 3 ? "★★★" : "★★☆"}
            </Chip>
          )}
        </Flex>
        {node.className && node.methodName && (
          <Text
            style={{
              fontFamily: "monospace",
              fontSize: "10px",
              color: selected
                ? Colors.Text.Primary.OnAccent.Default
                : Colors.Text.Neutral.Default,
            }}
          >
            {node.className}
          </Text>
        )}
      </Flex>
      <Chip color="neutral">{badge.label}</Chip>
      <Text
        style={{
          fontFamily: "monospace",
          fontSize: "11px",
          width: 80,
          textAlign: "right",
          color: selected
            ? Colors.Text.Primary.OnAccent.Default
            : Colors.Text.Neutral.Default,
        }}
      >
        {formatDurationNs(node.durationNs)}
      </Text>
    </Flex>
  );
}

function InvestigateMethodsSheet({
  show,
  serviceName,
  serviceId,
  route,
  httpMethod,
  candidates,
  onClose,
}: {
  show: boolean;
  serviceName: string;
  serviceId: string;
  route: string;
  httpMethod: string | null;
  candidates: MethodCandidate[];
  onClose: () => void;
}) {
  // Fallback exemplar from the candidate list, used while the dedicated
  // sample-traces query is still in flight (or if it returns nothing).
  // Prefer a server-kind candidate so the entry-point root is in scope.
  const fallbackTraceId = useMemo(() => {
    const serverCand = candidates.find(
      (c) =>
        !!c.example_trace_id &&
        (c.span_kind ?? "").toLowerCase() === "server",
    );
    if (serverCand?.example_trace_id) return serverCand.example_trace_id;
    return candidates.find((c) => !!c.example_trace_id)?.example_trace_id ?? null;
  }, [candidates]);

  // Pull up to 5 recent representative trace ids for this endpoint so the
  // user can navigate between samples — useful when one trace is missing
  // spans or shows an unusual code path.
  const samplesQuery =
    show && serviceId && route
      ? buildTraceSamplesQuery(serviceId, route)
      : "fetch spans | limit 0";
  const { data: samplesData, isLoading: samplesLoading } = useDql({
    query: samplesQuery,
  });
  const sampleTraceIds = useMemo<string[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records = (samplesData as { records?: Array<Record<string, any>> } | undefined)?.records;
    if (!records) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      const id = spanIdToHex(r.trace_id ?? r["trace.id"]);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    // Make sure the candidate-derived fallback is selectable too, in case
    // the samples query missed it (different recency window or filter).
    if (fallbackTraceId && !seen.has(fallbackTraceId)) {
      ids.push(fallbackTraceId);
    }
    return ids.slice(0, 5);
  }, [samplesData, fallbackTraceId]);

  // Currently displayed trace index within sampleTraceIds (or -1 when we
  // fall back to the candidate-derived id while samples are loading).
  const [traceIdx, setTraceIdx] = useState(0);

  // Reset to the first sample whenever the sheet opens against a new
  // endpoint, or when the sample list arrives / changes shape.
  useEffect(() => {
    setTraceIdx(0);
  }, [route, serviceId]);
  useEffect(() => {
    if (traceIdx >= sampleTraceIds.length && sampleTraceIds.length > 0) {
      setTraceIdx(0);
    }
  }, [sampleTraceIds, traceIdx]);

  const traceId = sampleTraceIds[traceIdx] ?? fallbackTraceId;

  // Settings toggle: when true, SQL/DB framework methods
  // (DbCommand.ExecuteReader, SqlCe*, etc.) are scored normally instead
  // of being suppressed. They typically pick up business keywords from
  // the SQL statement embedded in span.name.
  const [{ allowSqlMethods }] = useUserSettings();

  const query = traceId
    ? buildTraceWaterfallQuery(traceId)
    : "fetch spans | limit 0";
  const { data, isLoading, error } = useDql({ query });

  const rows = useMemo<WaterfallNode[]>(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records = (data as { records?: Array<Record<string, any>> } | undefined)?.records;
    if (!records || records.length === 0) return [];
    return buildWaterfallRows(records, { allowSql: allowSqlMethods });
  }, [data, allowSqlMethods]);

  // Locate the endpoint root span — the topmost span in this trace whose
  // `endpoint.name` matches our route AND has kind=server. That's the
  // entry point for *this* endpoint. Subsequent server spans on the trace
  // belong to downstream services and are filtered out of the default view.
  const endpointRootId = useMemo<string | null>(() => {
    if (rows.length === 0) return null;
    const normRoute = route.trim().toLowerCase();
    const matchesRoute = (n: WaterfallNode) =>
      !!n.endpointName && n.endpointName.trim().toLowerCase() === normRoute;
    // Strongest match: server span on this exact endpoint.
    const serverHit = rows.find(
      (r) => matchesRoute(r) && (r.spanKind ?? "") === "server",
    );
    if (serverHit) return serverHit.spanId;
    // Any span tagged with our endpoint.name.
    const anyHit = rows.find(matchesRoute);
    if (anyHit) return anyHit.spanId;
    // Last resort: the first server-kind span (could be the trace root).
    const anyServer = rows.find((r) => (r.spanKind ?? "") === "server");
    return anyServer?.spanId ?? rows[0].spanId;
  }, [rows, route]);

  // BFS from endpointRoot down through children — produces the set of span
  // ids that belong to "this endpoint's slice of the trace".
  const subtreeIds = useMemo<Set<string>>(() => {
    if (!endpointRootId) return new Set();
    const childrenOf = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.parentId) continue;
      const arr = childrenOf.get(r.parentId) ?? [];
      arr.push(r.spanId);
      childrenOf.set(r.parentId, arr);
    }
    const out = new Set<string>();
    const stack: string[] = [endpointRootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      const kids = childrenOf.get(id) ?? [];
      for (const k of kids) stack.push(k);
    }
    return out;
  }, [rows, endpointRootId]);

  // Toggle — default OFF, i.e. start with the endpoint-scoped subtree.
  const [showFullTrace, setShowFullTrace] = useState(false);

  // Rows actually rendered. In subtree mode we re-base depth so the
  // endpoint root sits at depth 0 (otherwise the indent would start
  // wherever the endpoint root happened to be in the parent trace).
  const visibleRows = useMemo<WaterfallNode[]>(() => {
    if (showFullTrace || subtreeIds.size === 0) return rows;
    const rootDepth = rows.find((r) => r.spanId === endpointRootId)?.depth ?? 0;
    return rows
      .filter((r) => subtreeIds.has(r.spanId))
      .map((r) =>
        r.depth === rootDepth
          ? r
          : { ...r, depth: Math.max(0, r.depth - rootDepth) },
      )
      // The first filtered row may not be at depth 0 if cloning preserved
      // depth; ensure root is normalised.
      .map((r) =>
        r.spanId === endpointRootId ? { ...r, depth: 0 } : r,
      );
  }, [rows, showFullTrace, subtreeIds, endpointRootId]);

  const businessRowsCount = useMemo(
    () => visibleRows.filter((r) => r.business.score > 0).length,
    [visibleRows],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Auto-select the endpoint root (or first business-relevant span in the
  // visible slice) whenever the data lands or the toggle flips.
  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && visibleRows.some((r) => r.spanId === selectedId)) return;
    const rootInView = visibleRows.find((r) => r.spanId === endpointRootId);
    const best =
      visibleRows.find((r) => r.business.score > 0) ?? rootInView ?? visibleRows[0];
    setSelectedId(best.spanId);
  }, [visibleRows, selectedId, endpointRootId]);

  // Reset selection when the sheet closes so the next open re-picks.
  useEffect(() => {
    if (!show) {
      setSelectedId(null);
      setShowFullTrace(false);
    }
  }, [show]);

  const selectedNode = visibleRows.find((r) => r.spanId === selectedId) ?? null;

  return (
    <Sheet
      show={show}
      title={`Trace waterfall — ${httpMethod ?? "ANY"} ${route}`}
      onDismiss={onClose}
      actions={
        <Button variant="emphasized" onClick={onClose}>Close</Button>
      }
    >
      <Flex flexDirection="column" gap={16} padding={16}>
        {/* Context strip */}
        <Flex
          padding={12}
          gap={12}
          alignItems="center"
          flexWrap="wrap"
          style={{
            background: Colors.Background.Container.Neutral.Default,
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <CodeIcon style={{ color: Colors.Text.Primary.Default }} />
          <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontWeight: 700, fontSize: "13px" }}>
              {showFullTrace ? "Full trace" : "Endpoint subtree"} under{" "}
              <Strong>{serviceName}</Strong> for <Strong>{route}</Strong>
            </Text>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              {showFullTrace
                ? "Every span across every service in this trace — including upstream callers and downstream dependencies."
                : "Only the spans inside this endpoint (entry-point server span + all its descendants). Toggle below to see upstream and downstream spans."}
              {" "}Click any row to inspect that method&apos;s class, parameters and return value.
            </Text>
            {traceId && (
              <Flex gap={8} alignItems="center" flexWrap="wrap">
                {/* Sample-trace navigator. Lets the user step through up
                    to 5 recent representative traces in case the first one
                    is missing spans or follows an unusual code path. */}
                {sampleTraceIds.length > 1 && (
                  <Flex
                    gap={4}
                    alignItems="center"
                    style={{
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      borderRadius: 4,
                      padding: "2px 4px",
                      background: Colors.Background.Container.Neutral.Default,
                    }}
                  >
                    <Button
                      variant="default"
                      onClick={() =>
                        setTraceIdx((i) =>
                          (i - 1 + sampleTraceIds.length) % sampleTraceIds.length,
                        )
                      }
                    >
                      ‹
                    </Button>
                    <Text
                      style={{
                        color: Colors.Text.Neutral.Default,
                        fontSize: "11px",
                        minWidth: 70,
                        textAlign: "center",
                      }}
                    >
                      Trace {Math.min(traceIdx, sampleTraceIds.length - 1) + 1} of{" "}
                      {sampleTraceIds.length}
                    </Text>
                    <Button
                      variant="default"
                      onClick={() =>
                        setTraceIdx((i) => (i + 1) % sampleTraceIds.length)
                      }
                    >
                      ›
                    </Button>
                  </Flex>
                )}
                {samplesLoading && sampleTraceIds.length === 0 && (
                  <Text
                    style={{
                      color: Colors.Text.Neutral.Default,
                      fontSize: "11px",
                    }}
                  >
                    loading sample traces…
                  </Text>
                )}
                <Text
                  style={{
                    fontFamily: "monospace",
                    fontSize: "10px",
                    color: Colors.Text.Neutral.Default,
                  }}
                >
                  trace.id = {traceId}
                </Text>
              </Flex>
            )}
          </Flex>
          <Flex gap={8} alignItems="center" flexWrap="wrap">
            <Chip color="success">
              <Strong>{businessRowsCount}</Strong>&nbsp;business spans
            </Chip>
            <Chip color="neutral">
              <Strong>{visibleRows.length}</Strong>
              {showFullTrace ? "" : ` of ${rows.length}`}&nbsp;spans
            </Chip>
          </Flex>
        </Flex>

        {/* Scope toggle */}
        {rows.length > 0 && subtreeIds.size > 0 && subtreeIds.size < rows.length && (
          <Flex justifyContent="flex-end" alignItems="center">
            <Switch
              value={showFullTrace}
              onChange={(v) => setShowFullTrace(v)}
              name="waterfall-show-full-trace"
            >
              Show full trace ({rows.length - subtreeIds.size} extra spans outside this endpoint)
            </Switch>
          </Flex>
        )}

        {/* Status / loading */}
        {!traceId && (
          <Surface>
            <Flex padding={16} gap={8} alignItems="center">
              <WarningIcon style={{ color: Colors.Text.Warning.Default }} />
              <Paragraph>
                No example trace id was captured for this endpoint. Re-run the
                discovery once fresh traffic has flowed through this endpoint.
              </Paragraph>
            </Flex>
          </Surface>
        )}
        {traceId && isLoading && (
          <Surface>
            <Flex padding={16}>
              <Text style={{ color: Colors.Text.Neutral.Default }}>
                Loading trace spans…
              </Text>
            </Flex>
          </Surface>
        )}
        {traceId && error && (
          <Surface>
            <Flex padding={16} gap={8} alignItems="center" style={{ color: Colors.Text.Critical.Default }}>
              <CriticalIcon />
              <Paragraph>{error.message}</Paragraph>
            </Flex>
          </Surface>
        )}

        {/* Waterfall + selected detail */}
        {traceId && !isLoading && !error && visibleRows.length > 0 && (
          <>
            {/* Bordered wrapper marks the waterfall as the primary content
                area; the Method details panel beneath it then naturally
                reads as supporting context for the selected row. */}
            <Flex
              flexDirection="column"
              style={{
                border: `2px solid ${Colors.Border.Primary.Default}`,
                borderRadius: 8,
                background: Colors.Background.Surface.Default,
              }}
            >
              <Flex
                padding={8}
                gap={8}
                alignItems="center"
                style={{
                  borderBottom: `1px solid ${Colors.Border.Neutral.Default}`,
                  background: Colors.Background.Container.Neutral.Subdued,
                  borderRadius: "6px 6px 0 0",
                }}
              >
                <Text
                  style={{
                    color: Colors.Text.Neutral.Default,
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.5px",
                    textTransform: "uppercase",
                  }}
                >
                  Trace waterfall
                </Text>
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                  · click any row to inspect it below
                </Text>
              </Flex>
              <Flex padding={8} flexDirection="column" gap={2}>
                {visibleRows.map((node) => (
                  <WaterfallRow
                    key={node.spanId}
                    node={node}
                    selected={node.spanId === selectedId}
                    onClick={() => setSelectedId(node.spanId)}
                  />
                ))}
              </Flex>
            </Flex>

            {selectedNode && <SpanDetailPanel node={selectedNode} />}
          </>
        )}

        {traceId && !isLoading && !error && visibleRows.length === 0 && (
          <Surface>
            <Flex padding={16}>
              <Paragraph>No spans recorded for this trace.</Paragraph>
            </Flex>
          </Surface>
        )}

        {/* `candidates` is intentionally unused in the rendered output now —
            this comment keeps the linter quiet about the prop. */}
        <span style={{ display: "none" }}>{candidates.length}</span>
      </Flex>
    </Sheet>
  );
}

// ─── Service Detail (with own DQL hooks) ─────────────────────────────────────────

function ServiceDetail({ service }: { service: ServiceRecord }) {
  const { data: endpointsData, isLoading: endpointsLoading, error: endpointsError } = useDql({
    query: buildEndpointsQuery(service.service_id),
  });
  // Per-endpoint span scan. Replaces the older global `buildMethodsQuery`
  // result so the Investigate Methods sheet can show methods scoped to a
  // single endpoint instead of a service-wide blob.
  const { data: methodsData, isLoading: methodsLoading, error: methodsError } = useDql({
    query: buildEndpointMethodsQuery(service.service_id),
  });

  const [{ allowSqlMethods, includeCrossServiceDescendants, keywordCategories, nonBusinessPhrases }] = useUserSettings();
  const endpoints = useMemo(
    () => scoreEndpoints(parseEndpoints(endpointsData)),
    [endpointsData, keywordCategories, nonBusinessPhrases],
  );
  const methodsByEndpoint = useMemo(
    () => {
      const parsed = parseEndpointMethods(methodsData);
      const subtree = filterToEndpointSubtree(parsed);
      // When the cross-service descendants setting is OFF (default), keep
      // only spans whose owning service matches this service — BFS-
      // filtered to the endpoint's subtree for precision.
      //
      // When ON, use the FULL parsed set (skip the BFS subtree filter).
      // The subtree BFS relies on every intermediate span being present
      // to walk the parent_id chain, but cross-service descendants often
      // hang off HTTP client spans that the outer-fetch limit may have
      // truncated, breaking the chain mid-way and silently hiding the
      // downstream business spans (e.g. `BookingService.storeBooking`
      // called by `easytravel-frontend-java` into `easytravel-business-
      // java`). Falling back to all rep-trace spans guarantees those
      // descendants surface; the trace-level join already restricts
      // them to the 5 rep traces of this endpoint so we don't pull in
      // unrelated spans.
      const scoped = includeCrossServiceDescendants
        ? parsed
        : subtree.filter((r) => !r.service_id || r.service_id === service.service_id);
      const ownerServiceIds = new Set<string>();
      if (service.service_id) ownerServiceIds.add(service.service_id);
      if (service.entity_id) ownerServiceIds.add(service.entity_id);
      const subtreeSpanIds = new Set<string>(
        subtree.map((r) => r.span_id).filter((id): id is string => Boolean(id)),
      );
      return groupMethodCandidates(scoped, {
        allowSql: allowSqlMethods,
        ownerServiceIds,
        subtreeSpanIds,
      });
    },
    [methodsData, allowSqlMethods, includeCrossServiceDescendants, service.service_id, service.entity_id, keywordCategories, nonBusinessPhrases],
  );

  // Aggregate counts shown in the service header. The methods table the
  // user sees deduplicates by method signature across the whole service —
  // the same method that runs inside three different endpoints shows up
  // as one row. We mirror that here so the header chip ("X method
  // candidates / Y spans") matches the visible row count exactly,
  // instead of summing per-endpoint occurrences (which double- or
  // triple-counted shared methods and produced a higher number than
  // the tab).
  const totalMethodSpans = useMemo(() => {
    const seen = new Set<string>();
    for (const list of methodsByEndpoint.values()) {
      for (const m of list) seen.add(m.displayName);
    }
    return seen.size;
  }, [methodsByEndpoint]);
  const businessMethodCandidates = useMemo(() => {
    const seen = new Set<string>();
    for (const list of methodsByEndpoint.values()) {
      for (const m of list) {
        if (m.score > 0) seen.add(m.displayName);
      }
    }
    return seen.size;
  }, [methodsByEndpoint]);

  const highConfidenceCount = endpoints.filter((e) => e.confidence === "high").length;

  return (
    <Flex flexDirection="column" style={{ flex: 1, minWidth: 0 }}>
      {/* Service Header */}
      <Flex
        padding={20}
        gap={16}
        alignItems="center"
        style={{
          background: `linear-gradient(135deg, ${Colors.Background.Container.Primary.Accent} 0%, ${Colors.Background.Container.Primary.Default} 100%)`,
          borderRadius: "6px 6px 0 0",
          borderBottom: `2px solid ${Colors.Background.Container.Primary.Accent}`,
          boxShadow: `inset 0 -1px 0 ${Colors.Background.Container.Primary.Accent}`,
        }}
      >
        <Flex flexDirection="column" gap={6} style={{ flex: 1 }}>
          <Heading level={3} style={{ color: Colors.Text.Primary.OnAccent.Default, margin: 0 }}>
            {service.service_name}
          </Heading>
          <Flex gap={8} flexWrap="wrap">
            <Chip color="neutral">{service.total_spans.toLocaleString()} requests (30m)</Chip>
            <Chip color="primary">{endpoints.length} endpoints</Chip>
            <Chip color="warning">
              {businessMethodCandidates} method candidate{businessMethodCandidates === 1 ? "" : "s"}
              {totalMethodSpans > 0 && ` / ${totalMethodSpans} spans`}
            </Chip>
            {service.technology && (
              <Chip color="neutral">{service.technology}</Chip>
            )}
            {highConfidenceCount > 0 && (
              <Chip color="success">{highConfidenceCount} high-confidence endpoints</Chip>
            )}
          </Flex>
        </Flex>
      </Flex>

      {/* Endpoints with HTTP params + method candidate columns */}
      <Surface style={{ flex: 1, borderRadius: "0 0 4px 4px" }}>
        <EndpointsExplorer
          endpoints={endpoints}
          methodsByEndpoint={methodsByEndpoint}
          endpointsLoading={endpointsLoading}
          endpointsError={endpointsError}
          methodsLoading={methodsLoading}
          methodsError={methodsError}
          serviceName={service.service_name}
          serviceId={service.service_id}
        />
      </Surface>
    </Flex>
  );
}

// ─── Services Panel ───────────────────────────────────────────────────────────

function ServicesPanel({
  services,
  isLoading,
  error,
  searchQuery,
  onSearchChange,
  selectedServiceId,
  onServiceSelect,
  endpointScan,
  isScanning,
  signalFilters,
}: {
  services: ServiceRecord[];
  isLoading: boolean;
  error?: Error | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedServiceId: string | null;
  onServiceSelect: (s: ServiceRecord) => void;
  endpointScan: Array<{ service_ids: string[]; service_id: string; route: string }>;
  isScanning: boolean;
  // Optional fleet-wide signal filter set. When non-empty, services
  // whose endpoint keywords don't intersect this set are hidden —
  // driven by the toggleable chips on the Business signals row.
  signalFilters: Set<string>;
}) {
  // Toggle: hide services that have zero business-relevant endpoints.
  // Off by default to keep the full picture.
  const [candidatesOnly, setCandidatesOnly] = useState(false);

  // Subscribed for keyword-catalog edits — keeps the candidate count
  // reactive to the Manage business signals editor.
  const [{ keywordCategories, nonBusinessPhrases }] = useUserSettings();

  // Per-service business-candidate count. Derived from the global endpoint
  // scan (route names only) using the same `scoreMethodLike` rules used
  // everywhere else (Client suppression, get*ById boost, business
  // keywords). A route counts as a business candidate when its score is
  // >= 1 — i.e. it has at least medium confidence.
  //
  // Each scan row carries every known ID for its owning service
  // (smartscape + classic entity). We increment the count under EVERY
  // ID so the lookup matches regardless of which dimension the
  // services[] entry was keyed under — fixes SOAP/Axis services like
  // EasytravelService that report 0 candidates when the metric rows
  // only carry the classic entity ID.
  const businessCandidatesByService = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of endpointScan) {
      const { score } = scoreMethodLike(null, row.route, null);
      if (score >= 1) {
        for (const id of row.service_ids) {
          m.set(id, (m.get(id) ?? 0) + 1);
        }
      }
    }
    return m;
  }, [endpointScan, keywordCategories, nonBusinessPhrases]);

  // Per-service distinct keyword set. Used by the Business signals
  // toggle filter on StatsBar — a service passes when any of its
  // endpoint keywords are in `signalFilters`. Same multi-ID keying as
  // above so SOAP/Axis services aren't silently filtered out.
  const signalKeywordsByService = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const row of endpointScan) {
      const { keywords } = scoreMethodLike(null, row.route, null);
      if (keywords.length === 0) continue;
      for (const id of row.service_ids) {
        let set = m.get(id);
        if (!set) {
          set = new Set();
          m.set(id, set);
        }
        for (const kw of keywords) set.add(kw);
      }
    }
    return m;
  }, [endpointScan, keywordCategories, nonBusinessPhrases]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const matched = services.filter((s) => {
      if (q && !s.service_name.toLowerCase().includes(q)) return false;
      if (candidatesOnly) {
        if ((businessCandidatesByService.get(s.service_id) ?? 0) === 0) return false;
      }
      if (signalFilters.size > 0) {
        const svcKeywords = signalKeywordsByService.get(s.service_id);
        if (!svcKeywords) return false;
        let any = false;
        for (const f of signalFilters) {
          if (svcKeywords.has(f)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
      return true;
    });
    // Sort by candidacy bucket so users see the most promising services
    // first: strong (3+ business-keyword endpoints) \u2192 possible (1\u20132) \u2192
    // not a candidate (0). Within a bucket we preserve the upstream order
    // (total_spans desc from SERVICES_QUERY) so high-traffic services stay
    // near the top. While the scan is still loading every service reports
    // 0 \u2192 the list stays in its incoming order, which is what we want.
    const bucket = (s: ServiceRecord): number => {
      const n = businessCandidatesByService.get(s.service_id) ?? 0;
      if (n >= 3) return 0;
      if (n >= 1) return 1;
      return 2;
    };
    return matched
      .map((s, i) => ({ s, i, b: bucket(s) }))
      .sort((a, b) => a.b - b.b || a.i - b.i)
      .map((x) => x.s);
  }, [services, searchQuery, candidatesOnly, businessCandidatesByService, signalFilters, signalKeywordsByService]);

  // Candidacy verdict per service. Buckets the business-candidate count
  // (computed above) into three plain-English labels so users can scan the
  // left list and decide where to start without opening every service.
  //   strong candidate    — 3+ business-keyword endpoints
  //   possible candidate  — 1 or 2 business-keyword endpoints
  //   not a candidate     — zero business-keyword endpoints
  // While the global scan is still loading we don't pretend we know;
  // a neutral "scanning…" chip is rendered instead.
  const candidateRating = (s: ServiceRecord) => {
    if (isScanning && endpointScan.length === 0) {
      return { label: "scanning…", color: "neutral" as const };
    }
    // Try Smartscape ID first, then fall back to the classic entity ID
    // — see candidateCountFor in `filtered` above for context.
    const n =
      businessCandidatesByService.get(s.service_id) ??
      (s.entity_id ? businessCandidatesByService.get(s.entity_id) : undefined) ??
      0;
    if (n >= 3) return { label: "strong candidate", color: "success" as const };
    if (n >= 1) return { label: "possible candidate", color: "warning" as const };
    return { label: "not a candidate", color: "neutral" as const };
  };

  const columns = useMemo<DataTableColumnDef<ServiceRecord>[]>(
    () => [
      {
        id: "service_name",
        header: "Service",
        accessor: "service_name",
        cell: ({ value, rowData }: { value: string; rowData: ServiceRecord }) => {
          const rating = candidateRating(rowData);
          const isActive = rowData.service_id === selectedServiceId;
          return (
            <Flex
              flexDirection="column"
              gap={8}
              padding={8}
              style={{
                // Left accent stripe shows selection at a glance and pulls the
                // eye through the otherwise borderless list.
                borderLeft: `3px solid ${
                  isActive
                    ? Colors.Background.Container.Primary.Accent
                    : "transparent"
                }`,
                paddingLeft: 12,
              }}
            >
              <Text style={{ fontWeight: 600, fontSize: "13px", lineHeight: "1.3" }}>{value}</Text>
              <Flex gap={6} alignItems="center" flexWrap="wrap">
                {/* White pill: raw endpoint count, neutral & scannable */}
                <Chip color="neutral">
                  <Strong>{rowData.http_endpoints}</Strong>&nbsp;endpoints
                </Chip>
                {/* Star rating: same vocabulary as the HTTP parameters column */}
                <Chip color={rating.color}>{rating.label}</Chip>
                {rowData.method_spans > 0 && (
                  <Chip color="primary">{rowData.method_spans} methods</Chip>
                )}
              </Flex>
            </Flex>
          );
        },
      },
    ],
    // candidateRating closes over businessCandidatesByService + isScanning,
    // so the columns memo MUST invalidate whenever either changes \u2014 otherwise
    // every row keeps rendering its first-paint "scanning\u2026" chip until the
    // user clicks a service (which flips selectedServiceId and forces a
    // rebuild as a side effect).
    [selectedServiceId, businessCandidatesByService, isScanning],
  );

  return (
    <Flex
      flexDirection="column"
      gap={8}
      style={{ width: 380, minWidth: 380, flexShrink: 0 }}
    >
      <TextInput
        value={searchQuery}
        onChange={(e) => onSearchChange(typeof e === "string" ? e : (e as React.ChangeEvent<HTMLInputElement>).target?.value ?? "")}
        placeholder="Search services..."
      />
      <Flex justifyContent="space-between" alignItems="center" gap={8}>
        <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
          {filtered.length} of {services.length} services
        </Text>
        <Switch
          value={candidatesOnly}
          onChange={(v) => setCandidatesOnly(v)}
          name="services-candidates-only"
        >
          Candidates only
        </Switch>
      </Flex>
      <Surface style={{ flex: 1 }}>
        <DataTable
          data={filtered}
          columns={columns}
          loading={isLoading}
          fullWidth
          interactiveRows
          activeRow={selectedServiceId}
          onActiveRowChange={(id) => {
            const svc = services.find((s) => s.service_id === id);
            if (svc) onServiceSelect(svc);
          }}
          rowId={(row) => row.service_id}
          variant={{ headers: "hidden", rowDensity: "comfortable" }}
        >
          <DataTable.EmptyState>
            <Flex padding={16} flexDirection="column" gap={8}>
              {error ? (
                <>
                  <Paragraph><Strong>Query failed:</Strong> {error.message}</Paragraph>
                  <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                    Ensure the app has <Strong>storage:metrics:read</Strong> scope accepted in this environment.
                  </Paragraph>
                </>
              ) : (
                <>
                  <Paragraph>No OneAgent-monitored services found in the last 30 minutes.</Paragraph>
                  <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                    The list filters on <Strong>dt.agent.module.type</Strong> being set on
                    <Strong> dt.service.request.count</Strong>. Make sure
                    <Strong> storage:metrics:read</Strong> is accepted and OneAgent services are active.
                  </Paragraph>
                </>
              )}
            </Flex>
          </DataTable.EmptyState>
        </DataTable>
      </Surface>
    </Flex>
  );
}

// ─── Summary Stats Bar ────────────────────────────────────────────────────────

function StatsBar({
  services,
  endpointScan,
  isScanning,
  methodScan,
  isScanningMethods,
  methodScanError,
  allowSqlMethods,
  view,
  onViewChange,
  onOpenSignals,
  signalFilters,
  onToggleSignal,
  onClearSignalFilters,
}: {
  services: ServiceRecord[];
  endpointScan: Array<{ service_ids: string[]; service_id: string; route: string }>;
  isScanning: boolean;
  methodScan: Array<{ class_name: string | null; method_name: string | null; span_name: string | null }>;
  isScanningMethods: boolean;
  methodScanError: Error | null;
  allowSqlMethods: boolean;
  // Currently rendered view below the stats bar. Each card highlights when
  // it matches and clicking a card swaps the view in-place.
  view: DiscoveryView;
  onViewChange: (next: DiscoveryView) => void;
  // Opens the Manage business signals editor sheet. Surfaced inline on
  // the "Business signals detected" row so users can curate the catalog
  // without first opening the Settings sheet.
  onOpenSignals: () => void;
  // Active signal filter set. When non-empty, the services list (and
  // any downstream view that subscribes to it) restricts itself to rows
  // whose endpoint keywords intersect this set. Chips in the Business
  // signals row reflect the toggle state visually: selected = outlined,
  // unselected-while-others-on = dimmed.
  signalFilters: Set<string>;
  onToggleSignal: (kw: string) => void;
  onClearSignalFilters: () => void;
}) {
  // Subscribed for keyword-catalog edits — keeps the headline stats
  // reactive to the Manage business signals editor.
  const [{ keywordCategories, nonBusinessPhrases }] = useUserSettings();

  // Derive global candidate signals: how many endpoint names look like
  // business candidates, how many services those candidates cover, and which
  // business keywords landed the matches (sorted by frequency).
  const scan = useMemo(() => {
    // The global endpoint scan deliberately drops the OneAgent-only DQL
    // filter to avoid losing SOAP per-operation rows (see
    // GLOBAL_ENDPOINTS_QUERY comments). To keep the headline counts
    // tight we filter client-side against the known OneAgent services
    // list — OTel rows that leaked through the query but don't match
    // a service in services[] are excluded from these aggregates.
    const knownServiceIds = new Set<string>();
    for (const s of services) knownServiceIds.add(s.service_id);
    const keywordHits = new Map<string, number>();
    const candidateServices = new Set<string>();
    let candidateEndpoints = 0;
    let totalEndpointsScanned = 0;
    for (const row of endpointScan) {
      // Skip endpoint rows whose owning service isn't in the OneAgent
      // services list — they'd never be displayed anyway.
      if (!row.service_ids.some((id) => knownServiceIds.has(id))) continue;
      totalEndpointsScanned++;
      const { score, keywords } = scoreMethodLike(null, row.route, null);
      if (score >= 1) {
        candidateEndpoints++;
        // Use a single canonical id per row so the same service
        // isn't counted twice when both smartscape and classic IDs
        // are present. `service_id` is already the first non-empty
        // ID (smartscape preferred) from the parser.
        candidateServices.add(row.service_id);
        for (const kw of keywords) {
          keywordHits.set(kw, (keywordHits.get(kw) ?? 0) + 1);
        }
      }
    }
    const sortedKeywords = [...keywordHits.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    // Show the top 8 by frequency, but always pin the synthetic `byId`
    // pseudo-keyword if it was detected at all. It's surfaced by
    // scoreMethodLike for `get*ById` routes (e.g. `getJourneyById`) and
    // typically appears once per service \u2014 high-traffic generic
    // keywords like `booking` or `account` would otherwise push it past
    // the 8-chip cutoff and hide a strong identity signal.
    const top = sortedKeywords.slice(0, 8);
    const byIdEntry = sortedKeywords.find(([k]) => k === "byId");
    if (byIdEntry && !top.some(([k]) => k === "byId")) {
      top.push(byIdEntry);
    }
    const topKeywords = top;
    return {
      candidateEndpoints,
      totalEndpointsScanned,
      candidateServices: candidateServices.size,
      topKeywords,
    };
  }, [endpointScan, services, keywordCategories, nonBusinessPhrases]);

  const totalServices = services.length;
  const candidatePct =
    scan.totalEndpointsScanned > 0
      ? Math.round((scan.candidateEndpoints / scan.totalEndpointsScanned) * 100)
      : 0;

  // Global method-span scan summary. Honours the SQL methods toggle so
  // SqlCeTransaction.Commit / DbCommand.ExecuteReader etc. only count
  // when the user has explicitly opted them in via the Settings sheet.
  //
  // Deduplicates by (class_name, method_name) when counting candidates
  // so the stat-card matches the "N unique business candidate methods"
  // tally in the Methods view below. Pre-v0.0.133 we counted every
  // (class, method, span_name) row whose score >= 1, so a single
  // method that produced several distinct span_name strings inflated
  // the stat-card past the deduped row count the user sees in the
  // table — yielding a 23-vs-19 mismatch. `totalMethodsScanned`
  // stays as the raw row count (it's a "spans scanned" measure).
  const methodSummary = useMemo(() => {
    const candidateKeys = new Set<string>();
    for (const m of methodScan) {
      const { score } = scoreMethodLike(
        m.class_name,
        m.method_name,
        m.span_name,
        { allowSql: allowSqlMethods },
      );
      if (score >= 1) {
        candidateKeys.add(`${m.class_name ?? ""}::${m.method_name ?? ""}`);
      }
    }
    return {
      candidateMethods: candidateKeys.size,
      totalMethodsScanned: methodScan.length,
    };
  }, [methodScan, allowSqlMethods, keywordCategories, nonBusinessPhrases]);
  const methodPct =
    methodSummary.totalMethodsScanned > 0
      ? Math.round(
          (methodSummary.candidateMethods / methodSummary.totalMethodsScanned) * 100,
        )
      : 0;

  return (
    <Flex flexDirection="column" gap={12}>
      {/* Pre-production caution banner — warning tone (not critical) so it
          reads as a sensible heads-up rather than an error. */}
      <Flex
        padding={12}
        gap={12}
        alignItems="center"
        style={{
          background: Colors.Background.Container.Warning.Default,
          border: `1px solid ${Colors.Border.Warning.Default}`,
          borderLeft: `4px solid ${Colors.Background.Container.Warning.Accent}`,
          borderRadius: 6,
        }}
      >
        <WarningIcon size="large" style={{ color: Colors.Text.Warning.Default, flexShrink: 0 }} />
        <Flex flexDirection="column" gap={2} style={{ flex: 1 }}>
          <Text style={{ color: Colors.Text.Warning.Default, fontWeight: 700, fontSize: "13px" }}>
            Run this discovery in Pre-production first
          </Text>
          <Text style={{ color: Colors.Text.Warning.Default, fontSize: "12px" }}>
            Capturing request / response bodies and query parameters can expose PII and add
            agent overhead. Validate Request Attribute rules against a non-production environment
            before promoting them to production.
          </Text>
        </Flex>
      </Flex>

      {/* Stat cards */}
      <Flex gap={12} flexWrap="wrap">
        <StatCard
          icon={<BusinessAnalyticsSignetIcon size="large" />}
          accent={Colors.Background.Container.Primary.Accent}
          subdued={Colors.Background.Container.Primary.Default}
          value={totalServices.toLocaleString()}
          label="Services analyzed"
          sub={`${scan.candidateServices} with business candidates`}
          active={view === "services"}
          onClick={() => onViewChange("services")}
        />
        <StatCard
          icon={<HttpIcon size="large" />}
          accent={Colors.Background.Container.Success.Accent}
          subdued={Colors.Background.Container.Success.Default}
          value={
            isScanning
              ? "…"
              : scan.candidateEndpoints.toLocaleString()
          }
          label="HTTP endpoint candidates"
          sub={
            isScanning
              ? "scanning endpoints…"
              : `${candidatePct}% of ${scan.totalEndpointsScanned.toLocaleString()} endpoints scanned`
          }
          active={view === "endpoints"}
          onClick={() => onViewChange("endpoints")}
        />
        <StatCard
          icon={<CodeIcon size="large" />}
          accent={Colors.Background.Container.Success.Accent}
          subdued={Colors.Background.Container.Success.Default}
          value={
            methodScanError
              ? "!"
              : isScanningMethods
              ? "…"
              : methodSummary.candidateMethods.toLocaleString()
          }
          label="Method candidates"
          sub={
            methodScanError
              ? `Query failed: ${methodScanError.message}`
              : isScanningMethods
              ? "scanning method spans…"
              : `${methodPct}% of ${methodSummary.totalMethodsScanned.toLocaleString()} method spans scanned`
          }
          active={view === "methods"}
          onClick={() => onViewChange("methods")}
        />
      </Flex>

      {/* Business keyword confidence row */}
      <Flex
        padding={12}
        gap={12}
        alignItems="center"
        flexWrap="wrap"
        style={{
          background: `linear-gradient(135deg, ${Colors.Background.Container.Primary.Default} 0%, ${Colors.Background.Container.Neutral.Default} 100%)`,
          border: `1px solid ${Colors.Border.Neutral.Default}`,
          borderRadius: 6,
        }}
      >
        <Flex gap={8} alignItems="center">
          <TargetFilledIcon style={{ color: Colors.Text.Primary.Default }} />
          <Text style={{ fontWeight: 700, fontSize: "13px", color: Colors.Text.Primary.Default }}>
            Business signals detected
          </Text>
        </Flex>
        {scan.topKeywords.length === 0 ? (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px", flex: 1 }}>
            {isScanning
              ? "Scanning endpoint names for known business vocabulary…"
              : "No high-confidence keywords found in endpoint names. Browse individual services for finer-grained suggestions."}
          </Text>
        ) : (
          <>
            <Flex gap={6} flexWrap="wrap" alignItems="center" style={{ flex: 1 }}>
              {scan.topKeywords.map(([kw, count]) => {
                const isSelected = signalFilters.has(kw);
                const dimmed = signalFilters.size > 0 && !isSelected;
                return (
                  // Clickable wrapper around the existing Chip so the
                  // design stays identical, just gains a toggle
                  // affordance: selected = outline ring, unselected
                  // while other filters are active = dimmed.
                  <button
                    key={kw}
                    type="button"
                    onClick={() => onToggleSignal(kw)}
                    aria-pressed={isSelected}
                    title={
                      isSelected
                        ? `Stop filtering services by "${kw}"`
                        : `Filter services to those exposing "${kw}"`
                    }
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      cursor: "pointer",
                      opacity: dimmed ? 0.4 : 1,
                      outline: isSelected
                        ? `2px solid ${Colors.Background.Container.Success.Accent}`
                        : "none",
                      outlineOffset: 2,
                      borderRadius: 12,
                      transition: "opacity 120ms ease, outline-color 120ms ease",
                    }}
                  >
                    <Chip color="success">
                      {kw} · {count}
                    </Chip>
                  </button>
                );
              })}
              {signalFilters.size > 0 && (
                <button
                  type="button"
                  onClick={onClearSignalFilters}
                  title="Clear signal filters"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    cursor: "pointer",
                  }}
                >
                  <Chip color="neutral">× clear ({signalFilters.size})</Chip>
                </button>
              )}
            </Flex>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
              {signalFilters.size > 0
                ? `filtering by ${signalFilters.size} signal${signalFilters.size === 1 ? "" : "s"} across endpoints & methods — click to toggle`
                : "click any signal to filter endpoints and methods"}
            </Text>
          </>
        )}
        {/* Inline Adjust button — same target as Settings → "Adjust",
            surfaced here so users can curate the catalog directly from
            the place where its effect is visible. */}
        <Button
          variant="default"
          onClick={onOpenSignals}
          aria-label="Adjust business signals"
        >
          <Button.Prefix>
            <SettingIcon />
          </Button.Prefix>
          Adjust
        </Button>
      </Flex>
    </Flex>
  );
}

function StatCard({
  icon,
  accent,
  subdued,
  value,
  label,
  sub,
  dim,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  accent: string;
  subdued: string;
  value: string;
  label: string;
  sub: string;
  dim?: boolean;
  // When `onClick` is set the card behaves as a view-switch tab. `active`
  // adds a visual selected state (thicker accent stripe + subtle ring)
  // so the user can see which view is currently rendered below.
  active?: boolean;
  onClick?: () => void;
}) {
  const isInteractive = typeof onClick === "function";
  return (
    <Surface
      style={{
        flex: 1,
        minWidth: 220,
        opacity: dim ? 0.65 : 1,
        overflow: "hidden",
        position: "relative",
        cursor: isInteractive ? "pointer" : undefined,
        // Subtle outer ring + lift when the card is the active tab. Kept
        // intentionally light so the bar still reads as a stats summary
        // rather than turning into a loud segmented control.
        outline: active ? `2px solid ${accent}` : "none",
        outlineOffset: active ? "-2px" : undefined,
        boxShadow: active ? `0 4px 12px ${subdued}` : undefined,
        transition: "outline-color 120ms ease, box-shadow 120ms ease",
      }}
      onClick={onClick}
      onKeyDown={
        isInteractive
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-pressed={isInteractive ? Boolean(active) : undefined}
    >
      <Flex
        padding={16}
        gap={12}
        alignItems="center"
        style={{
          background: `linear-gradient(135deg, ${subdued} 0%, transparent 70%)`,
          borderLeft: `${active ? 6 : 4}px solid ${accent}`,
        }}
      >
        <Flex
          justifyContent="center"
          alignItems="center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: accent,
            color: Colors.Text.Primary.OnAccent.Default,
            flexShrink: 0,
          }}
        >
          {icon}
        </Flex>
        <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontSize: "26px",
              fontWeight: 800,
              lineHeight: "1.1",
              color: Colors.Text.Primary.Default,
            }}
          >
            {value}
          </Text>
          <Text style={{ fontSize: "13px", fontWeight: 600, color: Colors.Text.Neutral.Default }}>
            {label}
          </Text>
          <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>{sub}</Text>
        </Flex>
      </Flex>
    </Surface>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

// Settings sheet — opened from the gear icon in the page header. Houses
// global UX/scoring toggles that need to feel "first-class" enough to
// deserve their own settings surface rather than being buried inside the
// individual sheets. Persisted via the useUserSettings hook → localStorage.
function SettingsSheet({
  show,
  settings,
  onChange,
  onClose,
  onOpenSignals,
}: {
  show: boolean;
  settings: UserSettings;
  onChange: (next: UserSettings) => void;
  onClose: () => void;
  onOpenSignals: () => void;
}) {
  return (
    <Sheet show={show} onDismiss={onClose}>
      <Flex flexDirection="column" gap={24} padding={24} style={{ width: 480 }}>
        <Flex justifyContent="space-between" alignItems="center">
          <Heading level={2}>Discovery settings</Heading>
          <Button variant="default" onClick={onClose}>Close</Button>
        </Flex>
        <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "13px" }}>
          Fine-tune which method spans show up as business candidates.
          Settings persist locally in your browser.
        </Paragraph>

        {/* SQL / database method toggle */}
        <Flex
          flexDirection="column"
          gap={12}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <Flex justifyContent="space-between" alignItems="center" gap={12}>
            <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontWeight: 700, fontSize: "13px" }}>
                Score SQL / database methods
              </Text>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                When enabled, DB framework methods like
                {" "}<Strong>DbCommand.ExecuteReader</Strong>,{" "}
                <Strong>SqlCeCommand.ExecuteNonQuery</Strong>,{" "}
                <Strong>SqlCeConnection.Open</Strong> and{" "}
                <Strong>DbCommand.ExecuteScalar</Strong> are scored against
                the SQL statement carried in <Strong>span.name</Strong>.
                Business table or column names (e.g. <Strong>customer</Strong>,
                {" "}<Strong>order</Strong>, <Strong>payment</Strong>) inside
                a SELECT/INSERT/UPDATE will then push the span to medium
                or high confidence. Off by default because it tends to
                produce a lot of low-signal candidates.
              </Text>
            </Flex>
            <Switch
              value={settings.allowSqlMethods}
              onChange={(v: boolean) =>
                onChange({ ...settings, allowSqlMethods: v })
              }
            />
          </Flex>
        </Flex>

        {/* Cross-service descendants toggle */}
        <Flex
          flexDirection="column"
          gap={12}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <Flex justifyContent="space-between" alignItems="center" gap={12}>
            <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontWeight: 700, fontSize: "13px" }}>
                Include cross-service descendants as business candidates
              </Text>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px", lineHeight: "1.5" }}>
                When enabled, all spans in the representative traces are scanned
                — not just the endpoint&apos;s own service subtree. Candidates
                from other services are labeled accordingly:
              </Text>
              <Flex flexDirection="column" gap={6} style={{ marginTop: 4 }}>
                <Flex alignItems="center" gap={8}>
                  <Chip color="warning">Underlying service</Chip>
                  <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                    Method ran in a <Strong>different downstream service</Strong> called by this endpoint (e.g. a frontend endpoint calling a booking microservice).
                  </Text>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <Chip color="primary">Co-occurring</Chip>
                  <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                    Method ran in the <Strong>same service</Strong> but outside this endpoint&apos;s direct call subtree (e.g. a sibling or ancestor span in the same trace).
                  </Text>
                </Flex>
              </Flex>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px", marginTop: 4 }}>
                When disabled (default), only spans owned by the endpoint&apos;s own service count.
              </Text>
            </Flex>
            <Switch
              value={settings.includeCrossServiceDescendants}
              onChange={(v: boolean) =>
                onChange({ ...settings, includeCrossServiceDescendants: v })
              }
            />
          </Flex>
        </Flex>

        {/* Always-on infra suppressions — informational only */}
        <Flex
          flexDirection="column"
          gap={8}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
            background: Colors.Background.Container.Neutral.Default,
          }}
        >
          <Text style={{ fontWeight: 700, fontSize: "13px" }}>
            Always suppressed (framework infrastructure)
          </Text>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
            These methods are pure framework plumbing — they only pick
            up business keywords because their <Strong>span.name</Strong>
            mirrors the underlying URL or RPC target. The method itself
            is never the business unit of work.
          </Text>
          <Flex gap={6} flexWrap="wrap">
            <Chip color="neutral">AspNet.WebRequest</Chip>
            <Chip color="neutral">ServiceChannel.Call</Chip>
            <Chip color="neutral">mod_proxy_balancer</Chip>
            <Chip color="neutral">BaseFilter.doFilter</Chip>
            <Chip color="neutral">JspServlet.service</Chip>
            <Chip color="neutral">OneAgent SDK</Chip>
            <Chip color="neutral">Outgoing remote call</Chip>
          </Flex>
        </Flex>

        {/* Static-resource extensions — informational only. Endpoints
            whose route ends in any of these extensions are filtered out
            at the source so they don't appear in the endpoint table,
            don't get scored, and don't dilute per-service candidacy
            ratings. Pure transport noise (images, CSS, JS, fonts,
            JSPs, fonts, documents, media). See
            STATIC_RESOURCE_EXTENSIONS in code for the exact list. */}
        <Flex
          flexDirection="column"
          gap={8}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
            background: Colors.Background.Container.Neutral.Default,
          }}
        >
          <Text style={{ fontWeight: 700, fontSize: "13px" }}>
            Always suppressed (static resource extensions)
          </Text>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
            Endpoints whose path ends in one of the extensions below are
            dropped before scoring — they are pure transport (images,
            stylesheets, scripts, fonts, JSP fragments, documents,
            media) and don't represent business operations. They are
            hidden from the endpoint table and excluded from candidate
            counts so they can't inflate or dilute the business score.
            For reference, see the
            {" "}<Strong>Requests executed in background threads of
            com.dynatrace.easytravel.weblauncher.jar easyTravel</Strong>
            {" "}service.
          </Text>
          <Flex gap={6} flexWrap="wrap">
            {STATIC_RESOURCE_EXTENSIONS.map((ext) => (
              <Chip key={ext} color="neutral">.{ext}</Chip>
            ))}
          </Flex>
        </Flex>

        {/* Business signals catalog editor — opens a secondary sheet so
            the main settings surface stays compact. Edits flow back
            through onChange → setUserSettings, which mirrors the new
            catalog into the module-level `_activeCatalog` consumed by
            scoreText, and forces every scoring useMemo to recompute via
            its `keywordCategories` dep. */}
        <Flex
          flexDirection="column"
          gap={12}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <Flex justifyContent="space-between" alignItems="center" gap={12}>
            <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontWeight: 700, fontSize: "13px" }}>
                Manage business signals
              </Text>
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                Tune the keyword catalog that powers every score on this
                page — add new signals (e.g. <Strong>policy</Strong>,
                {" "}<Strong>quote</Strong>), disable noisy ones, or remove
                them outright. Changes are reflected immediately in the
                Services / HTTP endpoints / Method candidates views and
                in the suppression-phrase list (e.g.
                {" "}<Strong>user agent</Strong>).
              </Text>
              <Flex gap={6} flexWrap="wrap" style={{ marginTop: 4 }}>
                {settings.keywordCategories.map((cat) => {
                  const enabledKw = cat.keywords.filter((e) => e.enabled).length;
                  return (
                    <Chip key={cat.id} color={cat.enabled ? cat.color : "neutral"}>
                      {cat.label} · {enabledKw}/{cat.keywords.length}
                    </Chip>
                  );
                })}
              </Flex>
            </Flex>
            <Button variant="emphasized" onClick={() => onOpenSignals()}>
              Adjust
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </Sheet>
  );
}

// ─── Business Signals Editor Sheet ────────────────────────────────────────────
//
// Secondary sheet (opened from "Adjust" in SettingsSheet) that lets the
// user fully manage the keyword catalog and the suppression-phrase list
// that scoreText reads from. Layout per category:
//
//   ┌─ Category header ──────────────────────────────────────────────┐
//   │ [color chip] Label                              [enable switch] │
//   ├────────────────────────────────────────────────────────────────┤
//   │ keyword × │ keyword × │ keyword (dimmed) × │ ... add input ➕   │
//   └────────────────────────────────────────────────────────────────┘
//
// Disabled keywords stay visible (dimmed strikethrough) so the user can
// re-enable them without retyping. Removing is a hard delete. A "Reset
// to defaults" button at the bottom restores the seed catalog +
// suppression phrases verbatim — useful after aggressive cleanup
// rounds.
function BusinessSignalsSheet({
  show,
  settings,
  onChange,
  onClose,
}: {
  show: boolean;
  settings: UserSettings;
  onChange: (next: UserSettings) => void;
  onClose: () => void;
}) {
  // Per-category "add keyword" inputs, keyed by category id.
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  // Suppression phrase input.
  const [phraseInput, setPhraseInput] = useState("");

  const updateCategory = (id: string, updater: (cat: KeywordCategoryConfig) => KeywordCategoryConfig) => {
    onChange({
      ...settings,
      keywordCategories: settings.keywordCategories.map((c) =>
        c.id === id ? updater(c) : c,
      ),
    });
  };

  const addKeyword = (catId: string) => {
    const raw = (addInputs[catId] ?? "").trim().toLowerCase();
    if (!raw) return;
    // Split on commas so users can paste a comma-separated list in one shot.
    const tokens = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    updateCategory(catId, (cat) => {
      const existing = new Set(cat.keywords.map((e) => e.text));
      const additions: KeywordEntry[] = tokens
        .filter((t) => !existing.has(t))
        .map((t) => ({ text: t, enabled: true }));
      return { ...cat, keywords: [...cat.keywords, ...additions] };
    });
    setAddInputs((s) => ({ ...s, [catId]: "" }));
  };

  const toggleKeyword = (catId: string, text: string) => {
    updateCategory(catId, (cat) => ({
      ...cat,
      keywords: cat.keywords.map((e) =>
        e.text === text ? { ...e, enabled: !e.enabled } : e,
      ),
    }));
  };

  const deleteKeyword = (catId: string, text: string) => {
    updateCategory(catId, (cat) => ({
      ...cat,
      keywords: cat.keywords.filter((e) => e.text !== text),
    }));
  };

  const toggleCategory = (catId: string, enabled: boolean) => {
    updateCategory(catId, (cat) => ({ ...cat, enabled }));
  };

  const addPhrase = () => {
    const raw = phraseInput.trim().toLowerCase();
    if (!raw) return;
    if (settings.nonBusinessPhrases.includes(raw)) {
      setPhraseInput("");
      return;
    }
    onChange({
      ...settings,
      nonBusinessPhrases: [...settings.nonBusinessPhrases, raw],
    });
    setPhraseInput("");
  };

  const deletePhrase = (phrase: string) => {
    onChange({
      ...settings,
      nonBusinessPhrases: settings.nonBusinessPhrases.filter((p) => p !== phrase),
    });
  };

  const resetAll = () => {
    onChange({
      ...settings,
      keywordCategories: DEFAULT_KEYWORD_CATEGORIES,
      nonBusinessPhrases: DEFAULT_NON_BUSINESS_PHRASES,
      getByIdBoost: DEFAULT_USER_SETTINGS.getByIdBoost,
    });
    setAddInputs({});
    setPhraseInput("");
  };

  return (
    <Sheet show={show} onDismiss={onClose}>
      <Flex flexDirection="column" gap={20} padding={24} style={{ width: 640, maxHeight: "90vh", overflowY: "auto" }}>
        <Flex justifyContent="space-between" alignItems="center">
          <Flex flexDirection="column" gap={4}>
            <Heading level={2}>Manage business signals</Heading>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "13px" }}>
              Edits apply immediately to every score on the Discovery
              page. Stored locally in your browser via{" "}
              <Strong>dt.dbm.userSettings</Strong>.
            </Text>
          </Flex>
          <Flex gap={8}>
            <Button variant="default" onClick={resetAll}>
              <Button.Prefix>
                <ResetIcon />
              </Button.Prefix>
              Reset to defaults
            </Button>
            <Button variant="default" onClick={onClose}>Close</Button>
          </Flex>
        </Flex>

        {/* Categories */}
        {settings.keywordCategories.map((cat) => {
          const enabledKw = cat.keywords.filter((e) => e.enabled).length;
          return (
            <Flex
              key={cat.id}
              flexDirection="column"
              gap={12}
              padding={16}
              style={{
                border: `1px solid ${Colors.Border.Neutral.Default}`,
                borderRadius: 6,
                opacity: cat.enabled ? 1 : 0.6,
              }}
            >
              <Flex justifyContent="space-between" alignItems="center" gap={12}>
                <Flex alignItems="center" gap={8} style={{ flex: 1, minWidth: 0 }}>
                  <Chip color={cat.color}>{cat.label}</Chip>
                  <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                    {enabledKw} of {cat.keywords.length} enabled
                  </Text>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>
                    {cat.enabled ? "On" : "Off"}
                  </Text>
                  <Switch
                    value={cat.enabled}
                    onChange={(v: boolean) => toggleCategory(cat.id, v)}
                  />
                </Flex>
              </Flex>

              {/* Keyword chips. Click chip body → toggle enabled.
                  Click × → hard delete. Disabled chips render dimmed
                  + strikethrough so users can tell at a glance which
                  signals are silenced vs removed. */}
              <Flex gap={6} flexWrap="wrap">
                {cat.keywords.map((entry) => (
                  <Flex
                    key={entry.text}
                    alignItems="center"
                    gap={4}
                    padding={4}
                    style={{
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      borderRadius: 12,
                      background: entry.enabled
                        ? Colors.Background.Container.Neutral.Default
                        : Colors.Background.Container.Neutral.Accent,
                      opacity: entry.enabled ? 1 : 0.55,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleKeyword(cat.id, entry.text)}
                      title={entry.enabled ? "Click to disable" : "Click to re-enable"}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: "0 6px",
                        cursor: "pointer",
                        fontSize: "12px",
                        color: Colors.Text.Neutral.Default,
                        textDecoration: entry.enabled ? "none" : "line-through",
                      }}
                    >
                      {entry.text}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteKeyword(cat.id, entry.text)}
                      title="Delete keyword"
                      aria-label={`Delete keyword ${entry.text}`}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: "0 4px",
                        cursor: "pointer",
                        color: Colors.Text.Critical.Default,
                        fontSize: "14px",
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </Flex>
                ))}
              </Flex>

              {/* Add-keyword input. Supports comma-separated input so
                  users can drop in a list in one shot (e.g. paste
                  "policy, premium, claim" → 3 chips). */}
              <Flex gap={8} alignItems="flex-end">
                <Flex flexDirection="column" gap={2} style={{ flex: 1 }}>
                  <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
                    Add keyword(s) — comma separated
                  </Text>
                  <TextInput
                    value={addInputs[cat.id] ?? ""}
                    onChange={(v) => setAddInputs((s) => ({ ...s, [cat.id]: v }))}
                    placeholder="e.g. policy, premium, claim"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addKeyword(cat.id);
                      }
                    }}
                  />
                </Flex>
                <Button variant="default" onClick={() => addKeyword(cat.id)}>
                  <Button.Prefix>
                    <PlusIcon />
                  </Button.Prefix>
                  Add
                </Button>
              </Flex>
            </Flex>
          );
        })}

        {/* Suppression phrases — wiped from scoreText's matching
            surface before keyword search runs. Useful for known
            false-positive substrings like "user agent" that would
            otherwise trip the "user" keyword. */}
        <Flex
          flexDirection="column"
          gap={12}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontWeight: 700, fontSize: "13px" }}>
              Suppression phrases
            </Text>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              Multi-word phrases that should never contribute to a score
              even when they textually contain a keyword. Example: HTTP{" "}
              <Strong>User-Agent</Strong> contains "user" but is a
              client-fingerprint string, not customer data.
            </Text>
          </Flex>
          <Flex gap={6} flexWrap="wrap">
            {settings.nonBusinessPhrases.length === 0 && (
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px", fontStyle: "italic" }}>
                No phrases configured.
              </Text>
            )}
            {settings.nonBusinessPhrases.map((phrase) => (
              <Flex
                key={phrase}
                alignItems="center"
                gap={4}
                padding={4}
                style={{
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  borderRadius: 12,
                  background: Colors.Background.Container.Neutral.Default,
                }}
              >
                <Text style={{ fontSize: "12px", padding: "0 6px", color: Colors.Text.Neutral.Default }}>
                  {phrase}
                </Text>
                <button
                  type="button"
                  onClick={() => deletePhrase(phrase)}
                  title="Delete phrase"
                  aria-label={`Delete phrase ${phrase}`}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: "0 4px",
                    cursor: "pointer",
                    color: Colors.Text.Critical.Default,
                    fontSize: "14px",
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </Flex>
            ))}
          </Flex>
          <Flex gap={8} alignItems="flex-end">
            <Flex flexDirection="column" gap={2} style={{ flex: 1 }}>
              <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
                Add phrase
              </Text>
              <TextInput
                value={phraseInput}
                onChange={setPhraseInput}
                placeholder='e.g. "x-correlation-id"'
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPhrase();
                  }
                }}
              />
            </Flex>
            <Button variant="default" onClick={addPhrase}>
              <Button.Prefix>
                <PlusIcon />
              </Button.Prefix>
              Add
            </Button>
          </Flex>
        </Flex>

        {/* Detection patterns — special signals that aren't plain
            substring matches and so don't fit into a category. The
            get*ById boost is the only one today: routes / method names
            matching the regex `^get[A-Z].*ById$` (e.g. `getJourneyById`,
            `getCustomerById`) get a forced score >= 1 and a synthetic
            `byId` keyword. Toggle off to silence the signal everywhere. */}
        <Flex
          flexDirection="column"
          gap={12}
          padding={16}
          style={{
            border: `1px solid ${Colors.Border.Neutral.Default}`,
            borderRadius: 6,
          }}
        >
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontWeight: 700, fontSize: "13px" }}>
              Detection patterns
            </Text>
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              Synthetic signals that go beyond plain keyword matching.
              These don't live in a category because they're driven by
              route-shape rules, not substring lookups.
            </Text>
          </Flex>
          <Flex
            justifyContent="space-between"
            alignItems="center"
            gap={12}
            padding={12}
            style={{
              border: `1px solid ${Colors.Border.Neutral.Default}`,
              borderRadius: 6,
              background: Colors.Background.Container.Neutral.Default,
              opacity: settings.getByIdBoost ? 1 : 0.65,
            }}
          >
            <Flex alignItems="center" gap={8} style={{ flex: 1, minWidth: 0 }}>
              <Chip color="success">byId</Chip>
              <Flex flexDirection="column" gap={2}>
                <Text style={{ fontWeight: 700, fontSize: "12px" }}>
                  get*ById route boost
                </Text>
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                  Matches <Strong>getJourneyById</Strong>,{" "}
                  <Strong>getCustomerById</Strong>, etc. \u2014 forces score \u2265 1 and
                  adds a synthetic <Strong>byId</Strong> chip.
                </Text>
              </Flex>
            </Flex>
            <Flex alignItems="center" gap={8}>
              <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>
                {settings.getByIdBoost ? "On" : "Off"}
              </Text>
              <Switch
                value={settings.getByIdBoost}
                onChange={(v: boolean) =>
                  onChange({ ...settings, getByIdBoost: v })
                }
              />
            </Flex>
          </Flex>
        </Flex>

        <Flex justifyContent="flex-end" gap={8}>
          <Button variant="default" onClick={resetAll}>
            <Button.Prefix>
              <ResetIcon />
            </Button.Prefix>
            Reset to defaults
          </Button>
          <Button variant="emphasized" onClick={onClose}>
            Done
          </Button>
        </Flex>
      </Flex>
    </Sheet>
  );
}

// ─── Global HTTP Endpoints View ───────────────────────────────────────────────

// Flat, fleet-wide view of HTTP endpoint candidates rendered when the
// "HTTP endpoint candidates" stat card is selected. Powered by the
// global endpoint scan that's already in flight for the stats tile, so
// it surfaces instantly without an extra DQL round-trip. Each row
// scores its route via `scoreMethodLike` (same rules as everywhere
// else) and carries a Service column so users can see which service it
// belongs to without first opening that service.
type GlobalEndpointRow = {
  service_id: string;
  service_name: string;
  route: string;
  score: number;
  keywords: string[];
};

function GlobalEndpointsView({
  endpointScan,
  isScanning,
  services,
  methodsByEndpoint,
  methodsLoading,
  methodsError,
  searchQuery,
  onSearchChange,
  signalFilters,
}: {
  endpointScan: Array<{ service_ids: string[]; service_id: string; route: string }>;
  isScanning: boolean;
  services: ServiceRecord[];
  // Fleet-wide trace-joined map: key = `${endpoint_service_id}::${endpoint}`.
  // Populated once the user opens this tab (gated query in Discovery).
  methodsByEndpoint: Map<string, MethodCandidate[]>;
  methodsLoading: boolean;
  methodsError: Error | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  // Active business-signal toggle set, shared with the Services tab.
  // When non-empty, only endpoints whose route keywords intersect the
  // set are shown.
  signalFilters: Set<string>;
}) {
  // Subscribed for keyword-catalog edits — keeps the route scores
  // reactive to the Manage business signals editor.
  const [{ keywordCategories, nonBusinessPhrases }] = useUserSettings();

  const serviceById = useMemo(() => {
    const m = new Map<string, ServiceRecord>();
    // Index each service under BOTH its Smartscape ID and (when
    // different) its classic entity ID. The endpoint-scan rows from
    // GLOBAL_ENDPOINTS_QUERY can identify a service via either
    // dimension — SOAP/Axis services in particular often carry only
    // the classic ID on per-operation rows, so a Smartscape-only map
    // would fail to resolve them and the global views would render
    // unknown-service rows or skip them entirely.
    for (const s of services) {
      if (s.service_id) m.set(s.service_id, s);
      if (s.entity_id && s.entity_id !== s.service_id) m.set(s.entity_id, s);
    }
    return m;
  }, [services]);

  // Per-row sheet state — same model as `EndpointsExplorer` (Services
  // tab), just lifted into this component because the global view is
  // its own self-contained surface.
  const [collectTarget, setCollectTarget] = useState<GlobalEndpointRow | null>(null);
  const [methodsTarget, setMethodsTarget] = useState<GlobalEndpointRow | null>(null);

  const allRows = useMemo<GlobalEndpointRow[]>(() => {
    const rows: GlobalEndpointRow[] = [];
    for (const row of endpointScan) {
      const { score, keywords } = scoreMethodLike(null, row.route, null);
      // Try every known ID (smartscape + classic) so SOAP/Axis services
      // resolve even when the metric only carries the classic entity ID.
      let svc: ServiceRecord | undefined;
      for (const id of row.service_ids) {
        svc = serviceById.get(id);
        if (svc) break;
      }
      // Skip rows whose owning service isn't in the OneAgent services
      // list — they'd otherwise render as an opaque ID with no
      // human-readable name (see GLOBAL_ENDPOINTS_QUERY comments).
      if (!svc) continue;
      rows.push({
        service_id: svc.service_id,
        service_name: svc.service_name,
        route: row.route,
        score,
        keywords,
      });
    }
    return rows.sort(
      (a, b) => b.score - a.score || a.route.localeCompare(b.route),
    );
  }, [endpointScan, serviceById, keywordCategories, nonBusinessPhrases]);

  const candidatesCount = useMemo(
    () => allRows.filter((r) => r.score >= 1).length,
    [allRows],
  );

  const [candidatesOnly, setCandidatesOnly] = useState(true);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allRows.filter((r) => {
      if (candidatesOnly && r.score < 1) return false;
      if (q && !r.route.toLowerCase().includes(q)) return false;
      if (signalFilters.size > 0) {
        // Keep endpoints whose route keywords intersect the active
        // signal filter set (OR semantics across selected chips).
        let any = false;
        for (const kw of r.keywords) {
          if (signalFilters.has(kw)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
      return true;
    });
  }, [allRows, candidatesOnly, searchQuery, signalFilters]);

  // Same accent-blue Button styling used in EndpointsExplorer so the
  // two surfaces feel like the same product.
  const accentBtnStyle: React.CSSProperties = {
    background: Colors.Background.Container.Primary.Accent,
    borderColor: Colors.Background.Container.Primary.Accent,
    color: Colors.Text.Primary.OnAccent.Default,
  };

  const columns = useMemo<DataTableColumnDef<GlobalEndpointRow>[]>(
    () => [
      {
        id: "route",
        header: "Endpoint",
        accessor: "route",
        cell: ({ value, rowData }: { value: string; rowData: GlobalEndpointRow }) => (
          <Flex flexDirection="column" gap={4} padding={4}>
            <Strong>
              <HighlightedText text={value} keywords={rowData.keywords} />
            </Strong>
          </Flex>
        ),
      },
      {
        id: "service_name",
        header: "Service",
        accessor: "service_name",
        width: 240,
        cell: ({ value, rowData }: { value: string; rowData: GlobalEndpointRow }) => {
          const svc = serviceById.get(rowData.service_id);
          return (
            <Flex flexDirection="column" gap={4} padding={4}>
              <Text style={{ fontSize: "13px", fontWeight: 600 }}>{value}</Text>
              {svc?.technology && (
                <Chip color="neutral">{svc.technology}</Chip>
              )}
            </Flex>
          );
        },
      },
      {
        id: "http_params",
        header: "HTTP parameters",
        accessor: "score",
        width: 220,
        cell: ({ rowData }: { value: number; rowData: GlobalEndpointRow }) => (
          <Flex flexDirection="column" gap={8} padding={4}>
            <Flex gap={6} alignItems="center" flexWrap="wrap">
              <RelevanceBadge score={rowData.score} />
            </Flex>
            <Flex>
              <Button
                variant="accent"
                style={accentBtnStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollectTarget(rowData);
                }}
              >
                Collect HTTP Parameters
              </Button>
            </Flex>
          </Flex>
        ),
      },
      {
        id: "method_candidates",
        header: "Method candidates",
        accessor: "route",
        cell: ({ rowData }: { value: string; rowData: GlobalEndpointRow }) => {
          const methods =
            methodsByEndpoint.get(`${rowData.service_id}::${rowData.route}`) ?? [];
          const businessMatches = methods.filter((m) => m.score > 0);
          const totalMethods = methods.length;
          return (
            <Flex flexDirection="column" gap={8} padding={4}>
              {methodsError ? (
                <Text style={{ color: Colors.Text.Critical.Default, fontSize: "12px" }}>
                  {methodsError.message}
                </Text>
              ) : methodsLoading ? (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  Scanning trace spans…
                </Text>
              ) : totalMethods === 0 ? (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
                  No method spans recorded for this endpoint in the last 30m.
                </Text>
              ) : (
                <Flex flexDirection="column" gap={4}>
                  <Flex gap={6} alignItems="center" flexWrap="wrap">
                    {businessMatches.length > 0 ? (
                      <Chip color="success">
                        <Strong>{businessMatches.length}</Strong>&nbsp;business candidate
                        {businessMatches.length === 1 ? "" : "s"}
                      </Chip>
                    ) : (
                      <Chip color="neutral">No business keyword matches</Chip>
                    )}
                  </Flex>
                  {businessMatches.length > 0 ? (
                    <Flex flexDirection="column" gap={2}>
                      {businessMatches.slice(0, 3).map((m) => (
                        <Flex key={m.id} gap={6} alignItems="center" flexWrap="wrap">
                          <Text
                            style={{
                              color: Colors.Text.Neutral.Default,
                              fontSize: "12px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <HighlightedText text={m.displayName} keywords={m.keywords} />
                          </Text>
                          {m.is_cross_service ? (
                            <Chip color="warning">Underlying service</Chip>
                          ) : m.is_surrounding ? (
                            <Chip color="primary">Co-occurring</Chip>
                          ) : null}
                          {/* Span-kind chip suppressed — see `groupMethodCandidates`. */}
                        </Flex>
                      ))}
                      {businessMatches.length > 3 ? (
                        <Text
                          style={{
                            color: Colors.Text.Neutral.Default,
                            fontSize: "11px",
                            fontStyle: "italic",
                          }}
                        >
                          +{businessMatches.length - 3} more
                        </Text>
                      ) : null}
                    </Flex>
                  ) : null}
                </Flex>
              )}
              <Flex gap={6} alignItems="center">
                <Button
                  variant="accent"
                  disabled={totalMethods === 0}
                  style={accentBtnStyle}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMethodsTarget(rowData);
                  }}
                >
                  Investigate methods
                  {totalMethods > 0 ? (
                    <span
                      style={{
                        marginLeft: 8,
                        padding: "1px 8px",
                        borderRadius: 999,
                        background: "rgba(255, 255, 255, 0.22)",
                        color: Colors.Text.Primary.OnAccent.Default,
                        fontSize: 11,
                        fontWeight: 700,
                        lineHeight: "16px",
                      }}
                    >
                      {totalMethods}
                    </span>
                  ) : null}
                </Button>
              </Flex>
            </Flex>
          );
        },
      },
    ],
    [serviceById, methodsByEndpoint, methodsLoading, methodsError],
  );

  const collectServiceName = collectTarget
    ? serviceById.get(collectTarget.service_id)?.service_name ?? collectTarget.service_name
    : "";
  const methodsServiceName = methodsTarget
    ? serviceById.get(methodsTarget.service_id)?.service_name ?? methodsTarget.service_name
    : "";

  return (
    <Flex flexDirection="column" gap={12} style={{ flex: 1, minWidth: 0 }}>
      <Flex gap={8} alignItems="center" flexWrap="wrap">
        <TextInput
          value={searchQuery}
          onChange={(e) =>
            onSearchChange(
              typeof e === "string"
                ? e
                : (e as React.ChangeEvent<HTMLInputElement>).target?.value ?? "",
            )
          }
          placeholder="Search endpoints..."
          style={{ flex: 1, minWidth: 240 }}
        />
        <Switch
          value={candidatesOnly}
          onChange={(v) => setCandidatesOnly(v)}
          name="endpoints-candidates-only"
        >
          Candidates only
        </Switch>
      </Flex>
      <Flex justifyContent="space-between" alignItems="center" gap={8}>
        <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
          {filtered.length.toLocaleString()} of {allRows.length.toLocaleString()} endpoints
          {" · "}
          {candidatesCount.toLocaleString()} business candidates
        </Text>
        {methodsLoading && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            Scanning trace spans for method candidates…
          </Text>
        )}
      </Flex>
      <Surface style={{ flex: 1, minHeight: 300 }}>
        <DataTable
          data={filtered}
          columns={columns}
          loading={isScanning && allRows.length === 0}
          fullWidth
          sortable
          rowId={(row) => `${row.service_id}::${row.route}`}
          variant={{ rowDensity: "comfortable" }}
        >
          <DataTable.EmptyState>
            <Flex padding={16} flexDirection="column" gap={8}>
              <Paragraph>
                {searchQuery
                  ? `No endpoints match "${searchQuery}".`
                  : candidatesOnly
                  ? "No business-keyword endpoints in the last 30 minutes."
                  : "No endpoints found in the last 30 minutes."}
              </Paragraph>
            </Flex>
          </DataTable.EmptyState>
        </DataTable>
      </Surface>

      <CollectParamsSheet
        show={collectTarget !== null}
        serviceName={collectServiceName}
        route={collectTarget?.route ?? ""}
        httpMethod={null}
        onClose={() => setCollectTarget(null)}
      />

      <InvestigateMethodsSheet
        show={methodsTarget !== null}
        serviceName={methodsServiceName}
        serviceId={methodsTarget?.service_id ?? ""}
        route={methodsTarget?.route ?? ""}
        httpMethod={null}
        candidates={
          methodsTarget
            ? methodsByEndpoint.get(
                `${methodsTarget.service_id}::${methodsTarget.route}`,
              ) ?? []
            : []
        }
        onClose={() => setMethodsTarget(null)}
      />
    </Flex>
  );
}

// ─── Global Method Candidates View ────────────────────────────────────────────

// Flat, fleet-wide view of method-span candidates rendered when the
// "Method candidates" stat card is selected. Powered by the
// trace-joined endpoint↔method map (gated query in `Discovery`). Each
// row is a unique method signature (class, method, span_name, span_kind);
// the (service, endpoint) tuples the method ran inside are listed as
// `appearances` in the HTTP endpoints column — each appearance is a
// clickable label that opens the Investigate Methods sheet scoped to
// that specific (service, endpoint). Grouping prevents the same method
// from producing N rows when it runs inside N endpoints. The search bar
// filters by method name (also class and span name, since the displayName
// is built from class.method()).
type MethodAppearance = {
  service_id: string;
  service_name: string;
  endpoint: string;
  // All span kinds the method was observed under inside this
  // (service, endpoint) — typically a subset of `server`, `internal`,
  // `client`, etc. Surfaced as small chips in the UI so users can
  // pick the right kind to attach a Request Attribute rule to:
  //   server   → HTTP request body / headers / URL params
  //   internal → method arguments / return value
  span_kinds: string[];
};
type GlobalMethodRow = {
  id: string; // method signature (class·method·span_name·span_kind)
  candidate: MethodCandidate;
  appearances: MethodAppearance[];
};

function GlobalMethodsView({
  methodsByEndpoint,
  methodsLoading,
  methodsError,
  services,
  allowSqlMethods,
  searchQuery,
  onSearchChange,
  signalFilters,
}: {
  // Fleet-wide trace-joined map: key = `${endpoint_service_id}::${endpoint}`.
  methodsByEndpoint: Map<string, MethodCandidate[]>;
  methodsLoading: boolean;
  methodsError: Error | null;
  services: ServiceRecord[];
  allowSqlMethods: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  // Active business-signal toggle set, shared with the Services and
  // HTTP endpoints tabs. When non-empty, only method candidates whose
  // keywords intersect the set are shown.
  signalFilters: Set<string>;
}) {
  const serviceById = useMemo(() => {
    const m = new Map<string, ServiceRecord>();
    // Same dual-key indexing as the HTTP endpoints view — keep SOAP/Axis
    // services resolvable under either Smartscape or classic entity ID.
    for (const s of services) {
      if (s.service_id) m.set(s.service_id, s);
      if (s.entity_id && s.entity_id !== s.service_id) m.set(s.entity_id, s);
    }
    return m;
  }, [services]);

  // Sheet target is now a single appearance (service, endpoint) rather
  // than the whole grouped row — a row can list many appearances and we
  // open Investigate Methods scoped to whichever one the user clicked.
  const [methodsTarget, setMethodsTarget] = useState<MethodAppearance | null>(null);

  // Group method candidates by signature (class · method · span_name ·
  // span_kind) so the same method that ran inside N endpoints renders as
  // ONE row with N appearances, not N duplicate rows. The representative
  // `candidate` keeps the highest-scoring instance so the Relevance badge
  // and keyword highlights still reflect the strongest signal. Only
  // candidates with score >= 1 are surfaced because this view exists to
  // highlight business-relevant methods.
  const allRows = useMemo<GlobalMethodRow[]>(() => {
    const map = new Map<string, GlobalMethodRow>();
    for (const [key, candidates] of methodsByEndpoint) {
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      const service_id = key.slice(0, sep);
      const endpoint = key.slice(sep + 2);
      const svc = serviceById.get(service_id);
      // Drop methods owned by services that are NOT in the OneAgent list
      // (e.g. OpenTelemetry-only services that leaked through the trace join).
      // Keeps the Method candidates page consistent with the Services list.
      if (!svc) continue;
      const service_name = svc.service_name;
      for (const c of candidates) {
        if (c.score < 1) continue;
        // Collapse method-kind variants (internal/server/etc.) into a
        // single row keyed purely by displayName. OpenTelemetry can
        // record the same method under multiple span kinds for the same
        // endpoint, which was producing visually duplicate rows.
        const sig = c.displayName;
        const kind = c.span_kind ?? "";
        const existing = map.get(sig);
        if (existing) {
          // Deduplicate appearances by (service, endpoint) so the same
          // (service, endpoint) pair isn't listed twice when a method
          // had multiple span_kind variants inside it. Merge the kinds
          // so the UI can display all observed kinds as chips.
          const dupIdx = existing.appearances.findIndex(
            (a) => a.service_id === service_id && a.endpoint === endpoint,
          );
          if (dupIdx >= 0) {
            if (kind && !existing.appearances[dupIdx].span_kinds.includes(kind)) {
              existing.appearances[dupIdx].span_kinds.push(kind);
            }
          } else {
            existing.appearances.push({
              service_id,
              service_name,
              endpoint,
              span_kinds: kind ? [kind] : [],
            });
          }
          if (c.score > existing.candidate.score) {
            existing.candidate = c;
          }
        } else {
          map.set(sig, {
            id: sig,
            candidate: c,
            appearances: [
              {
                service_id,
                service_name,
                endpoint,
                span_kinds: kind ? [kind] : [],
              },
            ],
          });
        }
      }
    }
    // Stable appearance ordering per row so the labels don't shuffle
    // between renders.
    for (const row of map.values()) {
      row.appearances.sort(
        (a, b) =>
          a.service_name.localeCompare(b.service_name) ||
          a.endpoint.localeCompare(b.endpoint),
      );
    }
    return [...map.values()].sort(
      (a, b) =>
        b.candidate.score - a.candidate.score ||
        a.candidate.displayName.localeCompare(b.candidate.displayName),
    );
  }, [methodsByEndpoint, serviceById]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allRows.filter((r) => {
      if (q) {
        const c = r.candidate;
        const haystacks = [
          c.method_name ?? "",
          c.class_name ?? "",
          c.span_name,
          c.displayName,
        ];
        if (!haystacks.some((h) => h.toLowerCase().includes(q))) return false;
      }
      if (signalFilters.size > 0) {
        let any = false;
        for (const kw of r.candidate.keywords) {
          if (signalFilters.has(kw)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
      return true;
    });
  }, [allRows, searchQuery, signalFilters]);

  const accentBtnStyle: React.CSSProperties = {
    background: Colors.Background.Container.Primary.Accent,
    borderColor: Colors.Background.Container.Primary.Accent,
    color: Colors.Text.Primary.OnAccent.Default,
  };
  void accentBtnStyle;

  const columns = useMemo<DataTableColumnDef<GlobalMethodRow>[]>(
    () => [
      {
        id: "method",
        header: "Method",
        accessor: (row) => row.candidate.displayName,
        cell: ({ rowData }: { value: string; rowData: GlobalMethodRow }) => {
          const c = rowData.candidate;
          return (
            <Flex flexDirection="column" gap={4} padding={4}>
              <Strong
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              >
                <HighlightedText text={c.displayName} keywords={c.keywords} />
              </Strong>
              {c.class_name && (
                <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                  {c.class_name}
                </Text>
              )}
            </Flex>
          );
        },
      },
      {
        id: "endpoints",
        header: "HTTP endpoints",
        // Accessor returns a flattened string so DataTable's built-in
        // sort/search can still operate on the column even though the
        // visual cell renders a stack of (label · Investigate-button) rows.
        accessor: (row) =>
          row.appearances
            .map((a) => `${a.endpoint} from ${a.service_name}`)
            .join(" \u2022 "),
        cell: ({ rowData }: { value: string; rowData: GlobalMethodRow }) => (
          <Flex flexDirection="column" gap={6} padding={4}>
            {rowData.appearances.map((a) => (
              <Flex
                key={`${a.service_id}::${a.endpoint}`}
                gap={8}
                alignItems="center"
                flexWrap="wrap"
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  background: Colors.Background.Container.Neutral.Default,
                }}
              >
                <Flex
                  alignItems="center"
                  gap={6}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: 12,
                      color: Colors.Text.Primary.Default,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {a.endpoint}
                  </span>
                  <span style={{ color: Colors.Text.Neutral.Default, fontSize: 11 }}>
                    from
                  </span>
                  <span
                    style={{
                      fontWeight: 500,
                      fontSize: 12,
                      color: Colors.Text.Primary.Default,
                    }}
                  >
                    {a.service_name}
                  </span>
                  {/* Span-kind chip suppressed — server / internal variants
                      of the same method are merged in `groupMethodCandidates`
                      and downstream RA verification targets the server span,
                      so the chip carried only confusion. */}
                </Flex>
                <Button
                  variant="accent"
                  style={{
                    background: Colors.Background.Container.Primary.Accent,
                    borderColor: Colors.Background.Container.Primary.Accent,
                    color: Colors.Text.Primary.OnAccent.Default,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMethodsTarget(a);
                  }}
                >
                  Investigate
                </Button>
              </Flex>
            ))}
          </Flex>
        ),
      },
      {
        id: "score",
        header: "Relevance",
        accessor: (row) => row.candidate.score,
        width: 160,
        cell: ({ rowData }: { value: number; rowData: GlobalMethodRow }) => (
          <Flex flexDirection="column" gap={4} padding={4}>
            <RelevanceBadge score={rowData.candidate.score} />
            {rowData.appearances.length > 1 && (
              <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
                in {rowData.appearances.length} endpoints
              </Text>
            )}
          </Flex>
        ),
      },
    ],
    [],
  );

  return (
    <Flex flexDirection="column" gap={12} style={{ flex: 1, minWidth: 0 }}>
      <TextInput
        value={searchQuery}
        onChange={(e) =>
          onSearchChange(
            typeof e === "string"
              ? e
              : (e as React.ChangeEvent<HTMLInputElement>).target?.value ?? "",
          )
        }
        placeholder="Search method names..."
      />
      <Flex justifyContent="space-between" alignItems="center" gap={8}>
        <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
          {filtered.length.toLocaleString()} unique business candidate method
          {filtered.length === 1 ? "" : "s"}
          {(() => {
            const totalAppearances = filtered.reduce(
              (n, r) => n + r.appearances.length,
              0,
            );
            return totalAppearances !== filtered.length
              ? ` · ${totalAppearances.toLocaleString()} endpoint occurrence${totalAppearances === 1 ? "" : "s"}`
              : "";
          })()}
        </Text>
        {!allowSqlMethods && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px" }}>
            SQL methods hidden — enable in Settings to include them
          </Text>
        )}
      </Flex>
      {methodsError ? (
        <Surface style={{ flex: 1, minHeight: 200 }}>
          <Flex padding={16} flexDirection="column" gap={8}>
            <Paragraph>
              <Strong>Query failed:</Strong> {methodsError.message}
            </Paragraph>
            <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              Ensure the app has <Strong>storage:spans:read</Strong> scope accepted.
            </Paragraph>
          </Flex>
        </Surface>
      ) : (
        <Surface style={{ flex: 1, minHeight: 300 }}>
          <DataTable
            data={filtered}
            columns={columns}
            loading={methodsLoading && allRows.length === 0}
            fullWidth
            sortable
            rowId={(row) => row.id}
            variant={{ rowDensity: "comfortable" }}
          >
            <DataTable.EmptyState>
              <Flex padding={16} flexDirection="column" gap={8}>
                <Paragraph>
                  {searchQuery
                    ? `No methods match "${searchQuery}".`
                    : "No business-keyword method spans in the last 30 minutes."}
                </Paragraph>
              </Flex>
            </DataTable.EmptyState>
          </DataTable>
        </Surface>
      )}

      <InvestigateMethodsSheet
        show={methodsTarget !== null}
        serviceName={methodsTarget?.service_name ?? ""}
        serviceId={methodsTarget?.service_id ?? ""}
        route={methodsTarget?.endpoint ?? ""}
        httpMethod={null}
        candidates={
          methodsTarget
            ? methodsByEndpoint.get(
                `${methodsTarget.service_id}::${methodsTarget.endpoint}`,
              ) ?? []
            : []
        }
        onClose={() => setMethodsTarget(null)}
      />
    </Flex>
  );
}

export const Discovery = () => {
  const [selectedService, setSelectedService] = useState<ServiceRecord | null>(null);
  // Which top-level view the stat-card "tabs" currently point at. The
  // three views share the top header + stats bar + Settings sheet, and
  // only the area BELOW the stats swaps. Defaults to the services view
  // (the original layout) so users land exactly where they used to.
  const [viewMode, setViewMode] = useState<DiscoveryView>("services");
  // Per-view search state. We keep them separate so switching views
  // doesn't carry over a stale needle (a service name being a poor
  // substring match for endpoint routes or method names, and vice
  // versa).
  const [servicesSearch, setServicesSearch] = useState("");
  const [endpointsSearch, setEndpointsSearch] = useState("");
  const [methodsSearch, setMethodsSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  // Active signal filter set, driven by the toggleable chips in the
  // Business signals row. Empty = no filter; otherwise the services
  // list is restricted to services whose endpoint keywords intersect
  // this set. Lives at Discovery so the same selection survives view
  // switches (Services / HTTP endpoints / Method candidates).
  const [signalFilters, setSignalFilters] = useState<Set<string>>(() => new Set());
  const toggleSignal = useCallback((kw: string) => {
    setSignalFilters((prev) => {
      const next = new Set(prev);
      if (next.has(kw)) next.delete(kw);
      else next.add(kw);
      return next;
    });
  }, []);
  const clearSignalFilters = useCallback(() => setSignalFilters(new Set()), []);
  const [settings, writeSettings] = useUserSettings();

  const { data: servicesData, isLoading, error: servicesError } = useDql({
    query: SERVICES_QUERY,
  });
  // Endpoint scan now ships inline with SERVICES_QUERY (via `routes`),
  // so the loading state for both is simply the services-query loading
  // state. Kept under the `scanLoading` name to avoid touching every
  // consumer site.
  const scanLoading = isLoading;
  const { data: methodScanData, isLoading: methodScanLoading, error: methodScanError } = useDql({
    query: GLOBAL_METHODS_QUERY,
  });
  // Fleet-wide trace-joined endpoint↔method correlation. Powers both the
  // HTTP endpoints tab (Method candidates column) and the Method
  // candidates tab (HTTP Endpoint column + Investigate methods button).
  // Gated behind `enabled` to avoid running the join on first paint —
  // users who stay on the default Services tab never pay for it.
  // `maxResultRecords: 50000` lifts the SDK's default 1000-row response
  // cap so endpoints whose spans land past row 1000 are not silently
  // dropped. Without this, the global tab shows "No method spans
  // recorded" for any endpoint whose data lives in the truncated tail
  // (typically the lower-traffic endpoints like /Account/LogOff,
  // /Booking, /Payment/Pay), even though the DQL pipeline itself emits
  // up to 50000 rows via `| limit 50000`.
  const {
    data: globalEndpointMethodsData,
    isLoading: globalEndpointMethodsLoading,
    error: globalEndpointMethodsError,
  } = useDql(
    { query: GLOBAL_ENDPOINT_METHODS_QUERY, maxResultRecords: 50000 },
    { enabled: viewMode !== "services" },
  );

  const services = useMemo(() => parseServices(servicesData), [servicesData]);
  // Endpoint scan is now derived directly from services[].routes so
  // there's no client-side ID join (and no risk of missing SOAP/Axis
  // services whose per-operation rows live under a different ID than
  // the aggregate — see SERVICES_QUERY comments). Each route inherits
  // the owning service's IDs verbatim.
  const endpointScan = useMemo<
    Array<{ service_ids: string[]; service_id: string; route: string }>
  >(() => {
    const rows: Array<{ service_ids: string[]; service_id: string; route: string }> = [];
    for (const s of services) {
      const ids: string[] = [];
      if (s.service_id) ids.push(s.service_id);
      if (s.entity_id && s.entity_id !== s.service_id) ids.push(s.entity_id);
      if (ids.length === 0) continue;
      for (const route of s.routes) {
        rows.push({ service_ids: ids, service_id: ids[0], route });
      }
    }
    return rows;
  }, [services]);
  const methodScan = useMemo<
    Array<{ class_name: string | null; method_name: string | null; span_name: string | null }>
  >(() => {
    const records = (methodScanData as { records?: Array<Record<string, unknown>> } | undefined)?.records;
    if (!records) return [];
    return records.map((r) => ({
      class_name: r.class_name ? String(r.class_name) : null,
      method_name: r.method_name ? String(r.method_name) : null,
      span_name: r.span_name ? String(r.span_name) : null,
    }));
  }, [methodScanData]);
  // Group fleet-wide trace-joined records by `${endpoint_service_id}::${endpoint}`
  // so each view can do a fast O(1) lookup for "which methods ran inside
  // this endpoint". Honours the SQL methods opt-in and the cross-service
  // descendants opt-in (same as everywhere else). The subtree filter is
  // what makes the global counts match the Services-tab counts — it drops
  // sibling-endpoint spans that happen to live in the same rep trace as
  // the target endpoint's entry-point. Only computed once the gated
  // query has returned data.
  const globalMethodsByEndpoint = useMemo(
    () => {
      const parsed = parseGlobalEndpointMethods(globalEndpointMethodsData);
      const subtree = filterGlobalToEndpointSubtree(parsed);
      // OFF (default) — keep only same-service spans inside the BFS
      // subtree (precise; mirrors the pre-toggle behaviour).
      //
      // ON — use the FULL parsed set (skip the BFS subtree filter). BFS
      // requires every intermediate span to be present to walk the
      // parent_id chain, but cross-service descendants often hang off
      // HTTP client spans that the outer-fetch limit may have truncated
      // or dropped. That breaks the chain and silently hides downstream
      // business spans (e.g. `BookingService.storeBooking` reached via
      // an HTTP call from `easytravel-frontend-java` into `easytravel-
      // business-java` for `/orange-booking-finish.jsf`). The trace-
      // level join already restricts records to the 5 rep traces of
      // each (service, endpoint), so we don't risk pulling in spans
      // from unrelated requests.
      const scoped = settings.includeCrossServiceDescendants
        ? parsed
        : subtree.filter(
            (r) => !r.service_id || r.service_id === r.endpoint_service_id,
          );
      const subtreeSpanIds = new Set<string>(
        subtree.map((r) => r.span_id).filter((id): id is string => Boolean(id)),
      );
      return groupGlobalMethodCandidates(scoped, {
        allowSql: settings.allowSqlMethods,
        subtreeSpanIds,
      });
    },
    [
      globalEndpointMethodsData,
      settings.allowSqlMethods,
      settings.includeCrossServiceDescendants,
      settings.keywordCategories,
      settings.nonBusinessPhrases,
    ],
  );

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      {/* Header */}
      <Flex justifyContent="space-between" alignItems="flex-start" gap={16}>
        <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Heading level={1}>Business Metrics Discovery</Heading>
          <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
            Analyze services, HTTP endpoints, and internal method spans to discover where business data lives.
            Click any row to see suggested Request Attribute configurations.
          </Paragraph>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
            Note: services are listed from the <Strong>dt.service.request.count</Strong> metric,
            filtered to OneAgent-monitored services only (where <Strong>dt.agent.module.type</Strong>
            is set). OpenTelemetry-only services are excluded.
          </Text>
        </Flex>
        {/* Gear icon \u2192 opens the Settings sheet. Top-right of the page
            header. Houses the SQL methods opt-in (and any future scoring
            toggles). Persisted to localStorage via useUserSettings(). */}
        <Button
          variant="default"
          onClick={() => setShowSettings(true)}
          aria-label="Open settings"
        >
          <Button.Prefix>
            <SettingIcon />
          </Button.Prefix>
          Settings
        </Button>
      </Flex>

      {/* Settings sheet */}
      <SettingsSheet
        show={showSettings}
        settings={settings}
        onChange={writeSettings}
        onClose={() => setShowSettings(false)}
        onOpenSignals={() => setShowSignals(true)}
      />

      {/* Business signals editor (secondary sheet, opened from Settings) */}
      <BusinessSignalsSheet
        show={showSignals}
        settings={settings}
        onChange={writeSettings}
        onClose={() => setShowSignals(false)}
      />

      {/* Stats */}
      {services.length > 0 && (
        <StatsBar
          services={services}
          endpointScan={endpointScan}
          isScanning={scanLoading}
          methodScan={methodScan}
          isScanningMethods={methodScanLoading}
          methodScanError={methodScanError ?? null}
          allowSqlMethods={settings.allowSqlMethods}
          view={viewMode}
          onViewChange={setViewMode}
          onOpenSignals={() => setShowSignals(true)}
          signalFilters={signalFilters}
          onToggleSignal={toggleSignal}
          onClearSignalFilters={clearSignalFilters}
        />
      )}

      {/* Main Layout — driven by viewMode. The three views share the
          header + stats bar + Settings sheet above; only what lives
          below the stats swaps. */}
      {viewMode === "services" && (
        <Flex gap={16} alignItems="flex-start">
          <ServicesPanel
            services={services}
            isLoading={isLoading}
            error={servicesError}
            searchQuery={servicesSearch}
            onSearchChange={setServicesSearch}
            selectedServiceId={selectedService?.service_id ?? null}
            onServiceSelect={setSelectedService}
            endpointScan={endpointScan}
            isScanning={scanLoading}
            signalFilters={signalFilters}
          />

          {selectedService ? (
            <ServiceDetail key={selectedService.service_id} service={selectedService} />
          ) : (
            <Surface style={{ flex: 1, minHeight: 400 }}>
              <Flex padding={48} flexDirection="column" alignItems="center" justifyContent="center" gap={12}>
                <Heading level={3}>Select a Service</Heading>
                <Paragraph style={{ color: Colors.Text.Neutral.Default, textAlign: "center", maxWidth: 400 }}>
                  Choose a service from the list to discover its HTTP endpoints and internal methods that
                  may carry business metrics like amounts, user identifiers, transaction references, and loyalty status.
                </Paragraph>
                {isLoading && (
                  <Text style={{ color: Colors.Text.Neutral.Default }}>Loading services...</Text>
                )}
              </Flex>
            </Surface>
          )}
        </Flex>
      )}

      {viewMode === "endpoints" && (
        <GlobalEndpointsView
          endpointScan={endpointScan}
          isScanning={scanLoading}
          services={services}
          methodsByEndpoint={globalMethodsByEndpoint}
          methodsLoading={globalEndpointMethodsLoading}
          methodsError={globalEndpointMethodsError ?? null}
          searchQuery={endpointsSearch}
          onSearchChange={setEndpointsSearch}
          signalFilters={signalFilters}
        />
      )}

      {viewMode === "methods" && (
        <GlobalMethodsView
          methodsByEndpoint={globalMethodsByEndpoint}
          methodsLoading={globalEndpointMethodsLoading}
          methodsError={globalEndpointMethodsError ?? null}
          services={services}
          allowSqlMethods={settings.allowSqlMethods}
          searchQuery={methodsSearch}
          onSearchChange={setMethodsSearch}
          signalFilters={signalFilters}
        />
      )}
    </Flex>
  );
};
