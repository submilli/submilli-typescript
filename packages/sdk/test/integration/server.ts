// A submilli-server these tests start, stop and restart themselves.
//
// It needs the `submilli-server` binary, from `$SUBMILLI_BIN` (a directory) or
// `PATH`; the tests are skipped without it. Blueprints are registered over the
// admin API, so the `submilli` CLI is not needed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, closeSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function serverBinary(): string | undefined {
  const directory = process.env.SUBMILLI_BIN;
  if (directory) {
    const path = join(directory, "submilli-server");
    return existsSync(path) ? path : undefined;
  }
  const found = spawnSync("sh", ["-c", "command -v submilli-server"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

/** Why the integration tests are skipped, or `false` when they can run. */
export const skip: string | false = serverBinary() ? false : "submilli-server not found (set SUBMILLI_BIN)";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export class ManagedServer {
  readonly home: string;
  readonly token: string = randomBytes(32).toString("hex");
  url = "";
  private readonly binary: string;
  private port = 0;
  private process: ChildProcess | undefined;

  private constructor(binary: string, config: string) {
    this.binary = binary;
    this.home = mkdtempSync(join(tmpdir(), "submilli-test-"));
    this.rotateStoreKey();
    writeFileSync(join(this.home, "server.yaml"), `secret_store:\n  key_file: ${join(this.home, "store.key")}\n${config}`);
  }

  /** Start a server in a temporary home. `config` is appended to its server.yaml. */
  static async start(config = ""): Promise<ManagedServer> {
    const binary = serverBinary();
    if (!binary) throw new Error("submilli-server not found (set SUBMILLI_BIN)");
    const server = new ManagedServer(binary, config);
    server.port = await freePort();
    server.url = `http://127.0.0.1:${server.port}`;
    await server.start();
    return server;
  }

  /** Give the server a new secret-store key; secrets sealed with the old one can't be read. */
  rotateStoreKey(): void {
    writeFileSync(join(this.home, "store.key"), randomBytes(32).toString("base64"));
  }

  async start(): Promise<void> {
    const log = openSync(join(this.home, "server.log"), "a");
    this.process = spawn(this.binary, ["--config", join(this.home, "server.yaml"), "--port", String(this.port)], {
      env: { ...process.env, SUBMILLI_HOME: this.home, SUBMILLI_SERVER_TOKEN: this.token },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${this.url}/healthz`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`submilli-server did not start; see ${join(this.home, "server.log")}`);
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Register a Blueprint over the admin API. */
  async apply(name: string, yaml: string): Promise<void> {
    const response = await fetch(`${this.url}/v1/blueprints/${name}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ yaml }),
    });
    if (!response.ok) throw new Error(`blueprint ${name}: ${response.status} ${await response.text()}`);
  }
}
