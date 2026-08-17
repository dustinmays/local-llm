import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export type FakeHandler = (request: IncomingMessage, response: ServerResponse) => void;

export type FakeUpstream = {
  url: string;
  requests: { method: string; path: string }[];
  requestBodies: unknown[];
  close(): Promise<void>;
};

export async function startFakeUpstream(handler?: FakeHandler): Promise<FakeUpstream> {
  const requests: { method: string; path: string }[] = [];
  const requestBodies: unknown[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    if (handler) {
      handler(request, response);
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.end(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fake advice" } }] }),
        );
      });
      return;
    }
    if (request.url === "/health") {
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === "/v1/models") {
      response.end(
        JSON.stringify({
          object: "list",
          ignored: "discard me",
          data: [
            {
              id: "fake-model",
              object: "model",
              created: 1,
              owned_by: "local",
              private: "discard me",
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fake server address");
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    requestBodies,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
