import React, { useState, useMemo, useEffect, useRef } from "react";
import { useAppFunction } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text, Strong } from "@dynatrace/strato-components/typography";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { Chip } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { Modal } from "@dynatrace/strato-components/overlays";
import { Select, SelectOption, SelectContent } from "@dynatrace/strato-components-preview/forms";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { CriticalIcon, ExternalLinkIcon, CopyIcon } from "@dynatrace/strato-icons";

interface RaSample {
  value: string;
  traceId: string;
  spanName: string;
  httpMethod: string;
  timestamp: string;
}

interface RaRecord {
  id: string;
  name: string;
  dataType: string;
  samples: RaSample[];
  occurrences: number;
  captureMethod: string;
}

interface RequestAttributeResult {
  records: RaRecord[];
  fromTime: string;
  debug?: string;
}

const INTERVAL_OPTIONS = [
  { label: "Last 1 Hour", value: "now()-1h" },
  { label: "Last 6 Hours", value: "now()-6h" },
  { label: "Last 1 Day", value: "now()-1d" },
  { label: "Last 3 Days", value: "now()-3d" },
];

function buildSettingsUrl(env: string): string {
  return `${env}/ui/apps/dynatrace.classic.settings/#settings/requestattributes;gf=all`;
}

function buildTraceUrl(traceId: string, env: string, timestamp?: string): string {
  if (!traceId || traceId === "[object Object]") return "";
  const clean = traceId.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length < 16) return "";
  // Normalize timestamp to ISO string for the `tt` param
  let tt = "";
  if (timestamp) {
    try {
      const d = new Date(isNaN(Number(timestamp)) ? timestamp : Number(timestamp) / 1_000_000);
      if (!isNaN(d.getTime())) tt = d.toISOString();
    } catch { /* ignore */ }
  }
  const ttPart = tt ? `&tt=${encodeURIComponent(tt)}` : "";
  return `${env}/ui/apps/dynatrace.distributedtracing/explorer?tf=now-24h%3Bnow&cv=false&traceId=${clean}${ttPart}&m=true`;
}

// ─── Recent Values Carousel (same pattern as Discovery live preview) ──────────

const ValuesCarousel: React.FC<{ samples: RaSample[] }> = ({ samples }) => {
  const [idx, setIdx] = useState(0);

  const latest3 = useMemo(() => samples.slice(0, 3).map((s) => s.value), [samples]);

  if (latest3.length === 0) {
    return <Text style={{ color: Colors.Text.Neutral.Default }}>—</Text>;
  }

  const safeIdx = Math.min(idx, latest3.length - 1);
  const value = latest3[safeIdx];

  return (
    <Flex
      gap={4}
      alignItems="center"
      style={{
        border: `1px solid ${Colors.Border.Neutral.Default}`,
        borderRadius: 4,
        padding: "2px 4px",
        background: Colors.Background.Container.Neutral.Default,
        width: "fit-content",
      }}
    >
      {latest3.length > 1 && (
        <Button variant="default" onClick={() => setIdx((i) => (i - 1 + latest3.length) % latest3.length)}>
          ‹
        </Button>
      )}
      <Chip color="primary" style={{ fontFamily: "monospace", fontSize: "11px", maxWidth: 200 }} title={value}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
          {value.length > 28 ? `${value.slice(0, 28)}…` : value}
        </span>
      </Chip>
      {latest3.length > 1 && (
        <>
          <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px", minWidth: 36, textAlign: "center" }}>
            {safeIdx + 1}/{latest3.length}
          </Text>
          <Button variant="default" onClick={() => setIdx((i) => (i + 1) % latest3.length)}>
            ›
          </Button>
        </>
      )}
    </Flex>
  );
};

// ─── Copy button ──────────────────────────────────────────────────────────────

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="Copy trace ID"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        border: "none",
        background: "none",
        cursor: "pointer",
        padding: "0 2px",
        display: "flex",
        alignItems: "center",
        color: copied ? Colors.Text.Primary.Default : Colors.Text.Neutral.Default,
      }}
    >
      <CopyIcon style={{ width: 14, height: 14 }} />
    </button>
  );
};

// ─── Capture Method display — splits FQN into muted package + bold Class.method ─

const CaptureMethodDisplay: React.FC<{ fqn: string }> = ({ fqn }) => {
  const parts = fqn.split(".");
  const methodPart = parts.slice(-2).join(".");
  const packagePart = parts.slice(0, -2).join(".");
  return (
    <Text style={{ fontSize: "13px", fontFamily: "monospace", wordBreak: "break-all" }}>
      {packagePart && (
        <span style={{ color: Colors.Text.Neutral.Default }}>{packagePart}.</span>
      )}
      <span style={{ color: "#9b59b6", fontWeight: 700 }}>{methodPart}</span>
    </Text>
  );
};

