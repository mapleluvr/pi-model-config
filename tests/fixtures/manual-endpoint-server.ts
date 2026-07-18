import * as http from "node:http";
import * as readline from "node:readline";

const requestedPort = Number(process.argv[2] === "--port" ? process.argv[3] : process.argv[2] ?? 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) process.exit(64);

const server = http.createServer((request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.url === "/models") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "use v1" }));
    return;
  }
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: [
        { id: "manual-alpha", name: "Manual Alpha" },
        { id: " ", name: "manual-beta" },
        { id: "manual-alpha", name: "Duplicate ignored" },
        { id: "" },
      ],
    }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(70);
  process.stdout.write(`READY http://127.0.0.1:${address.port}\n`);
});

const input = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of input) {
  if (line === "CLOSE") {
    input.close();
    server.close(() => {
      process.stdout.write("CLOSED\n");
    });
    break;
  }
}
