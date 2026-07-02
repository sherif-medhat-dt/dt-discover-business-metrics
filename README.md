# Business Metrics Discovery

A Dynatrace App that helps you find and instrument business-relevant data already flowing through your services — without writing custom instrumentation from scratch. It scans your distributed traces for endpoints and methods that carry business signals, guides you through capturing them as **Business Events** or **Request Attributes**, and generates a ready-to-import **Journey Dashboard** that correlates IT health with real business KPIs.

---

## Table of Contents

- [Overview](#overview)
- [Pages](#pages)
  - [Discover](#discover)
  - [Open Sessions](#open-sessions)
  - [Journey Dashboard Wizard](#journey-dashboard-wizard)
- [Business Events](#business-events)
- [Request Attributes](#request-attributes)
- [Settings](#settings)
- [Permissions](#permissions)
- [Development](#development)

---

## Overview

```
Home → Discover → (capture params) → Open Sessions → Journey Dashboard Wizard → Dashboard
```

1. **Discover** scans your fleet's spans to find services, HTTP endpoints, and internal methods that contain business-sounding names (amounts, orders, customers, etc.).
2. **Collect Parameters** drills into a selected endpoint or method, browses a live trace, and creates a Dynatrace Business Event capture rule that extracts the chosen fields from HTTP requests/responses.
3. **Open Sessions** shows all active capture rules the app created, lets you browse the live data they collect, generate sample DQL notebooks, and close or re-open sessions.
4. **Journey Dashboard Wizard** assembles a complete multi-step user journey dashboard (e.g. Login → Add Beneficiary → Transfer → Confirmation) with IT health, security, and business KPI tiles baked in.

---

## Pages

### Discover

The discovery engine is the heart of the app. It queries Grail for spans observed in the last hour and surfaces candidates ranked by a configurable **business keyword score**.

#### How scoring works

Each service, endpoint, or method name is split into tokens and matched against a built-in keyword catalog (see [Settings](#settings)). Every matched keyword adds 1 to the score:

| Score | Confidence |
|-------|-----------|
| ≥ 3   | High       |
| 1–2   | Medium     |
| 0     | Low        |

Keywords are grouped into five semantic categories — **Financial**, **Identity**, **Transaction**, **Reference**, and **Product** — each shown as a colour-coded chip on the results.

Infrastructure framework spans (ASP.NET entry points, filter chains, RPC dispatchers, proxy balancers, OpenTracing SDK wrappers) are always suppressed regardless of keyword matches. SQL/database methods are suppressed by default and can be enabled in Settings.

#### Views

The page offers three views, selectable via the stat cards at the top:

- **Services** — left-hand service picker + right-hand endpoint and method breakdown for the selected service.
- **HTTP Endpoints** — flat table of all endpoints across the entire fleet, sortable by calls or score.
- **Internal Methods** — flat table of all internal method spans, sortable by calls or score.

#### Collect Parameters sheet

Clicking **Investigate methods** on any endpoint opens a slide-over sheet that:

1. Fetches a representative trace for the endpoint.
2. Renders the trace as a **span waterfall** tree so you can see exactly which methods ran inside the request.
3. Scores each span and shows keyword chips for each match.
4. Lets you switch between **Candidate methods** (high-scoring spans) and **All spans** tabs.
5. Provides an **Attribute suggestions** panel per span: lists the request/response fields most likely to carry business data, with the exact JSONPath or header name and the Dynatrace settings instruction needed to capture it.
6. Clicking **Collect parameters** on a span opens the parameter-capture sub-sheet where you can:
   - Browse flattened sample request/response fields from a live Dynatrace API call to the target environment.
   - Pin individual fields to include in the capture rule.
   - Set the **event type** name that will appear in `fetch bizevents`.
   - Create a `builtin:bizevents.http.incoming` capture rule in one click.

The **cross-service descendants** toggle (also in the Collect Parameters sheet) controls whether the span waterfall shows only spans owned by the same service as the entry-point span, or also spans from downstream services reached via HTTP/RPC calls.

---

### Open Sessions

Shows every `builtin:bizevents.http.incoming` rule created by this app (identified by the `dt-business-discovery.*` source prefix). There are two views:

#### Open Sessions table

Lists rules that still have wildcard collectors active — these are "open" because they capture raw request/response bodies wholesale, which is useful during discovery but expensive in production. Columns:

| Column | Description |
|--------|-------------|
| Rule | Links to the rule in Dynatrace Settings |
| Service | Service the rule is scoped to |
| Endpoint | HTTP path the rule fires on |
| HTTP Method | Verb filter, or ANY |
| Wildcards | Number of wildcard collectors (request body, response body, etc.) |
| Pinned fields | Number of specific named fields the user has pinned |

**Quick delete** removes the wildcard collectors while keeping any pinned fields. **Reopen** adds the wildcards back for continued discovery.

#### Configured Business Events table

A field-level view showing every named parameter across all app-created rules, with:

| Column | Description |
|--------|-------------|
| Field name | The `event.type` field name — click the copy icon to copy a ready-to-use DQL snippet |
| Path | The JSONPath, header name, or query key the rule reads from |
| Source | Human-readable data source label (Request Body, Response Headers, Query String, etc.) |
| Rule | The parent rule, linked to Dynatrace Settings |
| Endpoint | HTTP path |
| Service | Owning service |
| Sample value | Live value from the last 24 h of `fetch bizevents` |
| Notebook | One-click button to create a Grail notebook scoped to that field |

---

### Journey Dashboard Wizard

The wizard builds a complete Dynatrace dashboard JSON that you can import directly into the Dynatrace Dashboards app. It models a multi-step user journey (up to 4 steps) where each step maps to one HTTP endpoint.

#### Wizard steps

**Step 1 — Define journey steps**

Add 1–4 journey steps. Each step has:
- **Endpoint name** — autocompleted from span data in Grail; you can also type a custom value.
- **Step label** — friendly name shown as the column header on the generated dashboard (e.g. "Login", "Add Beneficiary", "Transfer").

**Step 2 — Add business metrics (optional, up to 2 per step)**

For each step you can attach up to 2 business metric tiles. Each metric tile is configured with:

- **Label** — tile title on the dashboard.
- **Metric kind**:
  - *Business Event* — picks a `event.type` discovered in Grail and a specific field from that event type.
  - *Request Attribute* — picks a Dynatrace Request Attribute by name (pulled live from your environment's v1 Config API).
- **Aggregation** — `count`, `sum`, `avg`, `min`, `max`, or `none` (raw timeseries).
- **Visualization** — one of 8 chart types: Single value, Line chart, Area chart, Bar chart, Categorical bar, Donut chart, Pie chart, or Table.
- **DQL query** — auto-generated but fully editable in the embedded DQL editor. For Business Events the query uses `fetch bizevents`; for Request Attributes it uses `fetch spans` with `requestAttribute.*` fields.

**Step 3 — Business indicators (optional)**

Global KPIs shown across the whole journey at the top of the dashboard:

- **Transaction volume** — endpoint to count requests against.
- **Transaction amount** — total monetary or numeric value, sourced from either a Business Event field or a Request Attribute, with a configurable unit label (e.g. "EUR", "USD").

**Generated dashboard layout**

Each journey step becomes a column containing:

```
┌──────────────────────────────────────┐
│  Step header (name + arrow)          │
│  IT Issues (active Davis problems)   │  Security (max CVSS score)
│  Business KPI placeholder            │
│  Business metric tile 1 (optional)   │
│  Business metric tile 2 (optional)   │
└──────────────────────────────────────┘
```

Plus a **Failed transactions** section at the bottom that lists spans for each endpoint where the HTTP status was 4xx or 5xx.

The dashboard JSON is rendered as a copyable code block. Click **Copy** and paste it into **Dashboards → Import dashboard** in Dynatrace.

---

## Business Events

Business Events (`fetch bizevents`) are the primary capture mechanism this app configures. A capture rule lives at `builtin:bizevents.http.incoming` in Dynatrace Settings and fires for every HTTP request that matches a service + path filter.

**What the app creates:**

- One rule per endpoint + service combination.
- Rule name format: `<HTTP_METHOD> <route> — <service_name>` (e.g. `POST /api/checkout — payment-service`).
- Source prefix: `dt-business-discovery.<triggerPath>` — used by the app to distinguish its own rules from manually created ones.
- Each rule captures the specific fields the user pinned during the Collect Parameters flow (JSONPath into request body, response body, query parameters, or headers).

**Querying captured data:**

```dql
fetch bizevents, from: now() - 2h
| filter event.type == "your.event.type"
| fields timestamp, amount, orderId, userId
| sort timestamp desc
```

The **Configured Business Events** table in [Open Sessions](#open-sessions) provides a copy button per field that generates the exact `fields` snippet for that field.

---

## Request Attributes

Request Attributes are an alternative to Business Events for numeric KPIs that need to be correlated with service-level metrics (response time, error rate). They are defined in Dynatrace Settings and attached to every matching request as a dimension on spans.

The app surfaces Request Attributes in two places:

1. **Attribute suggestions panel** in the Collect Parameters sheet — for each candidate span the app lists which existing Request Attributes are relevant and what you need to configure (schema ID, JSONPath, data source) to create or extend a rule.
2. **Journey Dashboard Wizard** — when adding a business metric tile, you can switch the metric kind to *Request Attribute* and pick from the list of attributes already defined in your environment (fetched via the `getRequestAttributes` backend function). The wizard then generates a DQL query using `fetch spans | filter isNotNull(requestAttribute.<name>)`.

---

## Settings

The gear icon (⚙) in the top-right of the **Discover** page opens a settings sheet. All settings are stored in `localStorage` and persist across sessions.

### Business signal keywords

The keyword catalog drives the scoring engine. You can:

- **Enable / disable a whole category** (Financial, Identity, Transaction, Reference, Product) — disabled categories are excluded from scoring but remain visible.
- **Enable / disable individual keywords** within a category — useful for suppressing noisy terms without removing the whole category.
- **Add new keywords** to any category.
- **Remove keywords** from a category.
- **Reset to defaults** — restores the full factory catalog in one click.

**Default categories and sample keywords:**

| Category | Color | Sample keywords |
|----------|-------|-----------------|
| Financial | Green | `amount`, `price`, `payment`, `refund`, `revenue`, `billing` |
| Identity | Blue | `user`, `customer`, `account`, `email`, `loyalty`, `segment` |
| Transaction | Yellow | `order`, `checkout`, `booking`, `shipment`, `cart`, `return` |
| Reference | Grey | `tracking`, `confirmation`, `voucher`, `coupon`, `token` |
| Product | Blue | `product`, `sku`, `inventory`, `quantity`, `bundle` |

### False-positive suppression phrases

A list of multi-word phrases that are blanked out before keyword matching runs. Default: `user agent`. This prevents the keyword `user` from firing on every span that mentions the HTTP `User-Agent` header.

You can add your own suppression phrases for domain-specific false positives (e.g. `account balance sheet` if you don't want `account` and `balance` to match on financial reporting spans).

### `getById` pattern boost

When enabled (default: on), route patterns matching `get*ById` (e.g. `getJourneyById`, `getOrderById`) receive a +1 score boost and a synthetic `byId` keyword chip. This catches lookup-by-identifier patterns that are strong indicators of entity-level business operations.

Disable this if the pattern generates too much noise in your environment.

### Include cross-service descendants

When enabled in the **Collect Parameters** sheet, the span waterfall shows method spans from *downstream* services (e.g. a `BookingService.createBooking()` call that ran inside a separate `business-backend` service because the entry-point endpoint delegated to it via HTTP). Disabled by default.

### Allow SQL/DB methods

When enabled, SQL and ADO.NET database command spans (e.g. `SqlCommand.ExecuteReader`, `DbContext.SaveChanges`) are included in scoring and candidate lists. The scorer runs against the SQL statement carried in `span.name`, which can match business table names like `customer`, `order`, or `payment`.

Disabled by default because most teams find DB-layer spans too noisy for business metric discovery — the endpoint or service method above them is a better capture point.

---

## Permissions

The following scopes are required and declared in `app.config.json`:

| Scope | Purpose |
|-------|---------|
| `storage:logs:read` | Query spans from Grail |
| `storage:bizevents:read` | Query Business Events |
| `storage:events:read` | Query Davis problem events for dashboard health tiles |
| `storage:spans:read` | Query distributed traces |
| `settings:objects:read` | Read existing capture rules |
| `settings:objects:write` | Create and delete capture rules |
| `document:documents:read` | Read notebooks and dashboard documents |
| `document:documents:write` | Create notebooks and upload dashboard arrow SVG |
| `state:app-states:read` | (Reserved for future use) |

---

## Development

```bash
# Install dependencies
npm install

# Start dev server with hot reload (auto-opens browser)
npm run start

# Build for production (output to dist/)
npm run build
```

---

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- Dynatrace App Toolkit CLI: `npm install -g @dynatrace/dt-app` (or use the local `npx dt-app`)
- A Dynatrace environment with AppEngine enabled
- A user or OAuth client with permission to deploy apps (`app-engine:apps:install`)

### 1. Configure the target environment

Edit `app.config.json` and set `environmentUrl` to your Dynatrace environment:

```json
{
  "environmentUrl": "https://<your-environment-id>.live.dynatrace.com/",
  "app": {
    "id": "my.dt.discover.business.metrics",
    ...
  }
}
```

> For SaaS environments the URL is `https://<env-id>.live.dynatrace.com/`.  


### 2. Build and deploy

```bash
# Deploy to the environment configured in app.config.json
npm run deploy
```

This runs `dt-app deploy` under the hood, which:
1. Compiles and bundles the app (`dist/`).
2. Uploads the bundle to Dynatrace AppEngine.
3. Activates the new version for all users of the environment.

### 3. Verify the deployment

After deployment, open your Dynatrace environment and navigate to **Apps**. Search for **Business Metrics Discovery** — the app should appear and launch without errors.

The first time the app runs it will prompt for the required permission scopes listed in the [Permissions](#permissions) section. Accept all scopes so the app can read spans, create capture rules, and generate dashboards.

### Publishing to the Dynatrace Hub (optional)

To share the app across multiple environments or publish it internally:

```bash
npm run publish
```

This runs `dt-app publish` and makes the app available in your organisation's Dynatrace Hub for one-click installation on other environments.