// ─── Traces Modal ─────────────────────────────────────────────────────────────

const TracesModal: React.FC<{
  ra: RaRecord | null;
  show: boolean;
  onClose: () => void;
  intervalLabel: string;
  env: string;
}> = ({ ra, show, onClose, intervalLabel, env }) => {
  if (!ra) return null;

  return (
    <Modal
      show={show}
      title={`Traces capturing "${ra.name}" — ${intervalLabel}`}
      onDismiss={onClose}
      size="medium"
      footer={<Button variant="emphasized" onClick={onClose}>Close</Button>}
    >
      <Flex flexDirection="column" gap={8} padding={4}>
        {ra.captureMethod && (
          <Flex flexDirection="column" gap={4}>
            <Strong style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>Capture Method</Strong>
            <CaptureMethodDisplay fqn={ra.captureMethod} />
          </Flex>
        )}
        <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>
          Showing {ra.samples.length} sample trace{ra.samples.length !== 1 ? "s" : ""}
          {ra.occurrences > ra.samples.length ? ` of ${ra.occurrences.toLocaleString()} total captures` : ""}
        </Text>
        <Flex flexDirection="column" gap={12} style={{ marginTop: 8 }}>
          {ra.samples.length === 0 ? (
            <Text style={{ color: Colors.Text.Neutral.Default }}>No trace samples available.</Text>
          ) : (
            ra.samples.map((s, i) => {
              const traceUrl = buildTraceUrl(s.traceId, env, s.timestamp);
              return (
                <Flex
                  key={i}
                  flexDirection="column"
                  gap={12}
                  padding={16}
                  style={{
                    border: `1px solid ${Colors.Border.Neutral.Default}`,
                    borderRadius: 6,
                    background: Colors.Background.Container.Neutral.Default,
                  }}
                >
                  {/* Value */}
                  <Flex flexDirection="column" gap={4}>
                    <Strong style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>Value</Strong>
                    <Flex gap={6} alignItems="center">
                      <Chip color="primary" style={{ fontFamily: "monospace", fontSize: "13px" }}>
                        {s.value}
                      </Chip>
                      {s.timestamp && (
                        <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
                          {new Date(s.timestamp).toLocaleString()}
                        </Text>
                      )}
                    </Flex>
                  </Flex>

                  {/* Endpoint */}
                  {s.spanName && (
                    <Flex flexDirection="column" gap={4}>
                      <Strong style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>Endpoint</Strong>
                      <Text style={{ fontSize: "13px" }}>{s.spanName}</Text>
                    </Flex>
                  )}

                  {/* Trace ID */}
                  <Flex flexDirection="column" gap={6}>
                    <Strong style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>Trace ID</Strong>
                    <Flex gap={6} alignItems="center">
                      <Text style={{ fontSize: "12px", fontFamily: "monospace", wordBreak: "break-all" }}>
                        {s.traceId || "—"}
                      </Text>
                      {s.traceId && <CopyButton text={s.traceId} />}
                    </Flex>
                    {traceUrl ? (
                      <Button
                        as="a"
                        href={traceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="emphasized"
                        style={{ alignSelf: "flex-start" }}
                      >
                        Open in Distributed Tracing
                        <Button.Suffix><ExternalLinkIcon /></Button.Suffix>
                      </Button>
                    ) : (
                      <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>No trace ID available</Text>
                    )}
                  </Flex>
                </Flex>
              );
            })
          )}
        </Flex>
      </Flex>
    </Modal>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export const RequestAttributes = () => {
  const [selectedInterval, setSelectedInterval] = useState("now()-1h");
  const [selectedRa, setSelectedRa] = useState<RaRecord | null>(null);

  const env = useMemo(() => getEnvironmentUrl().replace(/\/+$/, ""), []);
  const settingsUrl = buildSettingsUrl(env);

  const fnData = useMemo(() => ({ fromTime: selectedInterval }), [selectedInterval]);

  const { data: raResult, isLoading, error, refetch } = useAppFunction<RequestAttributeResult>({
    name: "getRequestAttributes",
    data: fnData,
  });

  const prevInterval = useRef(selectedInterval);
  useEffect(() => {
    if (prevInterval.current !== selectedInterval) {
      prevInterval.current = selectedInterval;
      void refetch();
    }
  }, [selectedInterval, refetch]);

  const ras: RaRecord[] = raResult?.records ?? [];
  const debugInfo = raResult?.debug;
  const intervalLabel = INTERVAL_OPTIONS.find((o) => o.value === selectedInterval)?.label ?? selectedInterval;

  const columns = useMemo<DataTableColumnDef<RaRecord>[]>(
    () => [
      {
        id: "name",
        header: "Attribute",
        accessor: "name",
        width: 260,
        cell: ({ value, rowData }: { value: string; rowData: RaRecord }) => (
          <Flex flexDirection="column" gap={4} style={{ minHeight: 40, justifyContent: "center" }}>
            <Flex gap={6} alignItems="center">
              <Strong style={{ fontSize: "13px" }}>{value}</Strong>
              <a
                href={settingsUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Open Request Attributes settings"
                style={{ color: Colors.Text.Neutral.Default, display: "flex", alignItems: "center" }}
              >
                <ExternalLinkIcon style={{ width: 12, height: 12 }} />
              </a>
            </Flex>
            <Chip color="neutral" style={{ fontSize: "11px", width: "fit-content" }}>
              {rowData.dataType}
            </Chip>
          </Flex>
        ),
      },
      {
        id: "occurrences",
        header: "Captures",
        accessor: "occurrences",
        width: 110,
        cell: ({ value }: { value: unknown }) => (
          <Text style={{ fontSize: "13px" }}>{(value as number).toLocaleString()}</Text>
        ),
      },
      {
        id: "recentValues",
        header: "Last 3 Sample Values",
        accessor: "samples",
        width: 340,
        cell: ({ value }: { value: unknown }) => (
          <ValuesCarousel samples={value as RaSample[]} />
        ),
      },
      {
        id: "traces",
        header: "",
        accessor: "id",
        width: 150,
        cell: ({ rowData }: { value: unknown; rowData: RaRecord }) => (
          <Button variant="default" onClick={() => setSelectedRa(rowData)}>
            View Traces
          </Button>
        ),
      },
    ],
    [settingsUrl],
  );

  const errorMessage = error?.message;

  return (
    <Flex flexDirection="column" gap={16} padding={32}>
      <Flex flexDirection="column" gap={8}>
        <Heading level={2}>Request Attributes</Heading>
        <Paragraph>
          Request attributes that captured data in the selected time interval, discovered by
          scanning distributed trace spans. Only attributes with observed values appear here —
          widen the interval if you expect to see more.
        </Paragraph>
      </Flex>

      <Flex gap={8} alignItems="center" flexWrap="wrap">
        <Text style={{ fontSize: "13px", color: Colors.Text.Neutral.Default }}>Interval:</Text>
        <Select
          value={selectedInterval}
          onChange={(val) => { if (val) setSelectedInterval(val as string); }}
          style={{ minWidth: 150 }}
        >
          <SelectContent>
            {INTERVAL_OPTIONS.map((opt) => (
              <SelectOption key={opt.value} value={opt.value}>{opt.label}</SelectOption>
            ))}
          </SelectContent>
        </Select>
        <Button variant="default" onClick={() => void refetch()} disabled={isLoading}>
          {isLoading ? "Scanning…" : "Refresh"}
        </Button>
        {!isLoading && (
          <Text style={{ color: Colors.Text.Neutral.Default }}>
            {ras.length > 0
              ? `${ras.length} attribute${ras.length !== 1 ? "s" : ""} captured data in ${intervalLabel}`
              : !errorMessage ? `No captured data found in ${intervalLabel}` : ""}
          </Text>
        )}
      </Flex>

      {errorMessage && (
        <Flex alignItems="center" gap={8} style={{ color: Colors.Text.Critical.Default }}>
          <CriticalIcon />
          <Paragraph>{errorMessage}</Paragraph>
        </Flex>
      )}

      {!isLoading && !errorMessage && ras.length === 0 && (
        <Flex flexDirection="column" gap={4}>
          <Paragraph style={{ color: Colors.Text.Neutral.Default }}>
            No request attributes with captured values found in {intervalLabel}. Try a wider
            interval, or confirm that services are receiving traffic and capture rules are enabled.
          </Paragraph>
          {debugInfo && (
            <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "11px", fontFamily: "monospace" }}>
              {debugInfo}
            </Text>
          )}
        </Flex>
      )}

      {ras.length > 0 && <DataTable data={ras} columns={columns} lineWrap={false} />}

      <TracesModal
        ra={selectedRa}
        show={selectedRa !== null}
        onClose={() => setSelectedRa(null)}
        intervalLabel={intervalLabel}
        env={env}
      />
    </Flex>
  );
};
