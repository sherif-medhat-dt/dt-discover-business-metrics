import { queryExecutionClient } from "@dynatrace-sdk/client-query";

export interface RaSample {
  value: string;
  traceId: string;
  spanName: string;
  httpMethod: string;
  timestamp: string;
}

export interface RaRecord {
  id: string;
  name: string;
  dataType: string;
  samples: RaSample[];
  occurrences: number;
  captureMethod: string;
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

function toHex(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.hex === "string") return obj.hex;
    if (typeof obj.id === "string") return obj.id;
  }
  return String(v);
}

export default async function (params?: { fromTime?: string }): Promise<RequestAttributeResult> {
  const fromTime = params?.fromTime ?? "now()-1h";

  const spanMap = new Map<
    string,
    { samples: RaSample[]; valuesSet: Set<string>; count: number; captureMethod: string }
  >();
  let spansScanned = 0;
  let dqlError = "";

  try {
    const dqlResult = await queryExecutionClient.queryExecute({
      body: {
        query: [
          `fetch spans, from:${fromTime}`,
          "| limit 10000",
          // Lookup: for each span's trace, find the innermost business-code method span.
          // A business method span has span.name == code.namespace.code.function (FQN),
          // is internal kind, and has a dotted Java/package namespace.
          "| lookup [",
          `  fetch spans, from:${fromTime}`,
          "  | filter span.kind == \"internal\"",
          "    AND isNotNull(code.namespace) AND isNotNull(code.function)",
          "    AND span.name == concat(code.namespace, \".\", code.function)",
          "    AND contains(code.namespace, \".\")",
          "    AND not(startsWith(code.namespace, \"org.springframework\"))",
          "    AND not(startsWith(code.namespace, \"org.apache\"))",
          "    AND not(startsWith(code.namespace, \"java.\"))",
          "    AND not(startsWith(code.namespace, \"javax.\"))",
          "    AND not(startsWith(code.namespace, \"sun.\"))",
          "  | fields trace.id, code.namespace, code.function",
          "], sourceField:trace.id, lookupField:trace.id, prefix:\"capture.\"",
        ].join("\n"),
        requestTimeoutMilliseconds: 25000,
        maxResultRecords: 10000,
      },
    });

    const spanRecords = (dqlResult.result?.records ?? []) as Record<string, unknown>[];
    spansScanned = spanRecords.length;

    for (const rec of spanRecords) {
      const traceId = toHex(rec["trace.id"] ?? rec["dt.trace_id"] ?? rec["traceId"] ?? "");
      const spanName = String(
        rec["span.name"] ?? rec["endpoint.name"] ?? rec["http.target"] ?? rec["name"] ?? ""
      );
      const httpMethod = String(rec["http.method"] ?? rec["http.request.method"] ?? "");
      const timestamp = rec["timestamp"] ? String(rec["timestamp"]) : "";

      // captureMethod comes from the lookup — the inner business method span for this trace.
      const captureNs = String(rec["capture.code.namespace"] ?? "");
      const captureFn = String(rec["capture.code.function"] ?? "");
      const captureMethod = captureNs && captureFn ? `${captureNs}.${captureFn}` : captureNs || captureFn;

      for (const [k, v] of Object.entries(rec)) {
        const isDtRa = k.startsWith("dt.request_attribute.");
        const isRa = isDtRa || k.startsWith("request_attribute.");
        if (!isRa || v === null || v === undefined || v === "") continue;

        const name = isDtRa
          ? k.slice("dt.request_attribute.".length)
          : k.slice("request_attribute.".length);

        const entry = spanMap.get(name) ?? {
          samples: [],
          valuesSet: new Set<string>(),
          count: 0,
          captureMethod: "",
        };
        entry.count++;

        if (!entry.captureMethod && captureMethod) {
          entry.captureMethod = captureMethod;
        }

        const strVal = String(v).slice(0, 120);
        if (entry.samples.length < 5) {
          entry.samples.push({ value: strVal, traceId, spanName, httpMethod, timestamp });
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
    captureMethod: entry.captureMethod,
  }));

  records.sort((a, b) => b.occurrences - a.occurrences);

  const debugInfo = `spansScanned=${spansScanned} | raFound=${records.length} | fromTime=${fromTime}${dqlError ? " | dqlError=" + dqlError : ""}`;

  return { records, fromTime, debug: debugInfo };
}
