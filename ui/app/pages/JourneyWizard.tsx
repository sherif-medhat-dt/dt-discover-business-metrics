import React, { useEffect, useMemo, useState, useCallback } from "react";

import { Button } from "@dynatrace/strato-components/buttons";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import {
  Heading,
  Paragraph,
  Strong,
  Text,
} from "@dynatrace/strato-components/typography";
import { Chip } from "@dynatrace/strato-components-preview/content";
import {
  Select,
  SelectContent,
  SelectFilter,
  SelectOption,
  TextInput,
} from "@dynatrace/strato-components-preview/forms";
import { DQLEditor } from "@dynatrace/strato-components-preview/editors";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { settingsObjectsClient } from "@dynatrace-sdk/client-classic-environment-v2";
import {
  BarChartIcon,
  DonutChartIcon,
  HorizontalBarChartIcon,
  LineChartIcon,
  PieChartIcon,
  SingleValueChartIcon,
  StackedAreaChartIcon,
  TableIcon,
} from "@dynatrace/strato-icons";
import { documentsClient } from "@dynatrace-sdk/client-document";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";

// Base64-encoded SVG arrow used between journey steps in the generated dashboard.
// Uploaded to Document Service at dashboard-creation time so the markdown tile
// renders the image from a stable tenant URL (data: URIs are not reliably rendered
// by the Dynatrace dashboard markdown renderer).
const ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 160"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="72" y2="160"><stop offset="0%" stop-color="#c4b5fd" stop-opacity="0.8"/><stop offset="60%" stop-color="#818cf8"/><stop offset="100%" stop-color="#6366f1"/></linearGradient></defs><polygon points="8,4 74,80 8,156" fill="url(#g)"/></svg>`;

async function uploadArrow(): Promise<string | null> {
  try {
    const blob = new Blob([ARROW_SVG], { type: "image/svg+xml" });
    const doc = await documentsClient.createDocument({
      body: { name: "dt-bmd-journey-arrow", type: "image", content: blob },
    });
    const id = (doc as { id?: string })?.id;
    return id ? `/platform/document/v1/documents/${id}/content` : null;
  } catch {
    return null;
  }
}

// ─── Wizard Model ─────────────────────────────────────────────────────────────
//
// The Journey Dashboard Wizard walks the user through describing a 1–4-step
// user journey (e.g. Login → Add Beneficiary → Transfer → Confirmation) and
// generates a Dynatrace dashboard JSON the user can paste into the
// Dashboards app. Each journey step becomes a column on the dashboard:
//
//   ┌────────── Endpoint header ──────────┐
//   │ IT Issues (health)  │   Security    │
//   │   Business KPI placeholder (blank)  │
//   │   Business metric tile 1 (optional) │
//   │   Business metric tile 2 (optional) │
//   └─────────────────────────────────────┘
//
// IT Issues  = count of active Davis problems on services that own this endpoint.
// Security   = max vulnerability score across services that own this endpoint.
// Business KPI placeholder = blank markdown tile the user fills in later.
// Business metric tiles    = pulled from a Grail-discovered bizevent type
//                            via the chosen aggregation + visualization.

const VIZ_OPTIONS = [
  "singleValue",
  "lineChart",
  "areaChart",
  "barChart",
  "categoricalBarChart",
  "donutChart",
  "pieChart",
  "table",
] as const;
type VizType = typeof VIZ_OPTIONS[number];

// Icon + human label for each visualization, used to render rich Select options
// (icon + name) so the user can pick a chart type visually instead of by code.
const VIZ_META: Record<VizType, { label: string; Icon: React.ComponentType }> = {
  singleValue: { label: "Single value", Icon: SingleValueChartIcon },
  lineChart: { label: "Line chart", Icon: LineChartIcon },
  areaChart: { label: "Area chart", Icon: StackedAreaChartIcon },
  barChart: { label: "Bar chart", Icon: BarChartIcon },
  categoricalBarChart: { label: "Categorical bar", Icon: HorizontalBarChartIcon },
  donutChart: { label: "Donut chart", Icon: DonutChartIcon },
  pieChart: { label: "Pie chart", Icon: PieChartIcon },
  table: { label: "Table", Icon: TableIcon },
};

const AGG_OPTIONS = ["none", "count", "sum", "avg", "min", "max"] as const;
type AggType = typeof AGG_OPTIONS[number];

// What kind of underlying metric a chart pulls from.
//   - business: a captured bizevent parameter (rule defined by this app)
//   - request_attribute: a Dynatrace Request Attribute name (free-text for now)
type MetricKind = "business" | "request_attribute";

interface BusinessMetric {
  label: string;
  kind: MetricKind;
  eventType: string;
  fieldName: string;       // captured-param name for kind=business
  ruleName: string;        // human label for kind=business
  requestAttribute: string; // RA name for kind=request_attribute
  aggregation: AggType;
  field: string;
  visualization: VizType;
  query: string;
}

interface JourneyEndpoint {
  name: string;
  stepName: string;
  metrics: BusinessMetric[];
}

interface BizIndicatorsConfig {
  volumeEndpoint: string;
  amountSourceType: '' | 'bizEvent' | 'requestAttribute';
  amountEventType: string;
  amountField: string;
  amountUnit: string;
  amountRaEndpoint: string;
  amountRaName: string;
}

function emptyBizIndicators(): BizIndicatorsConfig {
  return {
    volumeEndpoint: '',
    amountSourceType: '',
    amountEventType: '',
    amountField: '',
    amountUnit: '',
    amountRaEndpoint: '',
    amountRaName: '',
  };
}

const MAX_ENDPOINTS = 4;
const MAX_METRICS_PER_ENDPOINT = 2;

function emptyMetric(): BusinessMetric {
  return {
    label: "",
    kind: "business",
    eventType: "",
    fieldName: "",
    ruleName: "",
    requestAttribute: "",
    aggregation: "count",
    field: "",
    visualization: "singleValue",
    query: "",
  };
}

function emptyEndpoint(): JourneyEndpoint {
  return { name: "", stepName: "", metrics: [] };
}

// ─── DQL Templates ────────────────────────────────────────────────────────────

function escapeDql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildHealthQuery(endpointName: string): string {
  const safe = escapeDql(endpointName);
  return `fetch spans
| filter endpoint.name == "${safe}" and span.kind == "server"
| summarize services = collectDistinct(dt.entity.service)
| expand services
| lookup [
    fetch events
    | filter event.kind == "DAVIS_PROBLEM"
    | filter event.status == "ACTIVE"
    | filter dt.davis.is_duplicate == false
    | expand affected = affected_entity_ids
    | summarize problemCount = countDistinct(display_id), by:{affected}
  ], sourceField:services, lookupField:affected
| summarize problems = sum(coalesce(\`lookup.problemCount\`, 0))`;
}

function buildSecurityQuery(endpointName: string): string {
  const safe = escapeDql(endpointName);
  return `fetch spans
| filter endpoint.name == "${safe}" and span.kind == "server"
| summarize services = collectDistinct(dt.entity.service)
| expand services
| lookup [
    fetch events
    | filter event.kind == "SECURITY_EVENT"
    | filter event.type == "VULNERABILITY_STATE_REPORT_EVENT"
    | filter event.level == "ENTITY"
    | sort timestamp, direction:"descending"
    | summarize {
        vulnerability.resolution.status = takeFirst(vulnerability.resolution.status),
        vulnerability.mute.status = takeFirst(vulnerability.mute.status),
        vulnerability.davis_assessment.score = takeFirst(vulnerability.davis_assessment.score),
        related_entities.services.ids = takeFirst(related_entities.services.ids)
      }, by:{vulnerability.display_id}
    | filter vulnerability.resolution.status == "OPEN" AND vulnerability.mute.status != "MUTED"
    | expand related_entities.services.ids
    | summarize maxScore = max(vulnerability.davis_assessment.score), by:{related_entities.services.ids}
  ], sourceField:services, lookupField:related_entities.services.ids
| summarize score = coalesce(max(\`lookup.maxScore\`), 0.0)`;
}

// Build a bizevent metric DQL from event.type + agg + viz. Picks the query
// shape appropriate to the chosen visualization so the tile renders something
// useful out-of-the-box.
function buildMetricDql(
  metric: BusinessMetric,
): string {
  if (metric.kind === "request_attribute") {
    return buildRequestAttributeDql(metric);
  }
  return buildBusinessDql(metric);
}

function buildBusinessDql(metric: BusinessMetric): string {
  const { eventType, aggregation: agg, fieldName, field, visualization: viz } = metric;
  if (!eventType) return "";
  // The explicit `field` override (rare power-user case) wins over the
  // captured business field selected via the dropdown.
  const valueField = field || fieldName;
  const safeType = escapeDql(eventType);
  // Field refs are emitted UNQUOTED — sanitizeFieldName guarantees
  // [A-Za-z_][A-Za-z0-9_]* so backticks aren't needed and the user
  // explicitly asked us not to quote them.
  const ref = valueField ? valueField : "";
  const aggExpr = agg === "count" || agg === "none"
    ? "count()"
    : `${agg}(${ref})`;
  const aggAlias = agg === "count" || agg === "none"
    ? "count"
    : `${agg}_${valueField || "value"}`;
  const aggFragment = `${aggAlias} = ${aggExpr}`;
  const notNullFilter = ref ? ` and isNotNull(${ref})` : "";

  if (viz === "singleValue") {
    return `fetch bizevents
| filter event.type == "${safeType}"${notNullFilter}
| summarize ${aggFragment}`;
  }
  if (viz === "table") {
    const fieldsLine = ref ? `\n| fields timestamp, ${ref}` : "";
    return `fetch bizevents
| filter event.type == "${safeType}"${notNullFilter}${fieldsLine}
| sort timestamp desc
| limit 200`;
  }
  if (
    viz === "barChart" ||
    viz === "categoricalBarChart" ||
    viz === "donutChart" ||
    viz === "pieChart"
  ) {
    const groupBy = ref ? ref : "event.provider";
    return `fetch bizevents
| filter event.type == "${safeType}"${notNullFilter}
| summarize ${aggFragment}, by:{${groupBy}}
| sort ${aggAlias} desc
| limit 20`;
  }
  return `fetch bizevents
| filter event.type == "${safeType}"${notNullFilter}
| summarize ${aggFragment}, by:{bin(timestamp, 1m)}`;
}

// Request Attribute DQL templates. RA values surface on spans as
function buildRequestAttributeDql(metric: BusinessMetric): string {
  const { requestAttribute, aggregation: agg, visualization: viz } = metric;
  if (!requestAttribute) return "";
  // requestAttribute may be a full field path (e.g. captured_attribute.LoyalityStatus)
  // or a bare name (legacy, e.g. BookingDouble). Detect and handle both.
  const ref = (
    requestAttribute.startsWith("request_attribute.") ||
    requestAttribute.startsWith("dt.request_attribute.") ||
    requestAttribute.startsWith("captured_attribute.")
  ) ? requestAttribute : `request_attribute.${requestAttribute}`;
  const aggExpr = agg === "count" ? "count()" : `${agg}(${ref})`;
  const raName = ref.includes(".") ? ref.slice(ref.indexOf(".") + 1) : ref;
  const aggAlias = agg === "count" ? "count" : `${agg}_${raName || "value"}`;
  const aggFragment = `${aggAlias} = ${aggExpr}`;

  if (viz === "singleValue") {
    return `fetch spans
| filter span.kind == "server" and isNotNull(${ref})
| summarize ${aggFragment}`;
  }
  if (viz === "table") {
    return `fetch spans
| filter span.kind == "server" and isNotNull(${ref})
| fields timestamp, endpoint.name, service.name, ${ref}
| sort timestamp desc
| limit 200`;
  }
  return `fetch spans
| filter span.kind == "server" and isNotNull(${ref})
| summarize ${aggFragment}, by:{bin(timestamp, 1m)}`;
}

// ─── Dashboard JSON Builder ───────────────────────────────────────────────────

interface DashboardTile {
  type: "data" | "markdown";
  title?: string;
  content?: string;
  query?: string;
  visualization?: string;
  visualizationSettings?: Record<string, unknown>;
  querySettings?: Record<string, unknown>;
  davis?: Record<string, unknown>;
}
interface DashboardLayout { x: number; y: number; w: number; h: number; }
interface DashboardJson {
  version: number;
  variables: unknown[];
  tiles: Record<string, DashboardTile>;
  layouts: Record<string, DashboardLayout>;
  importedWithCode: boolean;
  settings: Record<string, unknown>;
  annotations: unknown[];
}

const DEFAULT_QUERY_SETTINGS = {
  maxResultRecords: 1000,
  defaultScanLimitGbytes: 500,
  maxResultMegaBytes: 100,
  defaultSamplingRatio: 10,
  enableSampling: false,
};
const DEFAULT_DAVIS = { enabled: false, davisVisualization: { isAvailable: true } };

function markdownTile(content: string): DashboardTile {
  return { type: "markdown", content };
}

function singleValueTile(
  title: string,
  query: string,
  recordField: string,
  label: string,
  colorRules: Array<Record<string, unknown>>,
): DashboardTile {
  return {
    type: "data",
    title,
    query,
    visualization: "singleValue",
    visualizationSettings: {
      singleValue: {
        label,
        recordField,
        prefixIcon: "",
        colorThresholdTarget: "background",
        sparklineSettings: { isVisible: false },
        trend: { isVisible: false },
      },
      coloring: { colorRules },
    },
    querySettings: DEFAULT_QUERY_SETTINGS,
    davis: DEFAULT_DAVIS,
  };
}

