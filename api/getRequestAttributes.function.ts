import { httpClient } from "@dynatrace-sdk/http-client";

export interface RequestAttributeEntry {
  id: string;
  name: string;
}

export interface RequestAttributeResult {
  entries: RequestAttributeEntry[];
  error?: string;
}

export default async function (): Promise<RequestAttributeResult> {
  try {
    const response = await httpClient.send({
      url: "/api/config/v1/service/requestAttributes",
      method: "GET",
    });

    const body = (await response.body("json")) as { values?: RequestAttributeEntry[] };
    return {
      entries: (body?.values ?? []).filter((v) => v?.name),
    };
  } catch (e: unknown) {
    return {
      entries: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
