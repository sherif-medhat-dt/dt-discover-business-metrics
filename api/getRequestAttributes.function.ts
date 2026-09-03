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
    { samples: RaSample[]; valuesSet: Set<string>; count: number; traceIds: Set<string> }
  >();
  let spansScanned = 0;
  let methodSpansScanned = 0;
  const errors: string[] = [];

  // ── Query 1: RA discovery ────────────────────────────────────────────────────
  // Scan server spans (all RA values live on server spans). No lookup join so this
  // runs fast even at 200K records. Collects RA names, values, counts, samples, trace IDs.
  try {
    const q1 = await queryExecutionClient.queryExecute({
      body: {
        query: [
          `fetch spans, from:${fromTime}`,
          "| filter span.kind == \"server\"",
          "| limit 200000",
        ].join("\n"),
        requestTimeoutMilliseconds: 20000,
        maxResultRecords: 200000,
      },
    });

    const records = (q1.result?.records ?? []) as Record<string, unknown>[];
    spansScanned = records.length;

    for (const rec of records) {
      const traceId = toHex(rec["trace.id"] ?? rec["dt.trace_id"] ?? rec["traceId"] ?? "");
      const spanName = String(
        rec["span.name"] ?? rec["endpoint.name"] ?? rec["http.target"] ?? rec["name"] ?? ""
      );
      const httpMethod = String(rec["http.method"] ?? rec["http.request.method"] ?? "");
      const timestamp = rec["timestamp"] ? String(rec["timestamp"]) : "";

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
          traceIds: new Set<string>(),
        };
        entry.count++;
        if (traceId) entry.traceIds.add(traceId);

        const strVal = String(v).slice(0, 120);
        if (entry.samples.length < 5) {
          entry.samples.push({ value: strVal, traceId, spanName, httpMethod, timestamp });
        }
        entry.valuesSet.add(strVal);
        spanMap.set(name, entry);
      }
    }
  } catch (e) {
    errors.push("q1:" + (e instanceof Error ? e.message : String(e)));
  }

  // ── Query 2: Capture method resolution ──────────────────────────────────────
  // Scan internal method spans where span.name == FQN (class.method). No join —
  // build a traceId → captureMethod map in memory, then match against query 1 results.
  const traceMethodMap = new Map<string, string>();
  try {
    const q2 = await queryExecutionClient.queryExecute({
      body: {
        query: [
          `fetch spans, from:${fromTime}`,
          "| filter span.kind == \"internal\"",
          "  AND isNotNull(code.namespace) AND isNotNull(code.function)",
          "  AND span.name == concat(code.namespace, \".\", code.function)",
          "  AND contains(code.namespace, \".\")",
          "  AND not(startsWith(code.namespace, \"org.springframework\"))",
          "  AND not(startsWith(code.namespace, \"org.apache\"))",
          "  AND not(startsWith(code.namespace, \"java.\"))",
          "  AND not(startsWith(code.namespace, \"javax.\"))",
          "  AND not(startsWith(code.namespace, \"sun.\"))",
          "| fields trace.id, code.namespace, code.function",
          "| limit 100000",
        ].join("\n"),
        requestTimeoutMilliseconds: 20000,
        maxResultRecords: 100000,
      },
    });

    const methodRecords = (q2.result?.records ?? []) as Record<string, unknown>[];
    methodSpansScanned = methodRecords.length;

    for (const rec of methodRecords) {
      const traceId = toHex(rec["trace.id"] ?? "");
      const ns = String(rec["code.namespace"] ?? "");
      const fn = String(rec["code.function"] ?? "");
      if (traceId && ns && fn) {
        traceMethodMap.set(traceId, `${ns}.${fn}`);
      }
    }
  } catch (e) {
    errors.push("q2:" + (e instanceof Error ? e.message : String(e)));
  }

  // ── Join: assign captureMethod to each RA via trace ID overlap ───────────────
  const records: RaRecord[] = Array.from(spanMap.entries()).map(([name, entry]) => {
    let captureMethod = "";
    for (const tid of entry.traceIds) {
      const method = traceMethodMap.get(tid);
      if (method) { captureMethod = method; break; }
    }
    return {
      id: name,
      name,
      dataType: inferDataType(Array.from(entry.valuesSet)),
      samples: entry.samples,
      occurrences: entry.count,
      captureMethod,
    };
  });

  records.sort((a, b) => b.occurrences - a.occurrences);

  const debugInfo = `spansScanned=${spansScanned} | methodSpans=${methodSpansScanned} | raFound=${records.length} | fromTime=${fromTime}${errors.length ? " | errors=" + errors.join(",") : ""}`;

  return { records, fromTime, debug: debugInfo };
}