function singleValueTileWithDecimals(
  title: string,
  query: string,
  recordField: string,
  label: string,
  colorRules: Array<Record<string, unknown>>,
  decimals: number,
): DashboardTile {
  const base = singleValueTile(title, query, recordField, label, colorRules);
  return {
    ...base,
    visualizationSettings: {
      ...(base.visualizationSettings as Record<string, unknown>),
      unitsOverrides: [{ identifier: recordField, unitCategory: "unspecified", baseUnit: "none", displayUnit: null, decimals, suffix: "", delimiter: false, cascade: null }],
    },
  };
}

function customTile(
  title: string,
  query: string,
  visualization: VizType,
): DashboardTile {
  const settings: Record<string, unknown> = {};
  if (visualization === "singleValue") {
    settings.singleValue = {
      label: title,
      prefixIcon: "",
      sparklineSettings: { isVisible: false },
      trend: { isVisible: false },
    };
  } else if (
    visualization === "lineChart" ||
    visualization === "areaChart" ||
    visualization === "barChart"
  ) {
    settings.chartSettings = {
      legend: { hidden: false },
      xAxisLabel: "timeframe",
      xAxisScaling: "analyzedTimeframe",
      gapPolicy: "connect",
    };
  } else if (visualization === "donutChart" || visualization === "pieChart") {
    settings.chartSettings = {
      legend: { ratio: 30 },
      circleChartSettings: { valueType: "relative", showTotalValue: true },
    };
  } else if (visualization === "table") {
    settings.table = { linewrapEnabled: true };
  } else if (visualization === "categoricalBarChart") {
    settings.chartSettings = { legend: { hidden: true } };
  }
  return {
    type: "data",
    title,
    query,
    visualization,
    visualizationSettings: settings,
    querySettings: DEFAULT_QUERY_SETTINGS,
    davis: DEFAULT_DAVIS,
  };
}

const HEALTH_COLOR_RULES = [
  {
    value: 0,
    comparator: "≥",
    field: "problems",
    colorMode: "single-color",
    type: "long",
    color: "var(--dt-colors-charts-apdex-excellent-default, #2a7453)",
  },
  {
    value: 1,
    comparator: "≥",
    field: "problems",
    colorMode: "custom-color",
    customColor: { Default: "var(--dt-colors-charts-categorical-themed-fireplace-color-01-default, #ae132d)" },
    type: "long",
  },
];

const SECURITY_COLOR_RULES = [
  {
    value: 0,
    comparator: "≥",
    field: "score",
    colorMode: "single-color",
    type: "double",
    color: "var(--dt-colors-charts-apdex-excellent-default, #2a7453)",
  },
  {
    value: 6.5,
    comparator: "≥",
    field: "score",
    colorMode: "custom-color",
    customColor: { Default: "var(--dt-colors-charts-categorical-color-06-default, #a9780f)" },
    type: "double",
  },
  {
    value: 9,
    comparator: "≥",
    field: "score",
    colorMode: "custom-color",
    customColor: { Default: "var(--dt-colors-charts-categorical-color-12-default, #cd3741)" },
    type: "double",
  },
];

const COLUMN_WIDTH = 6;
const SECTION_TOP = 0;
// Layout order (top to bottom):
//   Title markdown  → Step name headers → healthy/error bar chart → IT/Security → KPI → metrics
const TITLE_H = 2;
const STEP_HEADER_Y = SECTION_TOP + TITLE_H;
const STEP_HEADER_H = 2;
const OVERVIEW_Y = STEP_HEADER_Y + STEP_HEADER_H;
const OVERVIEW_H = 6;
const STATUS_ROW_Y = OVERVIEW_Y + OVERVIEW_H;
const STATUS_ROW_H = 2;
const KPI_PLACEHOLDER_Y = STATUS_ROW_Y + STATUS_ROW_H;
const KPI_PLACEHOLDER_H = 2;
const METRIC_START_Y = KPI_PLACEHOLDER_Y + KPI_PLACEHOLDER_H;
const METRIC_H = 4;

// Build the journey-overview DQL. We use a `data` table to preserve the
// step ordering (so the bars line up left-to-right exactly like the
// journey funnel) and `lookup` to enrich each step with healthy / error
// call counts from `dt.service.request.count` and `dt.service.request
// .failure_count`.
function buildJourneyOverviewQuery(endpoints: JourneyEndpoint[]): string {
  const valid = endpoints
    .map((ep, idx) => ({
      stepLabel: (ep.stepName?.trim() || ep.name?.trim()) || `Step ${idx + 1}`,
      route: (ep.name || "").trim(),
      idx,
    }))
    .filter((e) => e.route.length > 0);
  if (valid.length === 0) return "";
  const dataRecords = valid
    .map(
      (e) =>
        `record(step = "${escapeDql(`${e.idx + 1}. ${e.stepLabel}`)}", route = "${escapeDql(e.route)}")`,
    )
    .join(",\n     ");
  const filterList = valid.map((e) => `"${escapeDql(e.route)}"`).join(", ");
  return `data ${dataRecords}
| lookup [
    timeseries
      total = sum(dt.service.request.count, scalar: true),
      failed = sum(dt.service.request.failure_count, scalar: true),
      by: { endpoint.name },
      filter: in(endpoint.name, ${filterList})
    | summarize { healthy = sum(total) - sum(failed), errors = sum(failed) }, by: { endpoint.name }
  ], sourceField: route, lookupField: endpoint.name
| fieldsAdd healthy = coalesce(lookup.healthy, 0), errors = coalesce(lookup.errors, 0)
| fields step, healthy, errors`;
}

function journeyOverviewTile(query: string): DashboardTile {
  return {
    type: "data",
    title: "\uD83D\uDCCA Requests per step (healthy vs errors)",
    query,
    visualization: "categoricalBarChart",
    visualizationSettings: {
      chartSettings: {
        legend: { hidden: false },
        categoricalBarChartSettings: {
          layout: "vertical",
          isCategoryLabelVisible: true,
          isValueLabelVisible: false,
        },
      },
      coloring: {
        colorRules: [
          {
            colorMode: "single-color",
            comparator: "\u2265",
            field: "healthy",
            value: null,
            type: "double",
            color: "var(--dt-colors-charts-apdex-excellent-default, #2a7453)",
          },
          {
            colorMode: "single-color",
            comparator: "\u2265",
            field: "errors",
            value: null,
            type: "double",
            color: "var(--dt-colors-charts-loglevel-emergency-default, #ae132d)",
          },
        ],
      },
      autoSelectVisualization: false,
    },
    querySettings: DEFAULT_QUERY_SETTINGS,
    davis: DEFAULT_DAVIS,
  };
}

