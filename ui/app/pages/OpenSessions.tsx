import React, { useCallback, useEffect, useMemo, useState } from "react";

import { Flex } from "@dynatrace/strato-components/layouts";
import {
  Heading,
  Paragraph,
  Text,
  Strong,
  TextEllipsis,
} from "@dynatrace/strato-components/typography";
import { Button } from "@dynatrace/strato-components/buttons";
import { Chip } from "@dynatrace/strato-components/content";
import {
  DataTable,
  type DataTableColumnDef,
} from "@dynatrace/strato-components/tables";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { CriticalIcon, DQLSignetIcon } from "@dynatrace/strato-icons";
import { settingsObjectsClient } from "@dynatrace-sdk/client-classic-environment-v2";
import { documentsClient } from "@dynatrace-sdk/client-document";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { useDql } from "@dynatrace-sdk/react-hooks";

import { CollectParamsSheet } from "./Discovery";

// Per-row sample-value lookup. Each cell runs its own one-shot DQL using the
// exact shape the user asked for:
//   fetch bizevents, from: now() - 24h
//   | filter event.type == "<type>" and isNotNull(<field>)
//   | fields <field>
//   | sort timestamp desc
//   | limit 1
// One bizevent, one column, one value — keeps the result tiny and matches
// the same query the user pastes into a notebook.
const SampleValueCell: React.FC<{ eventType: string; fieldName: string }> = ({
  eventType,
  fieldName,
}) => {
  const safeType = eventType.replace(/"/g, '\\"');
  const fieldRef = /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)
    ? fieldName
    : fieldName.replace(/[^A-Za-z0-9_]/g, "_");
  const query = `fetch bizevents, from: now() - 24h
| filter event.type == "${safeType}" and isNotNull(${fieldRef})
| sort timestamp desc
| fields ${fieldRef}
| limit 1`;
  const { data, isLoading, error } = useDql({ query });
  if (isLoading) {
    return (
      <Text style={{ color: Colors.Text.Neutral.Default }}>Loading…</Text>
    );
  }
  if (error) {
    return (
      <Text
        style={{ color: Colors.Text.Critical.Default }}
        title={String(error?.message ?? error)}
      >
        — (error)
      </Text>
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records = (data as any)?.records as
    | Record<string, unknown>[]
    | undefined;
  const raw = records?.[0]?.[fieldRef];
  if (raw === undefined || raw === null || raw === "") {
    return (
      <Text style={{ color: Colors.Text.Neutral.Default }}>
        — (no value in 24h)
      </Text>
    );
  }
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return (
    <TextEllipsis title={s} style={{ fontFamily: "monospace" }}>
      {s}
    </TextEllipsis>
  );
};

// Rules created by the Collect Parameters sheet always carry an
// `event.type.source` of `dt-business-discovery.<triggerPath>`. We use that
// prefix to filter the global bizevent-capture list to just rules this app
// created — anything else (manual rules, other tooling) is hidden so users
// don't accidentally tamper with it.
const SCHEMA_ID = "builtin:bizevents.http.incoming";
const SOURCE_PREFIX = "dt-business-discovery.";

const WILDCARD_NAMES = new Set([
  "allrequest",
  "allresponse",
  "allqueryparameters",
  "allrequestheaders",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isWildcardField = (d: any): boolean => {
  const topPath = typeof d?.path === "string" ? d.path : "";
  const srcPath = typeof d?.source?.path === "string" ? d.source.path : "";
  if (topPath === "*" || srcPath === "*") return true;
  const n = String(d?.name ?? "").toLowerCase();
  if (!topPath && !srcPath && WILDCARD_NAMES.has(n)) return true;
  return false;
};

interface SessionRow {
  id: string; // objectId — also DataTable row id
  objectId: string;
  ruleName: string;
  triggerPath: string;
  httpMethod: string | null;
  serviceName: string;
  wildcardCount: number;
  narrowCount: number;
  totalFields: number;
}

// One row per captured parameter (= non-wildcard field on a rule the app
// created). Used to render the "Configured Business Events" table where the
// user wants to see field name + path + data source + rule + sample value.
interface BizFieldRow {
  id: string; // `${objectId}::${fieldName}` — DataTable row id
  objectId: string;
  ruleName: string;
  eventType: string;
  triggerPath: string;
  httpMethod: string | null;
  serviceName: string;
  fieldName: string;
  path: string; // JSONPath / header name / query key, etc.
  dataSource: string; // raw enum, e.g. "request.headers"
}

// Human-friendly label for the raw schema enum values used by the
// bizevent-capture rule's `source.sourceType` / `source.dataSource` field.
const DATA_SOURCE_LABELS: Record<string, string> = {
  "request.headers": "Request Headers",
  "request.parameters": "Query String",
  "request.body": "Request Body",
  "request.path": "Request Path",
  "request.method": "Request Method",
  "response.headers": "Response Headers",
  "response.body": "Response Body",
  "response.statusCode": "Response Status",
};
const formatDataSource = (raw: string): string =>
  DATA_SOURCE_LABELS[raw] ?? (raw || "—");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFieldPath = (d: any): string => {
  const p = d?.source?.path ?? d?.path;
  return typeof p === "string" ? p : "";
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFieldDataSource = (d: any): string => {
  const s = d?.source?.sourceType ?? d?.source?.dataSource ?? "";
  return typeof s === "string" ? s : "";
};

// Parse the ruleName we wrote in createRule:
//   `${httpMethod ?? "ANY"} ${route} — ${serviceName}`
// This is best-effort — if the format ever changes the row still renders, we
// just lose the per-column split.
function parseRuleName(ruleName: string): {
  httpMethod: string | null;
  route: string;
  serviceName: string;
} {
  const dashIdx = ruleName.indexOf(" — ");
  const left = dashIdx >= 0 ? ruleName.slice(0, dashIdx) : ruleName;
  const serviceName = dashIdx >= 0 ? ruleName.slice(dashIdx + 3) : "";
  const firstSpace = left.indexOf(" ");
  const method = firstSpace >= 0 ? left.slice(0, firstSpace) : "ANY";
  const route = firstSpace >= 0 ? left.slice(firstSpace + 1) : left;
  return {
    httpMethod: method === "ANY" ? null : method,
    route,
    serviceName,
  };
}

export const OpenSessions = () => {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [bizFieldRows, setBizFieldRows] = useState<BizFieldRow[]>([]);
  const [configuredRuleCount, setConfiguredRuleCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<SessionRow | null>(null);
  const [openingNotebookId, setOpeningNotebookId] = useState<string | null>(
    null,
  );
  const [notebookError, setNotebookError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await settingsObjectsClient.getSettingsObjects({
        schemaIds: SCHEMA_ID,
        fields: "objectId,schemaId,value",
      });
      const items = resp.items ?? [];
      const result: SessionRow[] = [];
      const fields: BizFieldRow[] = [];
      let ruleCount = 0;
      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v = item.value as Record<string, any> | undefined;
        if (!v) continue;
        const source = String(v?.event?.type?.source ?? "");
        if (!source.startsWith(SOURCE_PREFIX)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any[] = Array.isArray(v?.event?.data) ? v.event.data : [];
        const wildcardCount = data.filter(isWildcardField).length;
        const narrowCount = data.length - wildcardCount;
        const triggerPath = source.slice(SOURCE_PREFIX.length);
        const parsed = parseRuleName(String(v?.ruleName ?? ""));
        ruleCount += 1;

        // One row per captured (non-wildcard) field on this rule.
        for (const d of data) {
          if (isWildcardField(d)) continue;
          const fieldName = String(d?.name ?? "").trim();
          if (!fieldName) continue;
          fields.push({
            id: `${item.objectId ?? "obj"}::${fieldName}`,
            objectId: item.objectId ?? "",
            ruleName: String(v?.ruleName ?? ""),
            eventType: source,
            triggerPath,
            httpMethod: parsed.httpMethod,
            serviceName: parsed.serviceName,
            fieldName,
            path: getFieldPath(d),
            dataSource: getFieldDataSource(d),
          });
        }

        // "Open" sessions: only rules that still carry wildcards.
        if (wildcardCount === 0) continue;
        result.push({
          id: item.objectId ?? `row-${result.length}`,
          objectId: item.objectId ?? "",
          ruleName: String(v?.ruleName ?? ""),
          triggerPath,
          httpMethod: parsed.httpMethod,
          serviceName: parsed.serviceName,
          wildcardCount,
          narrowCount,
          totalFields: data.length,
        });
      }
      result.sort((a, b) => a.triggerPath.localeCompare(b.triggerPath));
      fields.sort(
        (a, b) =>
          a.eventType.localeCompare(b.eventType) ||
          a.fieldName.localeCompare(b.fieldName),
      );
      setRows(result);
      setBizFieldRows(fields);
      setConfiguredRuleCount(ruleCount);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Quick Delete mirrors the in-sheet "Stop & Delete" semantics exactly:
  // strip every wildcard collector; if anything narrow remains, PUT the
  // rule back without the wildcards; otherwise delete the whole rule.
  const onQuickDelete = useCallback(
    async (row: SessionRow) => {
      if (!row.objectId) return;
      setBusyId(row.objectId);
      try {
        const current = await settingsObjectsClient.getSettingsObjectByObjectId({
          objectId: row.objectId,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value: Record<string, any> = JSON.parse(
          JSON.stringify(current.value ?? {}),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any[] = Array.isArray(value.event?.data)
          ? value.event.data
          : [];
        const kept = data.filter((d) => !isWildcardField(d));
        if (kept.length === 0) {
          await settingsObjectsClient
            .deleteSettingsObjectByObjectId({ objectId: row.objectId })
            .catch(() => null);
          // eslint-disable-next-line no-console
          console.debug("[OpenSessions] deleted rule entirely:", row.objectId);
        } else {
          value.event = value.event ?? {};
          value.event.data = kept;
          await settingsObjectsClient.putSettingsObjectByObjectId({
            objectId: row.objectId,
            body: { value },
          });
          // eslint-disable-next-line no-console
          console.debug(
            "[OpenSessions] stripped wildcards, kept narrow fields:",
            kept.map((d) => d?.name),
          );
        }
        await load();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[OpenSessions] quick-delete failed:", err);
        setError(String((err as Error)?.message ?? err));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const columns = useMemo<DataTableColumnDef<SessionRow>[]>(
    () => [
      {
        id: "method",
        header: "Method",
        accessor: "httpMethod",
        width: 110,
        cell: ({ value }: { value: string | null }) =>
          value ? (
            <Chip color="neutral">{value}</Chip>
          ) : (
            <Chip color="neutral">ANY</Chip>
          ),
      },
      {
        id: "route",
        header: "Endpoint",
        accessor: "triggerPath",
        cell: ({
          value,
          rowData,
        }: {
          value: string;
          rowData: SessionRow;
        }) => (
          <Flex flexDirection="column" gap={2}>
            <Strong>{value}</Strong>
            {rowData.serviceName && (
              <Text style={{ color: Colors.Text.Neutral.Default }}>
                {rowData.serviceName}
              </Text>
            )}
          </Flex>
        ),
      },
      {
        id: "wildcards",
        header: "Wildcards (*)",
        accessor: "wildcardCount",
        width: 130,
        cell: ({ value }: { value: number }) => (
          <Chip color="warning">{value}</Chip>
        ),
      },
      {
        id: "narrow",
        header: "Pinned Fields",
        accessor: "narrowCount",
        width: 130,
        cell: ({ value }: { value: number }) =>
          value > 0 ? (
            <Chip color="success">{value}</Chip>
          ) : (
            <Text style={{ color: Colors.Text.Neutral.Default }}>—</Text>
          ),
      },
      {
        id: "actions",
        header: "",
        accessor: "objectId",
        width: 320,
        cell: ({ rowData }: { rowData: SessionRow }) => (
          <Flex gap={8}>
            <Button
              variant="emphasized"
              onClick={() => setReopenTarget(rowData)}
              disabled={busyId === rowData.objectId}
            >
              Re-open
            </Button>
            <Button
              variant="default"
              color="critical"
              onClick={() => void onQuickDelete(rowData)}
              disabled={busyId === rowData.objectId}
            >
              {busyId === rowData.objectId
                ? "Deleting…"
                : rowData.narrowCount > 0
                ? "Delete wildcards"
                : "Delete rule"}
            </Button>
          </Flex>
        ),
      },
    ],
    [busyId, onQuickDelete],
  );

  // Latest sample bizevent per event.type — used only by the Refresh button to
  // know whether the per-row queries should be re-fired. We don't run a bulk
  // query anymore; each row uses its own <SampleValueCell> (see below) which
  // matches the exact DQL the user pastes into a notebook.
  const uniqueEventTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of bizFieldRows) s.add(r.eventType);
    return Array.from(s);
  }, [bizFieldRows]);

  const sampleQuery = useMemo(() => uniqueEventTypes.length, [uniqueEventTypes]);
  // Silence unused-var lint without removing the dependency tracking above.
  void sampleQuery;

  // Create a one-section notebook scoped to this captured parameter, then
  // open it in a new tab. The query selects the field value + a few useful
  // dimensions so the user lands on something immediately useful.
  const handleOpenWithNotebook = useCallback(async (row: BizFieldRow) => {
    setOpeningNotebookId(row.id);
    setNotebookError(null);
    try {
      const safeType = row.eventType.replace(/"/g, '\\"');
      // Field names produced by sanitizeFieldName() in Discovery are always
      // [A-Za-z0-9_]+ — valid DQL identifiers, so we emit them unquoted.
      // Wrapping them in backticks (which show up like single quotes in some
      // fonts) made the query reference a string literal instead of a column.
      const fieldRef = /^[A-Za-z_][A-Za-z0-9_]*$/.test(row.fieldName)
        ? row.fieldName
        : row.fieldName.replace(/[^A-Za-z0-9_]/g, "_");
      const query = `fetch bizevents, from: now() - 24h
| filter event.type == "${safeType}" and isNotNull(${fieldRef})
| sort timestamp desc
| fields timestamp, event.type, ${fieldRef}, trace.id
| limit 100`;

      const notebook = {
        version: "7",
        defaultTimeframe: { from: "now()-24h", to: "now()" },
        sections: [
          {
            id:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `sec-${Date.now()}`,
            type: "dql",
            title: `${row.fieldName} on ${row.eventType}`,
            showInput: true,
            state: {
              input: { value: query },
              visualization: "table",
              visualizationSettings: {
                autoSelectVisualization: true,
                chartSettings: {},
              },
            },
          },
        ],
      };

      const blob = new Blob([JSON.stringify(notebook)], {
        type: "application/json",
      });
      const created = await documentsClient.createDocument({
        body: {
          name: `${row.fieldName} — ${row.eventType}`,
          type: "notebook",
          content: blob,
        },
      });
      const id = (created as { id?: string } | undefined)?.id;
      const env = getEnvironmentUrl().replace(/\/+$/, "");
      const url = id
        ? `${env}/ui/apps/dynatrace.notebooks/notebook/${id}`
        : `${env}/ui/apps/dynatrace.notebooks`;
      window.open(url, "_blank", "noreferrer,noopener");
    } catch (err) {
      setNotebookError(String((err as Error)?.message ?? err));
    } finally {
      setOpeningNotebookId(null);
    }
  }, []);

  // Columns for the Configured Business Events table.
  // One row per captured parameter, ordered exactly as requested:
  // field name → path → data source → rule name → sample value → action.
  const env = useMemo(() => getEnvironmentUrl().replace(/\/+$/, ""), []);
  const bizColumns = useMemo<DataTableColumnDef<BizFieldRow>[]>(
    () => [
      {
        id: "fieldName",
        header: "Field name",
        accessor: "fieldName",
        width: 220,
        cell: ({ value }: { value: string }) => (
          <Flex alignItems="center" gap={6} style={{ flexWrap: "wrap" }}>
            <Chip color="success">{value}</Chip>
            <Button
              variant="default"
              onClick={() => void navigator.clipboard.writeText(value)}
            >
              Copy
            </Button>
          </Flex>
        ),
      },
      {
        id: "path",
        header: "Path",
        accessor: "path",
        width: 220,
        cell: ({ value }: { value: string }) => (
          <TextEllipsis
            title={value || undefined}
            style={{ fontFamily: "monospace" }}
          >
            {value || "—"}
          </TextEllipsis>
        ),
      },
      {
        id: "dataSource",
        header: "Data source",
        accessor: "dataSource",
        width: 130,
        cell: ({ value }: { value: string }) => (
          <Text>{formatDataSource(value)}</Text>
        ),
      },
      {
        id: "ruleName",
        header: "Rule name",
        accessor: "ruleName",
        minWidth: 240,
        cell: ({ rowData }: { rowData: BizFieldRow }) => {
          const label = rowData.ruleName || "(unnamed)";
          const ellipsisStyle: React.CSSProperties = {
            display: "inline-block",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            verticalAlign: "middle",
          };
          if (!rowData.objectId) {
            return (
              <span title={label} style={ellipsisStyle}>
                <Strong>{label}</Strong>
              </span>
            );
          }
          const href = `${env}/ui/apps/dynatrace.settings/settings/bizevents/incoming/${encodeURIComponent(
            rowData.objectId,
          )}`;
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              title={label}
              style={{
                ...ellipsisStyle,
                color: Colors.Text.Primary.Default,
                textDecoration: "underline",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {label}
            </a>
          );
        },
      },
      {
        id: "sampleValue",
        header: "Sample value",
        accessor: "fieldName",
        minWidth: 320,
        cell: ({ rowData }: { rowData: BizFieldRow }) => (
          <SampleValueCell
            eventType={rowData.eventType}
            fieldName={rowData.fieldName}
          />
        ),
      },
      {
        id: "actions",
        header: "",
        accessor: "id",
        width: 200,
        cell: ({ rowData }: { rowData: BizFieldRow }) => (
          <Button
            variant="default"
            onClick={() => void handleOpenWithNotebook(rowData)}
            disabled={openingNotebookId === rowData.id}
          >
            <Button.Prefix>
              <DQLSignetIcon />
            </Button.Prefix>
            {openingNotebookId === rowData.id
              ? "Opening…"
              : "Open with Notebook"}
          </Button>
        ),
      },
    ],
    [env, handleOpenWithNotebook, openingNotebookId],
  );

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex flexDirection="column" gap={8}>
        <Heading level={2}>Discovery Sessions</Heading>
        <Paragraph>
          Active bizevent capture rules created by this app that still hold
          wildcard collectors (path = <Strong>*</Strong>). Re-open to continue
          the Collect Parameters session, or delete the wildcards. Pinned
          per-parameter fields you've already added are always preserved —
          only the wildcards are stripped.
        </Paragraph>
      </Flex>

      <Flex gap={8} alignItems="center">
        <Button onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
        {!loading && (
          <Text style={{ color: Colors.Text.Neutral.Default }}>
            {rows.length} open {rows.length === 1 ? "session" : "sessions"}
            {" · "}
            {configuredRuleCount} configured business{" "}
            {configuredRuleCount === 1 ? "event" : "events"}
            {" · "}
            {bizFieldRows.length} captured{" "}
            {bizFieldRows.length === 1 ? "parameter" : "parameters"}
          </Text>
        )}
      </Flex>

      {error && (
        <Flex
          alignItems="center"
          gap={8}
          style={{ color: Colors.Text.Critical.Default }}
        >
          <CriticalIcon />
          <Paragraph>{error}</Paragraph>
        </Flex>
      )}

      {!loading && rows.length === 0 && !error && (
        <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
          No open sessions. Start one from the Discover Metrics tab → an
          endpoint → Collect Parameters.
        </Paragraph>
      )}

      {rows.length > 0 && <DataTable data={rows} columns={columns} />}

      <Flex flexDirection="column" gap={8} style={{ marginTop: 24 }}>
        <Heading level={3}>Configured Business Events</Heading>
        <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
          One row per captured parameter across every bizevent capture rule
          this app has created. Sample values are taken from the most recent
          bizevent of each type in the last 24 hours.
        </Paragraph>
      </Flex>

      {notebookError && (
        <Flex
          alignItems="center"
          gap={8}
          style={{ color: Colors.Text.Critical.Default }}
        >
          <CriticalIcon />
          <Paragraph>
            Couldn’t open notebook: {notebookError}. The app may be missing the{" "}
            <Strong>document:documents:write</Strong> scope — re-open the app
            to grant it.
          </Paragraph>
        </Flex>
      )}

      {!loading && bizFieldRows.length === 0 && !error && (
        <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
          No captured parameters yet. Run a Collect Parameters session from
          the Discover Metrics tab and pin one or more fields.
        </Paragraph>
      )}

      {bizFieldRows.length > 0 && (
        <DataTable data={bizFieldRows} columns={bizColumns} />
      )}

      {reopenTarget && (
        <CollectParamsSheet
          serviceName={reopenTarget.serviceName || "(reopened session)"}
          route={reopenTarget.triggerPath}
          httpMethod={reopenTarget.httpMethod}
          show={true}
          onClose={() => {
            setReopenTarget(null);
            void load();
          }}
        />
      )}
    </Flex>
  );
};
