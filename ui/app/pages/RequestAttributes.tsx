import React, { useState, useMemo, useEffect, useRef } from "react";
import { useAppFunction } from "@dynatrace-sdk/react-hooks";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text, Strong } from "@dynatrace/strato-components/typography";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { Chip } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { Modal } from "@dynatrace/strato-components/overlays";
import { Select, SelectOption, SelectContent } from "@dynatrace/strato-components-preview/forms";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { CriticalIcon } from "@dynatrace/strato-icons";

interface RaSample {
  value: string;
  traceId: string;
  spanName: string;
  timestamp: string;
}

interface RaRecord {
  id: string;
  name: string;
  dataType: string;
  samples: RaSample[];
  occurrences: number;
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

function buildTraceUrl(traceId: string): string {
  if (!traceId) return "";
  const base = getEnvironmentUrl().replace(/\/+$/, "");
  return `${base}/ui/apps/dynatrace.classic.distributed.tracing/#uai=all;gf=all;traceId=${traceId}`;
}

// ─── Traces Modal ─────────────────────────────────────────────────────────────

function TracesModal({
  ra,
  show,
  onClose,
  intervalLabel,
}: {
  ra: RaRecord | null;
  show: boolean;
  onClose: () => void;
  intervalLabel: string;
}) {
  if (!ra) return null;

  return (
    <Modal
      show={show}
      title={`Traces capturing "${ra.name}" — ${intervalLabel}`}
      onDismiss={onClose}
      size="large"
      footer={
        <Button variant="emphasized" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Flex flexDirection="column" gap={8} padding={4}>
        {ra.samples.length === 0 ? (
          <Text style={{ color: Colors.Text.Neutral.Default }}>No trace samples available.</Text>
        ) : (
          <Flex flexDirection="column" gap={6}>
            {ra.samples.map((s, i) => (
              <Surface key={i}>
                <Flex padding={12} gap={12} alignItems="center" flexWrap="wrap">
                  <Chip
                    color="primary"
                    style={{ fontFamily: "monospace", fontSize: "12px", minWidth: 80 }}
                  >
                    {s.value}
                  </Chip>
                  <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 160 }}>
                    {s.spanName && (
                      <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>
                        {s.spanName}
                      </Text>
                    )}
                    {s.timestamp && (
                      <Text style={{ fontSize: "11px", color: Colors.Text.Neutral.Default }}>
                        {new Date(s.timestamp).toLocaleString()}
                      </Text>
                    )}
                  </Flex>
                  {s.traceId ? (
                    <a
                      href={buildTraceUrl(s.traceId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: "12px", fontFamily: "monospace", color: Colors.Text.Primary.Default }}
                    >
                      {s.traceId}
                    </a>
                  ) : (
                    <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default }}>
                      No trace ID
                    </Text>
                  )}
                </Flex>
              </Surface>
            ))}
          </Flex>
        )}
      </Flex>
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export const RequestAttributes = () => {
  const [selectedInterval, setSelectedInterval] = useState("now()-1h");
  const [selectedRa, setSelectedRa] = useState<RaRecord | null>(null);

  // Stable data object — only a new reference when the value actually changes
  const fnData = useMemo(() => ({ fromTime: selectedInterval }), [selectedInterval]);

  const {
    data: raResult,
    isLoading,
    error,
    refetch,
  } = useAppFunction<RequestAttributeResult>({
    name: "getRequestAttributes",
    data: fnData,
  });

  // Re-fetch whenever the interval changes (in case autoFetchOnUpdate doesn't fire)
  const prevInterval = useRef(selectedInterval);
  useEffect(() => {
    if (prevInterval.current !== selectedInterval) {
      prevInterval.current = selectedInterval;
      void refetch();
    }
  }, [selectedInterval, refetch]);

  const ras: RaRecord[] = raResult?.records ?? [];
  const debugInfo = raResult?.debug;

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === selectedInterval)?.label ?? selectedInterval;

  const columns = useMemo<DataTableColumnDef<RaRecord>[]>(
    () => [
      {
        id: "name",
        header: "Attribute Name",
        accessor: "name",
        cell: ({ value, rowData }: { value: string; rowData: RaRecord }) => (
          <Flex flexDirection="column" gap={2} style={{ minHeight: 36, justifyContent: "center" }}>
            <Strong style={{ fontSize: "13px" }}>{value}</Strong>
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
        cell: ({ value }: { value: unknown }) => (
          <Text style={{ fontSize: "13px" }}>{(value as number).toLocaleString()}</Text>
        ),
      },
      {
        id: "recentValues",
        header: "Recent Values",
        accessor: "samples",
        cell: ({ value }: { value: unknown }) => {
          const samples = value as RaSample[];
          // Show up to 3 distinct values
          const distinct: string[] = [];
          for (const s of samples) {
            if (!distinct.includes(s.value)) distinct.push(s.value);
            if (distinct.length >= 3) break;
          }
          if (distinct.length === 0) {
            return <Text style={{ color: Colors.Text.Neutral.Default, fontSize: "12px" }}>—</Text>;
          }
          return (
            <Flex gap={4} flexWrap="wrap">
              {distinct.map((v, i) => (
                <Chip
                  key={i}
                  color="primary"
                  style={{ fontFamily: "monospace", fontSize: "11px" }}
                >
                  {v.length > 28 ? `${v.slice(0, 28)}…` : v}
                </Chip>
              ))}
            </Flex>
          );
        },
      },
      {
        id: "traces",
        header: "",
        accessor: "id",
        cell: ({ rowData }: { value: unknown; rowData: RaRecord }) => (
          <Button variant="default" onClick={() => setSelectedRa(rowData)}>
            View Traces
          </Button>
        ),
      },
    ],
    [],
  );

  const errorMessage = error?.message;

  return (
    <Flex flexDirection="column" gap={16} padding={16}>
      {/* Header row */}
      <Flex gap={12} alignItems="flex-start" justifyContent="space-between" flexWrap="wrap">
        <Flex flexDirection="column" gap={4}>
          <Heading level={2}>Request Attributes</Heading>
          <Text style={{ color: Colors.Text.Neutral.Default }}>
            {isLoading
              ? `Scanning spans for ${intervalLabel}…`
              : errorMessage
              ? "Failed to load"
              : ras.length === 0
              ? `No request attributes captured in ${intervalLabel}`
              : `${ras.length} request attribute${ras.length !== 1 ? "s" : ""} that captured data in ${intervalLabel}`}
          </Text>
        </Flex>
        <Flex gap={8} alignItems="center">
          <Text style={{ fontSize: "13px", color: Colors.Text.Neutral.Default }}>Interval:</Text>
          <Select
            value={selectedInterval}
            onChange={(val) => {
              if (val) setSelectedInterval(val as string);
            }}
            style={{ minWidth: 150 }}
          >
            <SelectContent>
              {INTERVAL_OPTIONS.map((opt) => (
                <SelectOption key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectOption>
              ))}
            </SelectContent>
          </Select>
          {!isLoading && (
            <Button variant="default" onClick={() => void refetch()}>
              Refresh
            </Button>
          )}
        </Flex>
      </Flex>

      {/* Explanatory banner */}
      <Surface style={{ background: "rgba(55, 130, 245, 0.08)", borderLeft: "3px solid #3782F5" }}>
        <Flex padding={16} gap={12} alignItems="flex-start">
          <Flex flexDirection="column" gap={4}>
            <Strong style={{ fontSize: "13px" }}>How this works</Strong>
            <Text style={{ fontSize: "12px", color: Colors.Text.Neutral.Default, lineHeight: "1.5" }}>
              This page scans distributed trace spans to discover request attributes that actively
              captured data in the selected time interval. Only attributes with at least one recorded
              value will appear here.{" "}
              <Strong style={{ fontSize: "12px" }}>
                If an attribute is configured but has no recent traffic, it will not show up.
              </Strong>{" "}
              Widen the interval to search further back in time.
            </Text>
          </Flex>
        </Flex>
      </Surface>

      {/* Content */}
      {isLoading ? (
        <Surface>
          <Flex padding={48} justifyContent="center" alignItems="center">
            <Text style={{ color: Colors.Text.Neutral.Default }}>
              Scanning spans for captured request attribute values…
            </Text>
          </Flex>
        </Surface>
      ) : errorMessage ? (
        <Surface>
          <Flex padding={32} flexDirection="column" gap={8} alignItems="center">
            <CriticalIcon style={{ color: Colors.Text.Critical.Default }} />
            <Text style={{ color: Colors.Text.Critical.Default }}>{errorMessage}</Text>
            <Button variant="default" onClick={() => void refetch()}>
              Retry
            </Button>
          </Flex>
        </Surface>
      ) : ras.length === 0 ? (
        <Surface>
          <Flex
            padding={48}
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            gap={12}
          >
            <Heading level={3}>No Captured Data Found</Heading>
            <Paragraph
              style={{ color: Colors.Text.Neutral.Default, textAlign: "center", maxWidth: 440 }}
            >
              No request attributes were observed in spans during {intervalLabel}. Try a wider
              interval, or confirm that the services are receiving traffic and capture rules are
              enabled.
            </Paragraph>
            {debugInfo && (
              <Text
                style={{
                  color: Colors.Text.Neutral.Default,
                  fontSize: "11px",
                  fontFamily: "monospace",
                  marginTop: 4,
                }}
              >
                {debugInfo}
              </Text>
            )}
          </Flex>
        </Surface>
      ) : (
        <Surface>
          <DataTable data={ras} columns={columns} lineWrap={false} />
        </Surface>
      )}

      <TracesModal
        ra={selectedRa}
        show={selectedRa !== null}
        onClose={() => setSelectedRa(null)}
        intervalLabel={intervalLabel}
      />
    </Flex>
  );
};
