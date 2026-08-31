import { queryExecutionClient } from "@dynatrace-sdk/client-query";

export interface RaSample {
  value: string;
  traceId: string;
  spanName: string;
  timestamp: string;
}

export interface RaRecord {
  id: string;
  name: string;
  dataType: string;
  samples: RaSample[];
  occurrences: number;
}

export interface RequestAttributeResult {
  records: RaRecord[];
  fromTime: string;
  debug?: string;
}

function inferDataType(values: string[]): string {
  if (values.length === 0) return "STRING";
  const n = Number(values[0]);
  if (!isNaN(n) && values[0].trim() !== "") return "DOUBLE";
  if (values[0].toLowerCase() === "true" || values[0].toLowerCase() === "false") return "BOOLEAN";
  return "STRING";
}

export default async function (params?: { fromTime?: string }): Promise<RequestAttributeResult> {
  const fromTime = params?.fromTime ?? "now()-1h";

  const spanMap = new Map<
    string,
    { samples: RaSample[]; valuesSet: Set<string>; count: number }
  >();
  let spansScanned = 0;
  let dqlError = "";

  try {
    const dqlResult = await queryExecutionClient.queryExecute({
      body: {
        query: [
          `fetch spans, from:${fromTime}`,
          "| limit 10000",
        ].join("\n"),
        requestTimeoutMilliseconds: 30000,
      },
    });

    const spanRecords = (dqlResult.result?.records ?? []) as Record<string, unknown>[];
    spansScanned = spanRecords.length;

    for (const rec of spanRecords) {
      const traceId = String(
        rec["trace.id"] ?? rec["dt.trace_id"] ?? rec["traceId"] ?? ""
      );
      const spanName = String(
        rec["span.name"] ?? rec["name"] ?? rec["http.target"] ?? rec["db.statement"] ?? ""
      );
      const timestamp = rec["timestamp"] ? String(rec["timestamp"]) : "";

      for (const [k, v] of Object.entries(rec)) {
        const isRa = k.startsWith("request_attribute.") || k.startsWith("dt.request_attribute.");
        if (!isRa || v === null || v === undefined || v === "") continue;

        const name = k.startsWith("dt.request_attribute.")
          ? k.slice("dt.request_attribute.".length)
          : k.slice("request_attribute.".length);

        const entry = spanMap.get(name) ?? {
          samples: [],
          valuesSet: new Set<string>(),
          count: 0,
        };
        entry.count++;

        const strVal = String(v).slice(0, 120);
        // Keep up to 5 samples (prefer distinct values first)
        if (entry.samples.length < 5) {
          entry.samples.push({ value: strVal, traceId, spanName, timestamp });
        }
        entry.valuesSet.add(strVal);
        spanMap.set(name, entry);
      }
    }
  } catch (e) {
    dqlError = e instanceof Error ? e.message : String(e);
  }

  const records: RaRecord[] = Array.from(spanMap.entries()).map(([name, entry]) => ({
    id: name,
    name,
    dataType: inferDataType(Array.from(entry.valuesSet)),
    samples: entry.samples,
    occurrences: entry.count,
  }));

  // Sort by occurrences descending
  records.sort((a, b) => b.occurrences - a.occurrences);

  const debugInfo = `spansScanned=${spansScanned} | raFound=${records.length} | fromTime=${fromTime}${dqlError ? " | dqlError=" + dqlError : ""}`;

  return { records, fromTime, debug: debugInfo };
}