function buildBizIndicatorsTiles(
  biz: BizIndicatorsConfig,
  startY: number,
  addTile: (tile: DashboardTile, layout: DashboardLayout) => void,
): void {
  const hasVolume = biz.volumeEndpoint.trim().length > 0;
  const hasAmount =
    biz.amountSourceType !== '' &&
    biz.amountField.trim().length > 0 &&
    (biz.amountSourceType === 'bizEvent'
      ? biz.amountEventType.trim().length > 0
      : biz.amountRaName.trim().length > 0);

  if (!hasVolume && !hasAmount) return;

  addTile(
    markdownTile(`## 📊 Business Indicators\n---\n `),
    { x: 0, y: startY, w: 24, h: 2 },
  );

  let currentY = startY + 2;

  if (hasVolume) {
    const safeEp = escapeDql(biz.volumeEndpoint.trim());
    const base = `fetch spans\n| filter request.is_root_span == true\n| filter endpoint.name == "${safeEp}"`;

    const volumeQuery = `${base}\n| fieldsAdd status = if(request.is_failed == true, "Failed", else: "Success")\n| makeTimeseries count(), by: { status }`;
    addTile(
      {
        type: 'data',
        title: 'Volume — Transactions Over Time',
        query: volumeQuery,
        visualization: 'davis',
        visualizationSettings: {
          autoSelectVisualization: false,
          chartSettings: { legend: { hidden: true }, gapPolicy: 'connect' },
          coloring: {
            colorRules: [
              { colorMode: 'single-color', comparator: '= *value*', field: 'status', type: 'string', value: 'Failed', color: 'var(--dt-colors-charts-loglevel-emergency-default, #ae132d)' },
              { colorMode: 'single-color', comparator: '= *value*', field: 'status', value: 'Success', type: 'string', color: 'var(--dt-colors-charts-apdex-excellent-default, #2a7453)' },
            ],
          },
          unitsOverrides: [],
        },
        querySettings: DEFAULT_QUERY_SETTINGS,
        davis: {
          enabled: true,
          componentState: {
            selectedAnalyzerName: 'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer',
            inputData: {
              'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer': {
                generalParameters: { resolveDimensionalQueryData: true, logVerbosity: 'INFO' },
                query: { expression: volumeQuery },
                numberOfSignalFluctuations: 1,
                alertCondition: 'ABOVE',
                alertOnMissingData: false,
                violatingSamples: 3,
                slidingWindow: 5,
                dealertingSamples: 5,
              },
            },
          },
          davisVisualization: { isAvailable: true, settings: { visibleSections: 'VISUALIZATION' } },
        },
      } as DashboardTile,
      { x: 0, y: currentY, w: 12, h: 4 },
    );

    addTile(
      {
        type: 'data', title: '',
        query: `${base}\n| summarize total_calls = count()`,
        visualization: 'singleValue',
        visualizationSettings: {
          singleValue: {
            label: 'TOTAL CALLS', recordField: 'total_calls',
            trend: { isVisible: true, trendField: 'total_calls', trendType: 'custom' },
          },
          coloring: { colorRules: [{ colorMode: 'single-color', color: 'var(--dt-colors-charts-loglevel-debug-default, #8b6ecf)', comparator: '≥', field: 'total_calls', value: null, type: 'long' }] },
          autoSelectVisualization: false,
          unitsOverrides: [{ identifier: 'total_calls', unitCategory: 'unspecified', baseUnit: 'none', displayUnit: null, decimals: null, suffix: '', delimiter: false, cascade: null }],
        },
        querySettings: DEFAULT_QUERY_SETTINGS, davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 12, y: currentY, w: 3, h: 4 },
    );

    addTile(
      {
        type: 'data', title: '',
        query: `${base}\n| filter request.is_failed == false\n| summarize successful_calls = count()`,
        visualization: 'singleValue',
        visualizationSettings: {
          singleValue: {
            label: 'SUCCESSFUL CALLS', recordField: 'successful_calls',
            isIconVisible: true, prefixIcon: 'SuccessIcon',
            trend: { isVisible: true, trendField: 'successful_calls', trendType: 'custom' },
          },
          coloring: { colorRules: [{ colorMode: 'single-color', color: 'var(--dt-colors-charts-apdex-excellent-default, #2a7453)', comparator: '≥', field: 'successful_calls', value: null, type: 'long' }] },
          autoSelectVisualization: false,
          unitsOverrides: [{ identifier: 'successful_calls', unitCategory: 'unspecified', baseUnit: 'none', displayUnit: null, decimals: null, suffix: '', delimiter: false, cascade: null }],
        },
        querySettings: DEFAULT_QUERY_SETTINGS, davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 15, y: currentY, w: 3, h: 4 },
    );

    addTile(
      {
        type: 'data', title: '',
        query: `${base}\n| filter request.is_failed == true\n| summarize failed_calls = count()`,
        visualization: 'singleValue',
        visualizationSettings: {
          singleValue: {
            label: 'FAILED CALLS', recordField: 'failed_calls',
            isIconVisible: true, prefixIcon: 'WarningFailedIcon',
            trend: {
              isVisible: true,
              upward: { Default: 'var(--dt-colors-charts-loglevel-emergency-default, #ae132d)' },
              downward: { Default: 'var(--dt-colors-charts-apdex-excellent-default, #2a7453)' },
              trendField: 'failed_calls', trendType: 'custom',
            },
          },
          coloring: { colorRules: [{ colorMode: 'single-color', color: 'var(--dt-colors-charts-loglevel-emergency-default, #ae132d)', comparator: '≥', field: 'failed_calls', value: null, type: 'long' }] },
          autoSelectVisualization: false,
        },
        querySettings: DEFAULT_QUERY_SETTINGS, davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 18, y: currentY, w: 3, h: 4 },
    );

    addTile(
      {
        type: 'data', title: '',
        query: `${base}\n| summarize total = count(), completed = countIf(request.is_failed == false)\n| fieldsAdd completion_rate = round(toDouble(completed) / toDouble(total) * 100, decimals: 2)\n| fields completion_rate`,
        visualization: 'singleValue',
        visualizationSettings: {
          singleValue: {
            label: 'COMPLETION RATE', recordField: 'completion_rate',
            isIconVisible: true, prefixIcon: 'PercentIcon',
          },
          coloring: {
            colorRules: [
              { colorMode: 'single-color', color: 'var(--dt-colors-charts-apdex-excellent-default, #2a7453)', comparator: '≥', field: 'completion_rate', value: 95, type: 'double' },
              { colorMode: 'single-color', color: 'var(--dt-colors-charts-loglevel-emergency-default, #ae132d)', comparator: '<', field: 'completion_rate', value: 95, type: 'double' },
            ],
          },
          autoSelectVisualization: false,
        },
        querySettings: DEFAULT_QUERY_SETTINGS, davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 21, y: currentY, w: 3, h: 4 },
    );

    currentY += 4;
  }

  if (hasAmount) {
    const unitSuffix = biz.amountUnit ? ` ${biz.amountUnit}` : '';

    // Build a money single-value tile with currency suffix, abbreviation, and MoneyIcon.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountSVTile = (query: string, recordField: string, label: string, colorRules: any[]): DashboardTile => ({
      type: 'data',
      title: '',
      query,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: {
          label,
          recordField,
          isIconVisible: true,
          prefixIcon: 'MoneyIcon',
          colorThresholdTarget: 'background',
          sparklineSettings: { isVisible: false },
          trend: { isVisible: false },
        },
        coloring: { colorRules },
        unitsOverrides: [{
          identifier: recordField,
          unitCategory: 'unspecified',
          baseUnit: 'none',
          displayUnit: null,
          decimals: null,
          suffix: unitSuffix,
          delimiter: true,
          cascade: null,
        }],
      },
      querySettings: DEFAULT_QUERY_SETTINGS,
      davis: DEFAULT_DAVIS,
    });

    if (biz.amountSourceType === 'bizEvent') {
      const safeType = escapeDql(biz.amountEventType.trim());
      const field = biz.amountField.trim();
      const base = `fetch bizevents\n| filter event.type == "${safeType}"`;

      const bizAmountQuery = `${base}\n| makeTimeseries total_amount = sum(${field})`;
      addTile(
        {
          type: 'data',
          title: 'Amount Over Time',
          query: bizAmountQuery,
          visualization: 'davis',
          visualizationSettings: {
            autoSelectVisualization: false,
            chartSettings: { legend: { hidden: true }, gapPolicy: 'connect' },
            unitsOverrides: [],
          },
          querySettings: DEFAULT_QUERY_SETTINGS,
          davis: {
            enabled: true,
            componentState: {
              selectedAnalyzerName: 'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer',
              inputData: {
                'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer': {
                  generalParameters: { resolveDimensionalQueryData: true, logVerbosity: 'INFO' },
                  query: { expression: bizAmountQuery },
                  numberOfSignalFluctuations: 1,
                  alertCondition: 'ABOVE',
                  alertOnMissingData: false,
                  violatingSamples: 3,
                  slidingWindow: 5,
                  dealertingSamples: 5,
                },
              },
            },
            davisVisualization: { isAvailable: true, settings: { visibleSections: 'VISUALIZATION' } },
          },
        } as DashboardTile,
        { x: 0, y: currentY, w: 12, h: 4 },
      );

      addTile(amountSVTile(`${base}\n| summarize total_amount = sum(${field})`, 'total_amount', 'TOTAL AMOUNT', [{ value: 0, comparator: '≥', field: 'total_amount', type: 'double', colorMode: 'custom-color', customColor: { Default: '#8b6ecf' } }]), { x: 12, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize amount_processed = sum(if(isNull(error.code), ${field}, else: 0.0))`, 'amount_processed', 'AMOUNT PROCESSED', [{ value: 0, comparator: '≥', field: 'amount_processed', type: 'double', colorMode: 'custom-color', customColor: { Default: '#2a7453' } }]), { x: 15, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize amount_impacted = sum(if(isNotNull(error.code), ${field}, else: 0.0))`, 'amount_impacted', 'AMOUNT IMPACTED', [{ value: 0, comparator: '≥', field: 'amount_impacted', type: 'double', colorMode: 'custom-color', customColor: { Default: '#ae132d' } }]), { x: 18, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize avg_amount = avg(${field})`, 'avg_amount', 'AVG AMOUNT', [{ value: 0, comparator: '≥', field: 'avg_amount', type: 'double', colorMode: 'single-color', color: 'var(--dt-colors-charts-loglevel-info-default, #4496f2)' }]), { x: 21, y: currentY, w: 3, h: 4 });
    } else {
      const raRaw = biz.amountRaName.trim();
      const raRef = (raRaw.startsWith("request_attribute.") || raRaw.startsWith("dt.request_attribute.") || raRaw.startsWith("captured_attribute.")) ? raRaw : `request_attribute.${raRaw}`;
      const base = `fetch spans\n| filter request.is_root_span == true\n| filter isNotNull(${raRef})`;

      const raAmountQuery = `${base}\n| makeTimeseries total_amount = sum(${raRef})`;
      addTile(
        {
          type: 'data',
          title: 'Amount Over Time',
          query: raAmountQuery,
          visualization: 'davis',
          visualizationSettings: {
            autoSelectVisualization: false,
            chartSettings: { legend: { hidden: true }, gapPolicy: 'connect' },
            unitsOverrides: [],
          },
          querySettings: DEFAULT_QUERY_SETTINGS,
          davis: {
            enabled: true,
            componentState: {
              selectedAnalyzerName: 'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer',
              inputData: {
                'dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer': {
                  generalParameters: { resolveDimensionalQueryData: true, logVerbosity: 'INFO' },
                  query: { expression: raAmountQuery },
                  numberOfSignalFluctuations: 1,
                  alertCondition: 'ABOVE',
                  alertOnMissingData: false,
                  violatingSamples: 3,
                  slidingWindow: 5,
                  dealertingSamples: 5,
                },
              },
            },
            davisVisualization: { isAvailable: true, settings: { visibleSections: 'VISUALIZATION' } },
          },
        } as DashboardTile,
        { x: 0, y: currentY, w: 12, h: 4 },
      );

      addTile(amountSVTile(`${base}\n| summarize total_amount = sum(${raRef})`, 'total_amount', 'TOTAL AMOUNT', [{ value: 0, comparator: '≥', field: 'total_amount', type: 'double', colorMode: 'custom-color', customColor: { Default: '#8b6ecf' } }]), { x: 12, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize amount_processed = sum(if(request.is_failed == false, ${raRef}, else: 0.0))`, 'amount_processed', 'AMOUNT PROCESSED', [{ value: 0, comparator: '≥', field: 'amount_processed', type: 'double', colorMode: 'custom-color', customColor: { Default: '#2a7453' } }]), { x: 15, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize amount_impacted = sum(if(request.is_failed == true, ${raRef}, else: 0.0))`, 'amount_impacted', 'AMOUNT IMPACTED', [{ value: 0, comparator: '≥', field: 'amount_impacted', type: 'double', colorMode: 'custom-color', customColor: { Default: '#ae132d' } }]), { x: 18, y: currentY, w: 3, h: 4 });
      addTile(amountSVTile(`${base}\n| summarize avg_amount = avg(${raRef})`, 'avg_amount', 'AVG AMOUNT', [{ value: 0, comparator: '≥', field: 'avg_amount', type: 'double', colorMode: 'single-color', color: 'var(--dt-colors-charts-loglevel-info-default, #4496f2)' }]), { x: 21, y: currentY, w: 3, h: 4 });
    }
  }
}

function calcBizHeight(biz?: BizIndicatorsConfig): number {
  if (!biz) return 0;
  const hasVolume = biz.volumeEndpoint.trim().length > 0;
  const hasAmount =
    biz.amountSourceType !== '' &&
    biz.amountField.trim().length > 0 &&
    (biz.amountSourceType === 'bizEvent'
      ? biz.amountEventType.trim().length > 0
      : biz.amountRaName.trim().length > 0);
  if (!hasVolume && !hasAmount) return 0;
  // header(2) + volume row(4) + amount row(4), only counting rows that exist
  return 2 + (hasVolume ? 4 : 0) + (hasAmount ? 4 : 0);
}

function buildDashboard(
  title: string,
  endpoints: JourneyEndpoint[],
  arrowUrl?: string | null,
  bizIndicators?: BizIndicatorsConfig,
): DashboardJson {
  const tiles: Record<string, DashboardTile> = {};
  const layouts: Record<string, DashboardLayout> = {};
  let nextId = 1;
  const addTile = (tile: DashboardTile, layout: DashboardLayout) => {
    const id = String(nextId++);
    tiles[id] = tile;
    layouts[id] = layout;
  };

  const bizH = calcBizHeight(bizIndicators);
  // Space (1) + journey section header (2) inserted between biz section and steps.
  const JOURNEY_HEADER_H = 3;

  // Title-only markdown tile
  addTile(
    markdownTile(`# ${title}`),
    { x: 0, y: SECTION_TOP, w: 24, h: TITLE_H },
  );

  // Business Indicators section — immediately after title
  if (bizIndicators) {
    buildBizIndicatorsTiles(bizIndicators, SECTION_TOP + TITLE_H, addTile);
  }

  // Spacer + journey section header between biz indicators and steps
  const journeyHeaderY = SECTION_TOP + TITLE_H + bizH;
  addTile(markdownTile(` `), { x: 0, y: journeyHeaderY, w: 24, h: 1 });
  const stepDesc = endpoints
    .map((ep) => ep.stepName?.trim() || ep.name.trim())
    .filter(Boolean)
    .join(" → ");
  addTile(
    markdownTile(`## ⏩ ${title}\n* Page-by-page health monitoring across the selected journey endpoints${stepDesc ? `: ${stepDesc}` : ""}\n---\n `),
    { x: 0, y: journeyHeaderY + 1, w: 24, h: 2 },
  );

  // Step name headers with arrow icons between steps.
  // Non-last steps use w=COLUMN_WIDTH-1 so a 1-column arrow tile fits beside them.
  // The same reduced width (stepW) applies to ALL per-step tiles below so the
  // gap column extends consistently through every row of the dashboard.
  endpoints.forEach((ep, idx) => {
    const x = idx * COLUMN_WIDTH;
    const isLast = idx === endpoints.length - 1;
    const stepLabel = ep.stepName?.trim() || ep.name.trim() || `Step ${idx + 1}`;
    const epName = ep.name.trim() || `Step ${idx + 1}`;
    addTile(
      markdownTile(`## ${idx + 1}. ${stepLabel}\n---\n_Endpoint:_ \`${epName}\``),
      { x, y: STEP_HEADER_Y + bizH + JOURNEY_HEADER_H, w: isLast ? COLUMN_WIDTH : COLUMN_WIDTH - 1, h: STEP_HEADER_H },
    );
    if (!isLast && arrowUrl) {
      addTile(
        markdownTile(`![→|100%](${arrowUrl})`),
        { x: x + COLUMN_WIDTH - 1, y: STEP_HEADER_Y + bizH + JOURNEY_HEADER_H, w: 1, h: STEP_HEADER_H },
      );
    }
  });

  // Journey overview bar chart — width matches number of journey steps
  const overviewQuery = buildJourneyOverviewQuery(endpoints);
  const chartWidth = endpoints.length * COLUMN_WIDTH;
  if (overviewQuery) {
    addTile(
      journeyOverviewTile(overviewQuery),
      { x: 0, y: OVERVIEW_Y + bizH + JOURNEY_HEADER_H, w: chartWidth, h: OVERVIEW_H },
    );
  }

  endpoints.forEach((ep, idx) => {
    const x = idx * COLUMN_WIDTH;
    const isLast = idx === endpoints.length - 1;
    const stepW = isLast ? COLUMN_WIDTH : COLUMN_WIDTH - 1;
    const halfW = Math.floor(stepW / 2);
    const epName = ep.name.trim();
    const display = epName || `Step ${idx + 1}`;
    addTile(
      singleValueTileWithDecimals("", buildHealthQuery(display), "problems", "🛠️ IT ISSUES", HEALTH_COLOR_RULES, 0),
      { x, y: STATUS_ROW_Y + bizH + JOURNEY_HEADER_H, w: halfW, h: STATUS_ROW_H },
    );
    addTile(
      singleValueTileWithDecimals("", buildSecurityQuery(display), "score", "🔒 SECURITY", SECURITY_COLOR_RULES, 0),
      { x: x + halfW, y: STATUS_ROW_Y + bizH + JOURNEY_HEADER_H, w: stepW - halfW, h: STATUS_ROW_H },
    );
    addTile(
      markdownTile(`### 💼 Business KPI\n_TBD — configure later_`),
      { x, y: KPI_PLACEHOLDER_Y + bizH + JOURNEY_HEADER_H, w: stepW, h: KPI_PLACEHOLDER_H },
    );

    ep.metrics.forEach((metric, mIdx) => {
      const my = METRIC_START_Y + bizH + JOURNEY_HEADER_H + mIdx * METRIC_H;
      addTile(
        customTile(metric.label || metric.eventType || "Business metric", metric.query, metric.visualization),
        { x, y: my, w: stepW, h: METRIC_H },
      );
    });
  });

  // Spacer after steps section
  {
    const maxMetrics = Math.max(0, ...endpoints.map((ep) => ep.metrics.length));
    const spacerY = METRIC_START_Y + bizH + JOURNEY_HEADER_H + maxMetrics * METRIC_H;
    addTile(markdownTile(` `), { x: 0, y: spacerY, w: 24, h: 1 });
  }

  // ── Failed Transaction Details section ─────────────────────────────────────
  // Positioned below all step columns. Spans all 24 columns.
  const validEndpoints = endpoints.filter((ep) => ep.name.trim().length > 0);
  if (validEndpoints.length > 0) {
    const maxMetrics = Math.max(0, ...endpoints.map((ep) => ep.metrics.length));
    // +1 for the spacer tile after the steps section
    const failedSectionY = METRIC_START_Y + bizH + JOURNEY_HEADER_H + maxMetrics * METRIC_H + 1;
    const epList = validEndpoints.map((ep) => `"${escapeDql(ep.name.trim())}"`).join(", ");
    const stepDesc = validEndpoints
      .map((ep, i) => `${i + 1}. ${ep.stepName?.trim() || ep.name.trim()}`)
      .join(" → ");

    // Section header
    addTile(
      markdownTile(`## ⛔ Failed Transaction Details\n* Failure monitoring across the selected journey endpoints: ${stepDesc}\n---\n `),
      { x: 0, y: failedSectionY, w: 24, h: 2 },
    );

    const FAILED_CHART_Y = failedSectionY + 2;
    const FAILED_TABLE_Y = FAILED_CHART_Y + 5;

    // System Transactions Over Time (area chart, w=18)
    addTile(
      {
        type: "data",
        title: "System Transactions Over Time (Success vs Failed)",
        query: `fetch spans
| filter request.is_root_span == true
| filter in(endpoint.name, ${epList})
| fieldsAdd status = if(request.is_failed == true, "Failed", else: "Success")
| makeTimeseries count(), by: { status }`,
        visualization: "areaChart",
        visualizationSettings: {
          chartSettings: {
            legend: { hidden: true },
            gapPolicy: "connect",
          },
          coloring: {
            colorRules: [
              { colorMode: "single-color", comparator: "= *value*", field: "status", type: "string", value: "Failed", color: "var(--dt-colors-charts-loglevel-emergency-default, #ae132d)" },
              { colorMode: "single-color", comparator: "= *value*", field: "status", value: "Success", type: "string", color: "var(--dt-colors-charts-apdex-excellent-default, #2a7453)" },
            ],
          },
          autoSelectVisualization: false,
          unitsOverrides: [],
        },
        querySettings: DEFAULT_QUERY_SETTINGS,
        davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 0, y: FAILED_CHART_Y, w: 18, h: 5 },
    );

    // Status Overview donut (w=6)
    addTile(
      {
        type: "data",
        title: "📊 Status Overview",
        query: `fetch spans
| filter request.is_root_span == true
| filter in(endpoint.name, ${epList})
| summarize count = count(), by: { status = if(request.is_failed == true, "Failed", else: "Success") }`,
        visualization: "donutChart",
        visualizationSettings: {
          chartSettings: {
            legend: { hidden: true },
            circleChartSettings: { valueType: "relative", showTotalValue: true },
          },
          coloring: {
            colorRules: [
              { colorMode: "custom-color", customColor: "#2AB06F", type: "string", field: "DT.name", comparator: "=", value: "Success" },
              { colorMode: "custom-color", customColor: "#E41B12", type: "string", field: "DT.name", comparator: "=", value: "Failed" },
            ],
          },
          unitsOverrides: [],
        },
        querySettings: DEFAULT_QUERY_SETTINGS,
        davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 18, y: FAILED_CHART_Y, w: 6, h: 5 },
    );

    // Recent Failed Transaction Details table (w=18)
    addTile(
      {
        type: "data",
        title: "🔴 Recent Failed Transaction Details",
        query: `fetch spans
| filter request.is_root_span == true
| filter request.is_failed == true
| filter in(endpoint.name, ${epList})
| fieldsAdd
    error_message = coalesce(
        exception.message,
        http.status_text,
        span.status_message,
        if(isNotNull(http.response.status_code), concat("HTTP ", toString(http.response.status_code))),
        if(isNotNull(rpc.grpc.status_code), concat("gRPC status ", toString(rpc.grpc.status_code))),
        "Failed"
    )
| fields
    start_time,
    service_name = service.name,
    status = "Failed",
    error_message,
    trace_id = toString(trace.id)
| sort start_time desc
| limit 50`,
        visualization: "table",
        visualizationSettings: {
          table: {
            linewrapEnabled: true,
            sortBy: [{ columnId: "[\"start_time\"]", direction: "descending" }],
            columnOrder: ["[\"start_time\"]", "[\"status\"]", "[\"service_name\"]", "[\"error_message\"]", "[\"trace_id\"]"],
          },
          coloring: {
            colorRules: [
              { value: "Failed", comparator: "=", field: "status", colorMode: "custom-color", customColor: { Default: "#E41B12" }, metadata: { applyTo: "cell", fields: ["status"] } },
            ],
          },
          autoSelectVisualization: false,
          unitsOverrides: [],
        },
        querySettings: DEFAULT_QUERY_SETTINGS,
        davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 0, y: FAILED_TABLE_Y, w: 18, h: 6 },
    );

    // Failure Reasons pie chart (w=6)
    addTile(
      {
        type: "data",
        title: "⚠️ Failure Reasons",
        query: `fetch spans
| filter request.is_root_span == true
| filter request.is_failed == true
| filter in(endpoint.name, ${epList})
| fieldsAdd
    error_message = coalesce(
        exception.message,
        http.status_text,
        span.status_message,
        if(isNotNull(http.response.status_code), concat("HTTP ", toString(http.response.status_code))),
        if(isNotNull(rpc.grpc.status_code), concat("gRPC status ", toString(rpc.grpc.status_code))),
        "Failed"
    )
| summarize count = count(), by: { error_message }
| sort count desc`,
        visualization: "pieChart",
        visualizationSettings: {
          chartSettings: {
            legend: { ratio: 30 },
            circleChartSettings: { valueType: "relative" },
          },
          unitsOverrides: [],
        },
        querySettings: DEFAULT_QUERY_SETTINGS,
        davis: DEFAULT_DAVIS,
      } as DashboardTile,
      { x: 18, y: FAILED_TABLE_Y, w: 6, h: 6 },
    );
  }

  return {
    version: 21,
    variables: [],
    tiles,
    layouts,
    importedWithCode: false,
    settings: {},
    annotations: [],
  };
}

// ─── Grail discovery hooks ────────────────────────────────────────────────────

interface OptionRow {
  // `value` is what gets stored on the journey step / metric and what gets
  // plugged into downstream DQL. `label` is the human-readable display text
  // shown inside the dropdown option (e.g. "req_amount — POST /Booking").
  value: string;
  label: string;
  count: number;
}

function useEndpointOptions(): { options: OptionRow[]; isLoading: boolean; error: unknown } {
  // Two-source discovery so the dropdown matches what the Discover Metrics
  // tab can surface across the whole fleet:
  //   1. `fetch spans`  — covers OpenTelemetry-instrumented services.
  //   2. `dt.service.request.count` metric — covers OneAgent-only services
  //      (they don't emit OTel spans but the metric is always populated).
  // Merge & dedupe by endpoint.name client-side, summing call counts and
  // collecting up to two service names per endpoint for the display label.
  const spansQuery = `fetch spans, from:now()-2h
| filter span.kind == "server" and isNotNull(endpoint.name) and endpoint.name != "NON_KEY_REQUESTS"
| summarize calls = count(), by: { route = endpoint.name, service = service.name }
| filter calls > 0
| sort calls desc
| limit 100`;

  const metricQuery = `timeseries req = sum(dt.service.request.count, scalar: true),
  by: { dt.entity.service, service.name, endpoint.name },
  filter: isNotNull(endpoint.name) AND endpoint.name != "NON_KEY_REQUESTS",
  from: now()-2h
| summarize { calls = sum(req) }, by: { dt.entity.service, service = service.name, route = endpoint.name }
| filter calls > 0
| sort calls desc
| limit 100`;

  const { data: spansData, isLoading: spansLoading, error: spansError } = useDql({
    query: spansQuery,
  });
  const { data: metricData, isLoading: metricLoading, error: metricError } = useDql({
    query: metricQuery,
  });

  const options = useMemo<OptionRow[]>(() => {
    const merged = new Map<
      string,
      { value: string; count: number; services: Set<string> }
    >();
    const add = (route: string, service: string, calls: number) => {
      const r = route.trim();
      if (!r) return;
      let entry = merged.get(r);
      if (!entry) {
        entry = { value: r, count: 0, services: new Set() };
        merged.set(r, entry);
      }
      entry.count += calls;
      const svc = service.trim();
      if (svc) entry.services.add(svc);
    };
    const consume = (records: unknown) => {
      const arr = Array.isArray(records) ? records : [];
      for (const rec of arr) {
        const r = rec as Record<string, unknown> | null | undefined;
        add(
          String(r?.route ?? ""),
          String(r?.service ?? ""),
          Number(r?.calls ?? 0),
        );
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consume((spansData as any)?.records);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    consume((metricData as any)?.records);
    return Array.from(merged.values())
      .map((e) => {
        const svcList = Array.from(e.services).slice(0, 2);
        const extra = e.services.size > svcList.length
          ? ` +${e.services.size - svcList.length} more`
          : "";
        const svcLabel = svcList.length
          ? `  ·  ${svcList.join(", ")}${extra}`
          : "";
        return {
          value: e.value,
          label: `${e.value}${svcLabel}  ·  ${e.count.toLocaleString()} calls`,
          count: e.count,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 200);
  }, [spansData, metricData]);

  return {
    options,
    isLoading: spansLoading || metricLoading,
    error: spansError || metricError,
  };
}

// Business-field discovery from settings. Every rule this app created has
// `event.type.source` starting with `dt-business-discovery.` — we walk those
// rules and emit one OptionRow per captured (non-wildcard) field. The
// dropdown shows "<field name> — <rule name>" and the option value is the
// composite `<eventType>::<fieldName>` so the wizard can split it back out.
const BIZ_DISCOVERY_SCHEMA = "builtin:bizevents.http.incoming";
const BIZ_DISCOVERY_PREFIX = "dt-business-discovery.";
const WILDCARD_FIELD_NAMES = new Set([
  "allrequest",
  "allresponse",
  "allqueryparameters",
  "allrequestheaders",
]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isBusinessWildcardField(d: any): boolean {
  const topPath = typeof d?.path === "string" ? d.path : "";
  const srcPath = typeof d?.source?.path === "string" ? d.source.path : "";
  if (topPath === "*" || srcPath === "*") return true;
  const n = String(d?.name ?? "").toLowerCase();
  if (!topPath && !srcPath && WILDCARD_FIELD_NAMES.has(n)) return true;
  return false;
}

export interface BusinessFieldOption extends OptionRow {
  eventType: string;
  fieldName: string;
  ruleName: string;
}

function useBusinessFieldOptions(): {
  options: BusinessFieldOption[];
  isLoading: boolean;
  error: unknown;
} {
  const [options, setOptions] = useState<BusinessFieldOption[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    settingsObjectsClient
      .getSettingsObjects({
        schemaIds: BIZ_DISCOVERY_SCHEMA,
        fields: "objectId,schemaId,value",
      })
      .then((resp) => {
        if (cancelled) return;
        const items = resp.items ?? [];
        const acc: BusinessFieldOption[] = [];
        for (const item of items) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const v = item.value as Record<string, any> | undefined;
          if (!v) continue;
          const source = String(v?.event?.type?.source ?? "");
          if (!source) continue;
          const ruleName = String(v?.ruleName ?? "");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data: any[] = Array.isArray(v?.event?.data) ? v.event.data : [];
          for (const d of data) {
            if (isBusinessWildcardField(d)) continue;
            const fieldName = String(d?.name ?? "").trim();
            if (!fieldName) continue;
            acc.push({
              eventType: source,
              fieldName,
              ruleName,
              value: `${source}::${fieldName}`,
              label: `${fieldName}  —  ${ruleName || source}`,
              count: 0,
            });
          }
        }
        acc.sort((a, b) =>
          a.fieldName.localeCompare(b.fieldName) ||
          a.ruleName.localeCompare(b.ruleName),
        );
        setOptions(acc);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { options, isLoading, error };
}

export interface RequestAttributeOption extends OptionRow {
  name: string;
}

// Discover request attributes for an endpoint using a two-pass approach:
// Pass 1 — get trace IDs from spans on the selected endpoint.
// Pass 2 — fetch ALL spans in those traces (including nested child spans).
// This finds RAs set on downstream calls within the same trace, e.g. a
// storeBooking child span that carries BookingDouble when the parent is
// /orange-booking-finish.jsf.
function useRequestAttributeOptions(endpointName: string): {
  options: RequestAttributeOption[];
  isLoading: boolean;
  error: unknown;
} {
  const safe = endpointName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Pass 1: fetch endpoint spans directly — captures RAs set on the endpoint span itself.
  // Also collect trace IDs for the child-span pass below.
  const traceIdQuery = endpointName
    ? `fetch spans
| filter in(span.kind, "server", "internal") AND endpoint.name == "${safe}"
| limit 200`
    : `fetch spans | limit 0`;

  const { data: traceData, isLoading: traceLoading, error: traceError } = useDql({ query: traceIdQuery });

  const traceIds = useMemo<string[]>(() => {
    if (!traceData?.records) return [];
    const ids = traceData.records
      .map((r) => (r as Record<string, unknown>)?.["trace.id"] as string | undefined)
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)].slice(0, 50);
  }, [traceData]);

  // Pass 2: fetch all spans in those traces (includes child/nested spans).
  // This finds RAs set on downstream calls within the same trace, e.g. a
  // storeBooking child span that carries BookingDouble when the parent is /orange-booking-finish.jsf.
  // trace.id is a uid type — must use toString() for string comparison with in().
  const spansQuery = traceIds.length > 0
    ? `fetch spans
| filter in(span.kind, "server", "internal")
| filter in(toString(trace.id), ${traceIds.map((id) => `"${id}"`).join(", ")})
| limit 1000`
    : `fetch spans | limit 0`;

  const { data: spansData, isLoading: spansLoading, error: spansError } = useDql({ query: spansQuery });

  const isLoading = traceLoading || (traceIds.length > 0 && spansLoading);
  const error = traceError ?? (traceIds.length > 0 ? spansError : undefined);

  const options = useMemo<RequestAttributeOption[]>(() => {
    if (!endpointName) return [];
    // Map from display name → full field path (first seen wins; prefer request_attribute over captured_attribute).
    const raMap = new Map<string, string>();
    const allRecords = [...(traceData?.records ?? []), ...(spansData?.records ?? [])];
    for (const rec of allRecords) {
      for (const k of Object.keys(rec as object)) {
        let name: string | null = null;
        if (k.startsWith("dt.request_attribute.")) name = k.slice("dt.request_attribute.".length);
        else if (k.startsWith("request_attribute.")) name = k.slice("request_attribute.".length);
        else if (k.startsWith("captured_attribute.")) name = k.slice("captured_attribute.".length);
        if (!name) continue;
        // Prefer request_attribute prefix if already found; otherwise record what we have.
        if (!raMap.has(name) || k.startsWith("request_attribute.") || k.startsWith("dt.request_attribute.")) {
          raMap.set(name, k);
        }
      }
    }
    return Array.from(raMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, fieldPath]) => ({ name, value: fieldPath, label: name, count: 0 }));
  }, [endpointName, traceData, spansData]);

  return { options, isLoading, error };
}

function useNumericFieldOptions(eventType: string): { options: string[]; isLoading: boolean } {
  // Only fire the query when an event.type has been chosen.
  const query = eventType
    ? `fetch bizevents, from:now()-24h
| filter event.type == "${escapeDql(eventType)}"
| limit 200`
    : "fetch bizevents | limit 0";
  const { data, isLoading } = useDql(query, { enabled: Boolean(eventType) });
  const options = useMemo<string[]>(() => {
    if (!eventType || !data?.records) return [];
    const numericFields = new Set<string>();
    for (const rec of data.records) {
      if (!rec) continue;
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === "number" && Number.isFinite(v)) numericFields.add(k);
      }
    }
    return [...numericFields]
      .filter((f) => !f.startsWith("dt.") && !f.startsWith("event."))
      .sort();
  }, [data, eventType]);
  return { options, isLoading };
}

// ─── Visual layout preview ────────────────────────────────────────────────────

// Mini bar-chart preview for the journey-overview tile. Shows one fake
// bar per step with a green "healthy" segment + a red "errors" sliver so
// the user can visualise the dashboard tile before it's generated.
const GREEN = "#22c55e";
const RED = "#ef4444";

function OverviewPreview({ endpoints }: { endpoints: JourneyEndpoint[] }) {
  const filled = endpoints
    .map((e, idx) => ({ name: (e.stepName?.trim() || e.name?.trim()) ?? "", idx }))
    .filter((e) => e.name.length > 0);
  // Deterministic pseudo-random heights so the preview is stable per name.
  const hash = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  // Funnel: each step is shorter than the previous — step 0 = 100%, step 3 = ~45%
  const funnelScale = [1.0, 0.78, 0.60, 0.45];
  const bars = filled.map((e) => {
    const h = hash(e.name || `${e.idx}`);
    const scale = funnelScale[e.idx] ?? 0.45;
    const baseHealthy = 65 + (h % 20);
    const baseError = Math.max(2, Math.min(15, (h >> 4) % 12));
    const healthyPct = Math.round(baseHealthy * scale);
    const errorPct = Math.max(1, Math.round(baseError * scale));
    return { name: e.name, idx: e.idx, healthyPct, errorPct };
  });
  return (
    <div
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        background: Colors.Background.Container.Neutral.Default,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <Flex justifyContent="space-between" alignItems="center">
        <Text style={{ fontSize: "11px", fontWeight: 600 }}>
          📊 Requests per step (healthy vs errors)
        </Text>
        <Flex gap={8} alignItems="center">
          <Flex gap={4} alignItems="center">
            <span style={{ display: "inline-block", width: 10, height: 10, background: GREEN, borderRadius: 2 }} />
            <Text style={{ fontSize: "10px", color: GREEN, fontWeight: 600 }}>healthy</Text>
          </Flex>
          <Flex gap={4} alignItems="center">
            <span style={{ display: "inline-block", width: 10, height: 10, background: RED, borderRadius: 2 }} />
            <Text style={{ fontSize: "10px", color: RED, fontWeight: 600 }}>errors</Text>
          </Flex>
        </Flex>
      </Flex>
      {bars.length === 0 ? (
        <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
          Pick at least one endpoint to preview the per-step bar chart.
        </Text>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
            alignItems: "end",
            height: 90,
          }}
        >
          {Array.from({ length: MAX_ENDPOINTS }, (_, slotIdx) => {
            const b = bars.find((bar) => bar.idx === slotIdx);
            if (!b) {
              return <div key={slotIdx} style={{ height: "100%" }} />;
            }
            const total = b.healthyPct + b.errorPct;
            return (
              <div
                key={slotIdx}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  alignItems: "center",
                  height: "100%",
                  justifyContent: "flex-end",
                }}
              >
                <div
                  style={{
                    width: "60%",
                    height: `${total}%`,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ background: RED, height: `${(b.errorPct / total) * 100}%` }} />
                  <div style={{ background: GREEN, height: `${(b.healthyPct / total) * 100}%` }} />
                </div>
                <Text style={{ fontSize: "10px", textAlign: "center" }}>{`${b.idx + 1}. ${b.name}`}</Text>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Business Indicators Preview & Editor ─────────────────────────────────────

function BizIndicatorsPreview({
  config,
  onEdit,
}: {
  config: BizIndicatorsConfig;
  onEdit: () => void;
}) {
  const hasVolume = config.volumeEndpoint.trim().length > 0;
  const hasAmount =
    config.amountSourceType !== '' &&
    config.amountField.trim().length > 0 &&
    (config.amountSourceType === 'bizEvent'
      ? config.amountEventType.trim().length > 0
      : config.amountRaName.trim().length > 0);
  const miniCardStyle: React.CSSProperties = {
    border: `1px solid ${Colors.Border.Neutral.Default}`,
    borderRadius: 3,
    background: Colors.Background.Container.Neutral.Default,
    padding: "3px 5px",
    overflow: "hidden",
  };

  const statBox = (color: string): React.CSSProperties => ({
    background: color,
    borderRadius: 3,
    padding: "4px 4px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  });

  const numStyle: React.CSSProperties = {
    fontSize: "12px",
    fontWeight: 700,
    color: "#fff",
  };

  const lblStyle: React.CSSProperties = {
    fontSize: "7px",
    color: "rgba(255,255,255,0.8)",
    textAlign: "center",
    textTransform: "uppercase" as const,
    lineHeight: 1.2,
  };

  const actionBtnStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: 3,
    fontSize: "12px",
    lineHeight: 1,
    opacity: 0.8,
  };

  return (
    <div
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        background: Colors.Background.Container.Neutral.Default,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <Flex justifyContent="space-between" alignItems="center">
        <Text style={{ fontSize: "11px", fontWeight: 600 }}>📊 Business Indicators</Text>
        <button onClick={onEdit} style={actionBtnStyle} title="Configure Business Indicators">✏️</button>
      </Flex>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ opacity: hasVolume ? 1 : 0.35 }}>
          <Text style={{ fontSize: "9px", color: Colors.Text.Neutral.Default, marginBottom: 3, display: "block" }}>
            {hasVolume ? `Volume — ${config.volumeEndpoint}` : "Volume — configure endpoint to enable"}
          </Text>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", gap: 4 }}>
            <div style={miniCardStyle}>
              <svg viewBox="0 0 100 28" style={{ width: "100%", height: 28, display: "block" }}>
                <path d="M0,22 C20,16 40,10 60,13 S80,6 100,9 L100,28 L0,28 Z" fill="#2a7453" opacity="0.75" />
                <path d="M0,27 C20,25 40,26 60,24 S80,25 100,26 L100,28 L0,28 Z" fill="#ae132d" opacity="0.9" />
              </svg>
            </div>
            <div style={statBox("#8b6ecf")}><span style={numStyle}>–</span><span style={lblStyle}>TOTAL CALLS</span></div>
            <div style={statBox("#2a7453")}><span style={numStyle}>–</span><span style={lblStyle}>SUCCESSFUL</span></div>
            <div style={statBox("#ae132d")}><span style={numStyle}>–</span><span style={lblStyle}>FAILED</span></div>
            <div style={statBox("#1a7360")}><span style={numStyle}>–%</span><span style={lblStyle}>COMPLETION</span></div>
          </div>
        </div>

        <div style={{ opacity: hasAmount ? 1 : 0.35 }}>
          <Text style={{ fontSize: "9px", color: Colors.Text.Neutral.Default, marginBottom: 3, display: "block" }}>
            {hasAmount ? `Amount — ${config.amountField}${config.amountUnit ? ` (${config.amountUnit})` : ""}` : "Amount — configure field to enable"}
          </Text>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", gap: 4 }}>
            <div style={miniCardStyle}>
              <svg viewBox="0 0 100 28" style={{ width: "100%", height: 28, display: "block" }}>
                <path d="M0,18 C20,12 40,8 60,11 S80,5 100,8 L100,28 L0,28 Z" fill="#8b6ecf" opacity="0.75" />
              </svg>
            </div>
            <div style={statBox("#8b6ecf")}><span style={numStyle}>–</span><span style={lblStyle}>TOTAL AMT</span></div>
            <div style={statBox("#2a7453")}><span style={numStyle}>–</span><span style={lblStyle}>PROCESSED</span></div>
            <div style={statBox("#ae132d")}><span style={numStyle}>–</span><span style={lblStyle}>IMPACTED</span></div>
            <div style={statBox("#1a7360")}><span style={numStyle}>–</span><span style={lblStyle}>AVG AMOUNT</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BizIndicatorsEditor({
  config,
  onChange,
  onClose,
  endpointOptions,
  endpointLoading,
  endpointError,
  businessFieldOptions,
  businessFieldsLoading,
  businessFieldsError,
}: {
  config: BizIndicatorsConfig;
  onChange: (next: BizIndicatorsConfig) => void;
  onClose: () => void;
  endpointOptions: OptionRow[];
  endpointLoading: boolean;
  endpointError: unknown;
  businessFieldOptions: BusinessFieldOption[];
  businessFieldsLoading: boolean;
  businessFieldsError: unknown;
}) {
  // RA options are discovered dynamically based on the selected RA endpoint.
  const { options: raOptions, isLoading: raLoading, error: raError } =
    useRequestAttributeOptions(config.amountSourceType === 'requestAttribute' ? config.amountRaEndpoint : '');

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 4,
    border: `1px solid ${active ? "#3b82f6" : Colors.Border.Neutral.Default}`,
    background: active ? "#1e3a5f" : "transparent",
    color: Colors.Text.Neutral.Default,
    cursor: "pointer",
    fontSize: "12px",
  });

  // For the bizEvent dropdown, options are BusinessFieldOption rows, where
  // value = "eventType::fieldName" and label = "fieldName  —  ruleName".
  const bizFieldOptionRows: OptionRow[] = businessFieldOptions.map((o) => ({
    value: o.value,
    label: o.label,
    count: 0,
  }));
  const selectedBizValue = config.amountEventType && config.amountField
    ? `${config.amountEventType}::${config.amountField}`
    : '';

  return (
    <Surface>
      <Flex flexDirection="column" gap={16} padding={20}>
        <Flex justifyContent="space-between" alignItems="center">
          <Strong>📊 Business Indicators</Strong>
          <Button variant="default" onClick={onClose}>Done</Button>
        </Flex>

        <Flex flexDirection="column" gap={6}>
          <Text style={{ fontSize: "13px", fontWeight: 600 }}>Volume Row — Transaction Counts</Text>
          <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
            Generates: area chart + Total Calls + Successful Calls + Failed Calls + Completion Rate
          </Text>
          <DiscoverySelect
            value={config.volumeEndpoint}
            options={endpointOptions}
            isLoading={endpointLoading}
            error={endpointError}
            placeholder="Search server endpoints…"
            emptyMessage="No server-side endpoints found in the last 24h."
            onChange={(v) => onChange({ ...config, volumeEndpoint: v })}
          />
        </Flex>

        <div style={{ height: 1, background: Colors.Border.Neutral.Default }} />

        <Flex flexDirection="column" gap={8}>
          <Text style={{ fontSize: "13px", fontWeight: 600 }}>Amount Row — Monetary Values</Text>
          <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
            Generates: area chart + Total Amount + Amount Processed + Amount Impacted + Avg Amount
          </Text>

          <Flex gap={4} alignItems="center" flexWrap="wrap">
            <Text style={{ fontSize: "12px", flexShrink: 0 }}>Source:</Text>
            <button style={toggleBtnStyle(config.amountSourceType === 'bizEvent')} onClick={() => onChange({ ...config, amountSourceType: 'bizEvent', amountEventType: '', amountField: '' })}>Business Event</button>
            <button style={toggleBtnStyle(config.amountSourceType === 'requestAttribute')} onClick={() => onChange({ ...config, amountSourceType: 'requestAttribute', amountRaEndpoint: '', amountRaName: '', amountField: '' })}>Request Attribute</button>
            {config.amountSourceType && (
              <button
                style={{ ...toggleBtnStyle(false), opacity: 0.6, fontSize: "11px" }}
                onClick={() => onChange({ ...config, amountSourceType: '', amountEventType: '', amountRaName: '', amountRaEndpoint: '', amountField: '', amountUnit: '' })}
              >✕ Clear</button>
            )}
          </Flex>

          {config.amountSourceType === 'bizEvent' && (
            <Flex flexDirection="column" gap={4}>
              <Text style={{ fontSize: "12px", fontWeight: 600 }}>Captured business field (field name · rule name):</Text>
              <DiscoverySelect
                value={selectedBizValue}
                options={bizFieldOptionRows}
                isLoading={businessFieldsLoading}
                error={businessFieldsError}
                placeholder="Search captured business fields…"
                emptyMessage="No captured business fields yet — configure one from the Discover tab first."
                onChange={(v) => {
                  if (!v) { onChange({ ...config, amountEventType: '', amountField: '' }); return; }
                  const hit = businessFieldOptions.find((o) => o.value === v);
                  if (hit) onChange({ ...config, amountEventType: hit.eventType, amountField: hit.fieldName });
                }}
              />
            </Flex>
          )}

          {config.amountSourceType === 'requestAttribute' && (
            <>
              <Flex flexDirection="column" gap={4}>
                <Text style={{ fontSize: "12px", fontWeight: 600 }}>Endpoint (to discover request attributes):</Text>
                <DiscoverySelect
                  value={config.amountRaEndpoint}
                  options={endpointOptions}
                  isLoading={endpointLoading}
                  error={endpointError}
                  placeholder="Search server endpoints…"
                  emptyMessage="No server-side endpoints found in the last 24h."
                  onChange={(v) => onChange({ ...config, amountRaEndpoint: v, amountRaName: '', amountField: '' })}
                />
              </Flex>
              {config.amountRaEndpoint && (
                <Flex flexDirection="column" gap={4}>
                  <Text style={{ fontSize: "12px", fontWeight: 600 }}>Request Attribute:</Text>
                  <DiscoverySelect
                    value={config.amountRaName}
                    options={raOptions}
                    isLoading={raLoading}
                    error={raError}
                    placeholder="Search request attributes…"
                    emptyMessage="No request attributes found for this endpoint in the last 24h."
                    onChange={(v) => onChange({ ...config, amountRaName: v, amountField: v })}
                  />
                </Flex>
              )}
            </>
          )}

          {config.amountSourceType && (config.amountEventType || config.amountRaName) && (
            <Flex flexDirection="column" gap={4}>
              <Text style={{ fontSize: "12px" }}>Currency / unit label (optional):</Text>
              <TextInput
                value={config.amountUnit}
                onChange={(v: string) => onChange({ ...config, amountUnit: v })}
                placeholder="e.g. AED, USD, EUR"
              />
            </Flex>
          )}
        </Flex>
      </Flex>
    </Surface>
  );
}

// ─── Failed Transaction Details Preview ───────────────────────────────────────
// Shows static dummy data below the step preview cards to illustrate the
// dashboard section.  Renders an empty state until at least one endpoint is set.

const DUMMY_FAILED_ROWS = [
  { ts: "6/20/2026, 12:39:16 AM", service: "Service Name", error: "error message", trace: "8f3d9a4a7c31410b" },
  { ts: "6/20/2026, 12:34:16 AM", service: "Service Name", error: "error message", trace: "4b6f1a0cd9324e12" },
  { ts: "6/20/2026, 12:30:16 AM", service: "Service Name", error: "error message", trace: "1a5e2b894dc54f90" },
];

function DummyAreaChart() {
  const W = 600, H = 120;
  // success: fills from top wave down to bottom — large green band
  const sTop = `M0,75 C30,62 60,55 90,60 S150,45 180,52 S240,36 270,46 S330,30 360,42 S420,28 450,38 S510,32 560,38 L${W},44 L${W},${H} L0,${H} Z`;
  // failed: small red band at bottom
  const fTop = `M0,98 C30,93 60,100 90,96 S150,90 180,97 S240,86 270,94 S330,90 360,96 S420,88 450,95 S510,90 560,96 L${W},98 L${W},${H} L0,${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }}>
      <path d={sTop} fill="#2a7a52" opacity="0.85" />
      <path d={fTop} fill="#ae132d" opacity="0.9" />
      {[1, 2, 3, 4].map((i) => (
        <line key={i} x1={0} y1={H - i * (H / 5)} x2={W} y2={H - i * (H / 5)}
          stroke="#ffffff" strokeOpacity={0.07} strokeWidth={1} />
      ))}
      {[0, 5, 10, 15, 20].map((v, i) => (
        <text key={v} x={2} y={H - i * (H / 5) - 3} fontSize={7} fill="#666">{v}K</text>
      ))}
    </svg>
  );
}

function DummyDonut() {
  const r = 34, cx = 55, cy = 44;
  const circ = 2 * Math.PI * r;
  const successLen = circ * 0.98;
  const failLen = circ * 0.02;
  return (
    <svg viewBox="0 0 110 110" style={{ width: "100%", height: 110 }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2ab06f" strokeWidth={14}
        strokeDasharray={`${successLen} ${failLen}`}
        transform={`rotate(-90 ${cx} ${cy})`} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#ae132d" strokeWidth={14}
        strokeDasharray={`${failLen} ${successLen}`}
        strokeDashoffset={-successLen}
        transform={`rotate(-90 ${cx} ${cy})`} />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={14} fontWeight="bold" fill="#e8e8e8">115</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fontSize={8} fill="#aaa">Total</text>
      {/* legend — below the donut with enough space */}
      <rect x={8} y={86} width={7} height={7} fill="#2ab06f" rx={1} />
      <text x={17} y={93} fontSize={7} fill="#aaa">Success 98%</text>
      <rect x={8} y={98} width={7} height={7} fill="#ae132d" rx={1} />
      <text x={17} y={105} fontSize={7} fill="#aaa">Failed 2%</text>
    </svg>
  );
}

function DummyPieChart() {
  // 4 slices: 30%, 30%, 20%, 20%  — start at top (−90°)
  type Slice = { pct: number; color: string; label: string };
  const slices: Slice[] = [
    { pct: 0.30, color: "#6366f1", label: "Limit exceeded" },
    { pct: 0.30, color: "#64748b", label: "Validation error" },
    { pct: 0.20, color: "#2ab06f", label: "Backend timeout" },
    { pct: 0.20, color: "#e879a0", label: "Compliance failed" },
  ];
  const cx = 45, cy = 45, r = 38;
  let currentAngle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const startAngle = currentAngle;
    const endAngle = currentAngle + s.pct * 2 * Math.PI;
    currentAngle = endAngle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = s.pct > 0.5 ? 1 : 0;
    return { d: `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`, color: s.color, label: s.label, pct: s.pct };
  });

  return (
    <svg viewBox="0 0 100 120" style={{ width: "100%", height: 120 }}>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.color} stroke="#1a1a1a" strokeWidth={0.8} />
      ))}
      {slices.map((s, i) => (
        <g key={i}>
          <rect x={2} y={92 + i * 7} width={6} height={6} fill={s.color} rx={1} />
          <text x={10} y={98 + i * 7} fontSize={6} fill="#aaa">{s.label} ({Math.round(s.pct * 100)}%)</text>
        </g>
      ))}
    </svg>
  );
}

function FailedTransactionPreview({ endpoints }: { endpoints: JourneyEndpoint[] }) {
  const hasEndpoints = endpoints.some((ep) => ep.name.trim().length > 0);

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${Colors.Border.Neutral.Default}`,
    borderRadius: 4,
    background: Colors.Background.Container.Neutral.Default,
    padding: "8px 10px",
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: "11px",
    fontWeight: 600,
    color: Colors.Text.Neutral.Default,
    marginBottom: 4,
  };

  const cellStyle: React.CSSProperties = {
    padding: "3px 6px",
    fontSize: "10px",
    borderBottom: `1px solid ${Colors.Border.Neutral.Default}`,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  const headStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    background: Colors.Background.Container.Neutral.Subdued,
  };

  return (
    <div
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        background: Colors.Background.Container.Neutral.Default,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Section header */}
      <div>
        <Text style={{ fontSize: "12px", fontWeight: 700 }}>⛔ Failed Transaction Details</Text>
        {hasEndpoints && (
          <Text style={{ fontSize: "10px", color: Colors.Text.Neutral.Subdued, marginTop: 2 }}>
            Cross-step failure analysis · Powered by the configured journey endpoints
          </Text>
        )}
      </div>

      {!hasEndpoints ? (
        <div style={{ padding: "16px 0", textAlign: "center" as const }}>
          <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Subdued }}>
            Pick at least one endpoint to preview the failed transaction details.
          </Text>
        </div>
      ) : (
        <>
          {/* Row 1: Area chart (left) + Status Overview donut (right) */}
          <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 8 }}>
            <div style={cardStyle}>
              <div style={sectionTitle}>System Transactions Over Time (Success vs Failed)</div>
              <DummyAreaChart />
              <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                <span style={{ fontSize: "9px", color: "#2ab06f" }}>■ Success</span>
                <span style={{ fontSize: "9px", color: "#ae132d" }}>■ Failed</span>
              </div>
            </div>
            <div style={cardStyle}>
              <div style={sectionTitle}>📊 Status Overview</div>
              <DummyDonut />
            </div>
          </div>

          {/* Row 2: Recent Failed table (left) + Failure Reasons pie (right) */}
          <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 8 }}>
            <div style={cardStyle}>
              <div style={sectionTitle}>🔴 Recent Failed Transfer Details (sample)</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10px" }}>
                <thead>
                  <tr>
                    {["Timestamp", "Status", "Service", "Error Message", "Trace ID"].map((h) => (
                      <th key={h} style={headStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DUMMY_FAILED_ROWS.map((row, i) => (
                    <tr key={i}>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>{row.ts}</td>
                      <td style={cellStyle}>
                        <span style={{
                          background: "#ae132d",
                          color: "#fff",
                          borderRadius: 3,
                          padding: "1px 5px",
                          fontSize: "9px",
                          fontWeight: 700,
                        }}>Failed</span>
                      </td>
                      <td style={{ ...cellStyle, color: Colors.Text.Neutral.Subdued }}>{row.service}</td>
                      <td style={{ ...cellStyle, color: Colors.Text.Neutral.Subdued }}>{row.error}</td>
                      <td style={{ ...cellStyle, fontFamily: "monospace", fontSize: "9px", color: Colors.Text.Neutral.Subdued }}>{row.trace}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={cardStyle}>
              <div style={sectionTitle}>⚠️ Failure Reasons</div>
              <DummyPieChart />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LayoutPreview({
  title,
  endpoints,
  activeStepIdx,
  onAdd,
  onEdit,
  onRemove,
  onTitleChange,
  bizIndicators,
  onEditBizIndicators,
}: {
  title: string;
  endpoints: JourneyEndpoint[];
  activeStepIdx: number | null;
  onAdd: (idx: number) => void;
  onEdit: (idx: number) => void;
  onRemove: (idx: number) => void;
  onTitleChange: (v: string) => void;
  bizIndicators: BizIndicatorsConfig;
  onEditBizIndicators: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const slots = Array.from({ length: MAX_ENDPOINTS }, (_, i) => endpoints[i]);
  const nextAddableIdx = endpoints.length < MAX_ENDPOINTS ? endpoints.length : -1;
  return (
    <Surface>
      <Flex flexDirection="column" gap={12} padding={20}>
        <Flex justifyContent="space-between" alignItems="center">
          <Strong>📐 Live dashboard preview</Strong>
          <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
            Click <Strong>+</Strong> on the next step to configure it, or ✏️ to edit an existing one.
          </Text>
        </Flex>
        {editingTitle ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <TextInput
              value={title}
              onChange={onTitleChange}
              placeholder="e.g. ⏩ Journey Health"
              style={{ flex: 1 }}
            />
            <Button variant="default" onClick={() => setEditingTitle(false)}>Done</Button>
          </div>
        ) : (
          <div
            style={{
              padding: "6px 10px",
              background: Colors.Background.Container.Primary.Default,
              color: "#fff",
              borderRadius: 4,
              fontSize: "12px",
              fontWeight: 700,
              textAlign: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              cursor: "pointer",
            }}
            onClick={() => setEditingTitle(true)}
            title="Click to edit dashboard title"
          >
            {title || "⏩ Journey Health"}
            <span style={{ fontSize: "11px", opacity: 0.7 }}>✏️</span>
          </div>
        )}
        <BizIndicatorsPreview config={bizIndicators} onEdit={onEditBizIndicators} />
        <OverviewPreview endpoints={endpoints} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
          }}
        >
          {slots.map((ep, idx) => (
            <PreviewColumn
              key={idx}
              index={idx}
              endpoint={ep}
              onAdd={() => onAdd(idx)}
              onEdit={() => onEdit(idx)}
              onRemove={() => onRemove(idx)}
              isAddable={idx === nextAddableIdx}
              isActive={idx === activeStepIdx}
            />
          ))}
        </div>
        <FailedTransactionPreview endpoints={endpoints} />
      </Flex>
    </Surface>
  );
}

function MiniVizPreview({ viz }: { viz: VizType }) {
  const c = "rgba(255,255,255,0.9)";
  const w = 64, h = 28;
  switch (viz) {
    case "singleValue":
      return <svg width={w} height={h}><text x={w/2} y="20" textAnchor="middle" fill={c} fontSize="15" fontWeight="bold">42</text></svg>;
    case "lineChart":
      return <svg width={w} height={h}><polyline points="2,22 13,14 24,17 35,7 46,12 55,5 62,10" fill="none" stroke={c} strokeWidth="1.5"/></svg>;
    case "areaChart":
      return <svg width={w} height={h}><polygon points="2,22 13,14 24,17 35,7 46,12 55,5 62,10 62,26 2,26" fill={c} opacity="0.35"/><polyline points="2,22 13,14 24,17 35,7 46,12 55,5 62,10" fill="none" stroke={c} strokeWidth="1.5"/></svg>;
    case "barChart":
      return <svg width={w} height={h}><rect x="2" y="12" width="10" height="14" fill={c} opacity="0.8"/><rect x="16" y="6" width="10" height="20" fill={c} opacity="0.8"/><rect x="30" y="16" width="10" height="10" fill={c} opacity="0.8"/><rect x="44" y="4" width="10" height="22" fill={c} opacity="0.8"/></svg>;
    case "categoricalBarChart":
      return <svg width={w} height={h}><rect x="2" y="4" width="38" height="6" fill={c} opacity="0.8"/><rect x="2" y="12" width="52" height="6" fill={c} opacity="0.8"/><rect x="2" y="20" width="24" height="6" fill={c} opacity="0.8"/></svg>;
    case "donutChart":
      return <svg width={w} height={h}><circle cx={w/2} cy={h/2} r="10" fill="none" stroke={c} strokeWidth="5" opacity="0.85"/></svg>;
    case "pieChart":
      return <svg width={w} height={h}><path d={`M${w/2},${h/2} L${w/2},${h/2-11} A11,11 0 1,1 ${w/2-11},${h/2+5} Z`} fill={c} opacity="0.85"/></svg>;
    case "table":
      return <svg width={w} height={h}><line x1="2" y1="8" x2={w-2} y2="8" stroke={c} strokeWidth="1.5"/><line x1="2" y1="15" x2={w-2} y2="15" stroke={c} strokeWidth="1"/><line x1="2" y1="21" x2={w-2} y2="21" stroke={c} strokeWidth="1"/></svg>;
    default:
      return <svg width={w} height={h}/>;
  }
}

function PreviewColumn({
  index,
  endpoint,
  onAdd,
  onEdit,
  onRemove,
  isAddable,
  isActive,
}: {
  index: number;
  endpoint: JourneyEndpoint | undefined;
  onAdd?: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  isAddable: boolean;
  isActive: boolean;
}) {
  const dim = !endpoint && !isAddable;
  const name = endpoint?.stepName?.trim() || endpoint?.name?.trim();
  const actionBtnStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: 3,
    fontSize: "12px",
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.8,
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: dim ? 0.28 : 1,
        border: isActive
          ? `2px solid ${Colors.Border.Neutral.Default}`
          : `1px dashed ${Colors.Border.Neutral.Default}`,
        boxShadow: isActive ? "0 0 0 2px #3b82f6" : "none",
        padding: 6,
        borderRadius: 4,
        minHeight: 220,
      }}
    >
      {/* Interactive header — edit/remove icons for configured steps, + for next empty slot */}
      <div
        style={{
          background: Colors.Background.Container.Neutral.Emphasized,
          borderRadius: 3,
          height: 32,
          padding: "0 6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span
          style={{
            fontSize: "10px",
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            color: Colors.Text.Neutral.Default,
          }}
        >
          {name ? `${index + 1}. ${name}` : `Step ${index + 1}`}
        </span>
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {endpoint ? (
            <>
              <button onClick={onEdit} title="Edit step" style={actionBtnStyle}>✏️</button>
              <button onClick={onRemove} title="Remove step" style={actionBtnStyle}>🗑️</button>
            </>
          ) : isAddable ? (
            <button
              onClick={onAdd}
              title="Add this step"
              style={{
                ...actionBtnStyle,
                background: Colors.Background.Container.Primary.Default,
                color: "#fff",
                fontWeight: 700,
                fontSize: "16px",
                width: 22,
                height: 22,
                borderRadius: 4,
                opacity: 1,
              }}
            >+</button>
          ) : null}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <PreviewTile label="🛠️ IT Issues" role="health" height={50} />
        <PreviewTile label="🔒 Security" role="security" height={50} />
      </div>
      <PreviewTile label="💼 Business KPI (blank)" role="kpi" height={28} />
      {[0, 1].map((mIdx) => {
        const metric = endpoint?.metrics?.[mIdx];
        const filled = Boolean(metric?.eventType || metric?.requestAttribute);
        if (filled && metric) {
          const metricLabel = metric.label || metric.fieldName || metric.requestAttribute || `Metric ${mIdx + 1}`;
          return (
            <div key={mIdx} style={{
              background: Colors.Background.Container.Primary.Default,
              borderRadius: 3,
              padding: "4px 6px",
              height: 62,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "space-between",
              overflow: "hidden",
            }}>
              <span style={{ fontSize: "9px", color: "#fff", fontWeight: 600, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
                {metricLabel}
              </span>
              <MiniVizPreview viz={metric.visualization} />
            </div>
          );
        }
        return (
          <PreviewTile
            key={mIdx}
            label={`+ Metric ${mIdx + 1} (optional)`}
            role="metric-empty"
            height={62}
          />
        );
      })}
    </div>
  );
}

function PreviewTile({
  label,
  role,
  height,
}: {
  label: string;
  role: "header" | "health" | "security" | "kpi" | "metric" | "metric-empty";
  height: number;
}) {
  const bgMap: Record<typeof role, string> = {
    header: Colors.Background.Container.Neutral.Emphasized,
    health: Colors.Background.Container.Success.Default,
    security: Colors.Background.Container.Warning.Default,
    kpi: Colors.Background.Container.Neutral.Default,
    metric: Colors.Background.Container.Primary.Default,
    "metric-empty": Colors.Background.Container.Neutral.Default,
  };
  const colorMap: Record<typeof role, string> = {
    header: Colors.Text.Neutral.Default,
    health: Colors.Text.Success.Default,
    security: Colors.Text.Warning.Default,
    kpi: Colors.Text.Neutral.Default,
    metric: "#fff",
    "metric-empty": Colors.Text.Neutral.Default,
  };
  const dashed = role === "metric-empty";
  return (
    <div
      style={{
        background: bgMap[role],
        color: colorMap[role],
        height,
        padding: "4px 8px",
        borderRadius: 3,
        fontSize: "10px",
        fontWeight: role === "header" ? 700 : 500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        border: dashed ? `1px dashed ${Colors.Border.Neutral.Default}` : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={label}
    >
      {label}
    </div>
  );
}

// ─── Discovery-backed Select ──────────────────────────────────────────────────

function DiscoverySelect({
  value,
  options,
  isLoading,
  error,
  placeholder,
  onChange,
  emptyMessage,
}: {
  value: string;
  options: OptionRow[];
  isLoading: boolean;
  error: unknown;
  placeholder: string;
  onChange: (next: string) => void;
  emptyMessage: string;
}) {
  // Status line is shown ALWAYS so the user can tell whether the dropdown is
  // loading, has options, is empty, or errored. This is what fixes the
  // "nothing happens" UX when the Grail query is slow or returns 0 rows.
  const statusText = error
    ? `Error loading options: ${(error as Error)?.message ?? String(error)}`
    : isLoading
      ? `Loading… (${placeholder})`
      : options.length === 0
        ? emptyMessage
        : `${options.length.toLocaleString()} option(s) discovered — ${placeholder}`;
  const statusColor = error
    ? Colors.Text.Critical.Default
    : Colors.Text.Neutral.Default;
  return (
    <div style={{ width: "100%", minWidth: 400 }}>
      <Select
        value={value || null}
        onChange={(v: string | null) => onChange(v ?? "")}
        clearable
        style={{ width: "100%", minWidth: 400, maxWidth: "none" }}
      >
        <SelectFilter />
        <SelectContent width="600px">
          {options.map((o) => {
            const display = o.label || `${o.value}  ·  ${o.count.toLocaleString()}`;
            // Force single-line rendering so the SelectContent virtualizer
            // gets uniform row heights — mixed-height rows leave large
            // empty gaps in the dropdown body (only visible on scroll).
            return (
              <SelectOption key={o.value} value={o.value}>
                <span
                  title={display}
                  style={{
                    display: "block",
                    width: "100%",
                    height: 28,
                    lineHeight: "28px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {display}
                </span>
              </SelectOption>
            );
          })}
        </SelectContent>
      </Select>
      <Text style={{ fontSize: "11px", color: statusColor }}>{statusText}</Text>
    </div>
  );
}

function MetricEditor({
  metric,
  onChange,
  onRemove,
  businessFieldOptions,
  businessFieldsLoading,
  businessFieldsError,
  endpointName,
}: {
  metric: BusinessMetric;
  onChange: (next: BusinessMetric) => void;
  onRemove: () => void;
  businessFieldOptions: BusinessFieldOption[];
  businessFieldsLoading: boolean;
  businessFieldsError: unknown;
  endpointName: string;
}) {
  const { options: requestAttributeOptions, isLoading: requestAttributesLoading, error: requestAttributesError } =
    useRequestAttributeOptions(endpointName);
  const [liveQuery, setLiveQuery] = useState("");
  const { data: liveData, isLoading: liveRunning, error: liveError } = useDql(
    liveQuery || "fetch logs | limit 0",
    { enabled: Boolean(liveQuery) },
  );
  const runQuery = useCallback(() => setLiveQuery(metric.query), [metric.query]);

  // Auto-regenerate DQL whenever the structured inputs change. The DQL editor
  // remains editable so the user can tweak the generated query.
  useEffect(() => {
    const generated = buildMetricDql(metric);
    if (generated && generated !== metric.query) {
      onChange({ ...metric, query: generated });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    metric.kind,
    metric.eventType,
    metric.fieldName,
    metric.requestAttribute,
    metric.aggregation,
    metric.field,
    metric.visualization,
  ]);

  const isBusiness = metric.kind === "business";
  // "none" is only meaningful for table (raw rows, no aggregation needed).
  const aggOptionsForViz = metric.visualization === "table"
    ? AGG_OPTIONS
    : (AGG_OPTIONS.filter((o) => o !== "none") as readonly AggType[]);

  // For the business-field Select, options carry composite values
  // ("<eventType>::<fieldName>"), but the dropdown should display the
  // pre-baked label (field name — rule name). We feed the OptionRow shape
  // straight to DiscoverySelect.
  const businessOptionRows: OptionRow[] = businessFieldOptions.map((o) => ({
    value: o.value,
    label: o.label,
    count: 0,
  }));
  const selectedBusinessValue = metric.eventType && metric.fieldName
    ? `${metric.eventType}::${metric.fieldName}`
    : "";

  return (
    <Surface>
      <Flex flexDirection="column" gap={12} padding={16}>
        <Flex justifyContent="space-between" alignItems="center" gap={12}>
          <Strong>Metric</Strong>
          <Button variant="default" onClick={onRemove}>Remove</Button>
        </Flex>

        {/* Source-kind selector. Choose whether the chart pulls from a
            captured bizevent field (configured via the Discover tab) or
            from a Dynatrace Request Attribute. */}
        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontSize: "12px", fontWeight: 600 }}>Metric source</Text>
          <Flex gap={8}>
            <Button
              variant={isBusiness ? "accent" : "default"}
              onClick={() => onChange({ ...metric, kind: "business" })}
            >
              Business metric
            </Button>
            <Button
              variant={!isBusiness ? "accent" : "default"}
              onClick={() => onChange({ ...metric, kind: "request_attribute" })}
            >
              Request attribute
            </Button>
          </Flex>
        </Flex>

        {isBusiness ? (
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>
              Captured business field (field name · rule name)
            </Text>
            <DiscoverySelect
              value={selectedBusinessValue}
              options={businessOptionRows}
              isLoading={businessFieldsLoading}
              error={businessFieldsError}
              placeholder="Search captured fields…"
              emptyMessage="No captured business fields yet — configure one from the Discover tab first."
              onChange={(v) => {
                if (!v) {
                  onChange({
                    ...metric,
                    eventType: "",
                    fieldName: "",
                    ruleName: "",
                  });
                  return;
                }
                const hit = businessFieldOptions.find((o) => o.value === v);
                if (!hit) return;
                onChange({
                  ...metric,
                  eventType: hit.eventType,
                  fieldName: hit.fieldName,
                  ruleName: hit.ruleName,
                  label: metric.label || `${hit.fieldName} (${hit.ruleName || hit.eventType})`,
                });
              }}
            />
          </Flex>
        ) : (
          <Flex flexDirection="column" gap={4}>
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>Request attribute</Text>
            {requestAttributesLoading ? (
              <DiscoverySelect
                value={metric.requestAttribute}
                options={[]}
                isLoading
                error={undefined}
                placeholder="Loading request attributes…"
                emptyMessage=""
                onChange={(v) => onChange({ ...metric, requestAttribute: v, label: metric.label || v })}
              />
            ) : requestAttributeOptions.length > 0 ? (
              <DiscoverySelect
                value={metric.requestAttribute}
                options={requestAttributeOptions}
                isLoading={false}
                error={requestAttributesError}
                placeholder="Search request attributes…"
                emptyMessage="No request attributes found."
                onChange={(v) =>
                  onChange({ ...metric, requestAttribute: v, label: metric.label || v })
                }
              />
            ) : (
              <>
                <TextInput
                  value={metric.requestAttribute}
                  placeholder="e.g. BookingDouble"
                  onChange={(v: string) =>
                    onChange({ ...metric, requestAttribute: v, label: metric.label || v })
                  }
                />
                <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Subdued }}>
                  Type the exact request attribute name (configured under Settings → Server-side service monitoring → Request attributes).
                </Text>
              </>
            )}
            <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Subdued }}>
              Request attributes are discovered from spans on the selected endpoint and its nested child spans (e.g. downstream service calls within the same trace). If none appear, no Request Attribute rules have been configured or have captured values on this endpoint recently.
            </Text>
          </Flex>
        )}

        <Flex gap={12}>
          <Flex flexDirection="column" gap={4} style={{ flex: 1 }}>
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>Visualization</Text>
            <Select
              value={metric.visualization}
              style={{ width: "100%" }}
              onChange={(v: string | null) => {
                if (!v) return;
                const newViz = v as VizType;
                const newAgg = (newViz !== "table" && metric.aggregation === "none") ? "count" : metric.aggregation;
                onChange({ ...metric, visualization: newViz, aggregation: newAgg });
              }}
            >
              <SelectContent>
                {VIZ_OPTIONS.map((opt) => {
                  const meta = VIZ_META[opt];
                  const Icon = meta.Icon;
                  return (
                    <SelectOption key={opt} value={opt}>
                      <Flex gap={8} alignItems="center">
                        <Icon />
                        <Text>{meta.label}</Text>
                      </Flex>
                    </SelectOption>
                  );
                })}
              </SelectContent>
            </Select>
          </Flex>
          <Flex flexDirection="column" gap={4} style={{ flex: 1 }}>
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>
              Aggregation {metric.visualization === "table" ? "(optional — none = raw rows)" : ""}
            </Text>
            <Select
              value={metric.aggregation}
              style={{ width: "100%" }}
              onChange={(v: string | null) => {
                if (v) onChange({ ...metric, aggregation: v as AggType });
              }}
            >
              <SelectContent>
                {aggOptionsForViz.map((opt) => (
                  <SelectOption key={opt} value={opt}>{opt}</SelectOption>
                ))}
              </SelectContent>
            </Select>
          </Flex>
        </Flex>

        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontSize: "12px", fontWeight: 600 }}>Tile label</Text>
          <TextInput
            value={metric.label}
            onChange={(v: string) => onChange({ ...metric, label: v })}
            placeholder="e.g. Transactions per minute"
          />
        </Flex>

        <Flex flexDirection="column" gap={4}>
          <Flex justifyContent="space-between" alignItems="center">
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>Generated DQL (editable)</Text>
            <Button
              variant="accent"
              onClick={runQuery}
              style={{ padding: "2px 10px", minHeight: 24, fontSize: "11px" }}
            >
              ▶ Run
            </Button>
          </Flex>
          <DQLEditor
            value={metric.query}
            onChange={(v: string) => onChange({ ...metric, query: v })}
          />
          {liveQuery && (
            <div style={{ marginTop: 4 }}>
              {liveRunning && (
                <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>Running…</Text>
              )}
              {liveError && (
                <Text style={{ fontSize: "11px", color: Colors.Text.Critical.Default }}>
                  Error: {String((liveError as Error)?.message ?? liveError)}
                </Text>
              )}
              {!liveRunning && !liveError && liveData?.records && (
                <div style={{ maxHeight: 200, overflowY: "auto", border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 4 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                    <thead>
                      <tr style={{ background: Colors.Background.Container.Neutral.Subdued }}>
                        {liveData.records[0] && Object.keys(liveData.records[0]).map((k) => (
                          <th key={k} style={{ padding: "3px 8px", textAlign: "left", borderBottom: `1px solid ${Colors.Border.Neutral.Default}`, fontWeight: 600 }}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {liveData.records.slice(0, 10).map((row, ri) => (
                        <tr key={ri} style={{ borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                          {row && Object.values(row).map((v, vi) => (
                            <td key={vi} style={{ padding: "3px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {v === null || v === undefined ? "—" : String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Text style={{ fontSize: "10px", color: Colors.Text.Neutral.Default, padding: "2px 8px", display: "block" }}>
                    Showing {Math.min(10, liveData.records.length)} of {liveData.records.length} rows
                  </Text>
                </div>
              )}
            </div>
          )}
        </Flex>
      </Flex>
    </Surface>
  );
}

function EndpointEditor({
  index,
  endpoint,
  onChange,
  onRemove,
  endpointOptions,
  endpointLoading,
  endpointError,
  businessFieldOptions,
  businessFieldsLoading,
  businessFieldsError,
}: {
  index: number;
  endpoint: JourneyEndpoint;
  onChange: (next: JourneyEndpoint) => void;
  onRemove: () => void;
  endpointOptions: OptionRow[];
  endpointLoading: boolean;
  endpointError: unknown;
  businessFieldOptions: BusinessFieldOption[];
  businessFieldsLoading: boolean;
  businessFieldsError: unknown;
}) {
  return (
    <Surface>
      <Flex flexDirection="column" gap={12} padding={20}>
        <Flex justifyContent="space-between" alignItems="center" gap={12}>
          <Flex gap={8} alignItems="center">
            <Chip color="primary">Step {index + 1}</Chip>
            <Strong>Step details</Strong>
          </Flex>
          <Flex gap={8}>
            <Button variant="default" onClick={onRemove}>🗑️ Remove step</Button>
          </Flex>
        </Flex>

        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontSize: "12px", fontWeight: 600 }}>Step name (shown in dashboard header)</Text>
          <TextInput
            value={endpoint.stepName ?? ""}
            onChange={(v: string) => onChange({ ...endpoint, stepName: v })}
            placeholder="e.g. Login, Checkout, Confirmation"
          />
        </Flex>

        <Flex flexDirection="column" gap={4}>
          <Text style={{ fontSize: "12px", fontWeight: 600 }}>
            Endpoint name (discovered from server-side spans, last 24h)
          </Text>
          <DiscoverySelect
            value={endpoint.name}
            options={endpointOptions}
            isLoading={endpointLoading}
            error={endpointError}
            placeholder="Search server endpoints…"
            emptyMessage="No server-side endpoints found in the last 24h."
            onChange={(v) => onChange({ ...endpoint, name: v })}
          />
        </Flex>

        <Flex flexDirection="column" gap={8}>
          <Flex justifyContent="space-between" alignItems="center">
            <Text style={{ fontSize: "12px", fontWeight: 600 }}>
              Business metrics ({endpoint.metrics.length} of {MAX_METRICS_PER_ENDPOINT})
            </Text>
            {endpoint.metrics.length < MAX_METRICS_PER_ENDPOINT && (
              <Button
                variant="default"
                onClick={() =>
                  onChange({
                    ...endpoint,
                    metrics: [...endpoint.metrics, emptyMetric()],
                  })
                }
              >
                + Add metric
              </Button>
            )}
          </Flex>
          {endpoint.metrics.length === 0 && (
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              No business metrics yet. The endpoint column will still get IT
              Issues, Security and a Business KPI placeholder.
            </Text>
          )}
          {endpoint.metrics.map((m, mIdx) => (
            <MetricEditor
              key={mIdx}
              metric={m}
              businessFieldOptions={businessFieldOptions}
              businessFieldsLoading={businessFieldsLoading}
              businessFieldsError={businessFieldsError}
              endpointName={endpoint.name}
              onChange={(next) => {
                const list = endpoint.metrics.slice();
                list[mIdx] = next;
                onChange({ ...endpoint, metrics: list });
              }}
              onRemove={() => {
                const list = endpoint.metrics.slice();
                list.splice(mIdx, 1);
                onChange({ ...endpoint, metrics: list });
              }}
            />
          ))}
        </Flex>
      </Flex>
    </Surface>
  );
}

export const JourneyWizard = () => {
  const [title, setTitle] = useState("⏩ Journey Health");
  const [endpoints, setEndpoints] = useState<JourneyEndpoint[]>([]);
  const [activeStepIdx, setActiveStepIdx] = useState<number | null>(null);
  const [output, setOutput] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [bizIndicators, setBizIndicators] = useState<BizIndicatorsConfig>(emptyBizIndicators);
  const [bizEditOpen, setBizEditOpen] = useState(false);

  // Direct "create dashboard on tenant" state.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const endpointDiscovery = useEndpointOptions();
  const businessFieldDiscovery = useBusinessFieldOptions();

  const handleAddStep = (idx: number) => {
    setBizEditOpen(false);
    setEndpoints((prev) => {
      const list = [...prev];
      if (!list[idx]) list[idx] = emptyEndpoint();
      return list;
    });
    setActiveStepIdx(idx);
  };

  const handleEditStep = (idx: number) => {
    setBizEditOpen(false);
    setActiveStepIdx(idx);
  };

  const handleRemoveStep = (idx: number) => {
    setEndpoints((prev) => {
      const list = prev.slice();
      list.splice(idx, 1);
      return list;
    });
    setActiveStepIdx((prev) => {
      if (prev === null) return null;
      if (prev === idx) return null;
      if (prev > idx) return prev - 1;
      return prev;
    });
  };

  const canGenerate = endpoints.length > 0 && endpoints.every((e) => e.name.trim().length > 0);

  const handleGenerate = async () => {
    const arrowUrl = await uploadArrow();
    setOutput(JSON.stringify(buildDashboard(title, endpoints, arrowUrl, bizIndicators), null, 2));
  };

  // Create the dashboard directly in the tenant's document store. This
  // bypasses the manual JSON copy-paste flow: the user clicks one button
  // and gets a deep link to open the new dashboard.
  const handleCreateOnTenant = async () => {
    if (!canGenerate) return;
    setCreating(true);
    setCreateError(null);
    setCreatedUrl(null);
    try {
      const arrowUrl = await uploadArrow();
      const json = JSON.stringify(buildDashboard(title, endpoints, arrowUrl, bizIndicators));
      const blob = new Blob([json], { type: "application/json" });
      const created = await documentsClient.createDocument({
        body: {
          name: title || "Journey Dashboard",
          type: "dashboard",
          content: blob,
        },
      });
      const id = (created as { id?: string } | undefined)?.id;
      const env = getEnvironmentUrl().replace(/\/+$/, "");
      if (id) {
        setCreatedUrl(`${env}/ui/apps/dynatrace.dashboards/dashboard/${id}`);
      } else {
        // Fall back to opening the Dashboards app home if no id came back.
        setCreatedUrl(`${env}/ui/apps/dynatrace.dashboards`);
      }
    } catch (err) {
      setCreateError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available — user can still select-copy from the textarea */
    }
  };

  const handleDownload = () => {
    if (!output) return;
    const blob = new Blob([output], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Flex flexDirection="column" gap={20} padding={32} style={{ maxWidth: 1600, margin: "0 auto" }}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={1}>Journey Dashboard Wizard</Heading>
        <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
          Describe a 1–4-step user journey by picking endpoint names and
          business-event types from your live Grail data. The wizard
          assembles a Dynatrace dashboard JSON you can import as-is.
        </Paragraph>
      </Flex>

      <LayoutPreview
        title={title}
        endpoints={endpoints}
        activeStepIdx={activeStepIdx}
        onAdd={handleAddStep}
        onEdit={handleEditStep}
        onRemove={handleRemoveStep}
        onTitleChange={setTitle}
        bizIndicators={bizIndicators}
        onEditBizIndicators={() => { setActiveStepIdx(null); setBizEditOpen(true); }}
      />

      {bizEditOpen && (
        <BizIndicatorsEditor
          config={bizIndicators}
          onChange={setBizIndicators}
          onClose={() => setBizEditOpen(false)}
          endpointOptions={endpointDiscovery.options}
          endpointLoading={endpointDiscovery.isLoading}
          endpointError={endpointDiscovery.error}
          businessFieldOptions={businessFieldDiscovery.options}
          businessFieldsLoading={businessFieldDiscovery.isLoading}
          businessFieldsError={businessFieldDiscovery.error}
        />
      )}

      {activeStepIdx !== null && endpoints[activeStepIdx] && (
        <EndpointEditor
          key={activeStepIdx}
          index={activeStepIdx}
          endpoint={endpoints[activeStepIdx]}
          endpointOptions={endpointDiscovery.options}
          endpointLoading={endpointDiscovery.isLoading}
          endpointError={endpointDiscovery.error}
          businessFieldOptions={businessFieldDiscovery.options}
          businessFieldsLoading={businessFieldDiscovery.isLoading}
          businessFieldsError={businessFieldDiscovery.error}
          onChange={(next) => {
            const list = endpoints.slice();
            list[activeStepIdx] = next;
            setEndpoints(list);
          }}
          onRemove={() => handleRemoveStep(activeStepIdx)}
        />
      )}

      <Flex gap={12} justifyContent="flex-end" alignItems="center" flexWrap="wrap">
        {!canGenerate && (
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
            Pick an endpoint for every step to enable creation.
          </Text>
        )}
        <Button variant="default" disabled={!canGenerate} onClick={handleGenerate}>
          Preview JSON
        </Button>
        <Button
          variant="accent"
          disabled={!canGenerate || creating}
          onClick={() => void handleCreateOnTenant()}
        >
          {creating ? "Creating dashboard…" : "⚡ Create dashboard on tenant"}
        </Button>
      </Flex>

      {createError && (
        <Surface>
          <Flex flexDirection="column" gap={8} padding={16}>
            <Strong style={{ color: Colors.Text.Critical.Default }}>
              Could not create dashboard
            </Strong>
            <Text style={{ fontSize: "12px", color: Colors.Text.Critical.Default }}>
              {createError}
            </Text>
            <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
              Tip: the app needs the <Strong>document:documents:write</Strong> scope.
              If you've just upgraded, re-open the app so the new scope can be granted.
            </Text>
          </Flex>
        </Surface>
      )}

      {createdUrl && (
        <Surface>
          <Flex flexDirection="column" gap={8} padding={16}>
            <Strong style={{ color: Colors.Text.Success.Default }}>
              ✓ Dashboard created
            </Strong>
            <Paragraph style={{ fontSize: "12px" }}>
              Your dashboard is live on the tenant.{" "}
              <a href={createdUrl} target="_blank" rel="noreferrer noopener">
                Open it now ↗
              </a>
            </Paragraph>
          </Flex>
        </Surface>
      )}

      {output && (
        <Surface>
          <Flex flexDirection="column" gap={12} padding={20}>
            <Flex justifyContent="space-between" alignItems="center">
              <Strong>Dashboard JSON (fallback)</Strong>
              <Flex gap={8}>
                <Button variant="default" onClick={handleCopy}>
                  {copied ? "✓ Copied" : "Copy"}
                </Button>
                <Button variant="default" onClick={handleDownload}>
                  Download .json
                </Button>
              </Flex>
            </Flex>
            <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>
              Prefer the one-click <Strong>Create dashboard on tenant</Strong> button above —
              this JSON view is here as a fallback you can also import via{" "}
              <Strong>Dashboards → New dashboard → … → Import JSON</Strong>.
            </Paragraph>
            <textarea
              readOnly
              value={output}
              style={{
                width: "100%",
                minHeight: 320,
                fontFamily: "monospace",
                fontSize: "11px",
                padding: 12,
                background: Colors.Background.Container.Neutral.Default,
                color: Colors.Text.Neutral.Default,
                border: `1px solid ${Colors.Border.Neutral.Default}`,
                borderRadius: 4,
              }}
            />
          </Flex>
        </Surface>
      )}
    </Flex>
  );
};
