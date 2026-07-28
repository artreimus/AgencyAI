const assert = require("node:assert/strict");
const path = require("node:path");

const Database = require("better-sqlite3");
const pty = require("node-pty");

async function smokePty() {
  const shell = process.platform === "win32"
    ? process.env.COMSPEC || "cmd.exe"
    : "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "echo|set /p=agencyai-pty-ok"]
    : ["-lc", "printf agencyai-pty-ok"];
  const child = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  let output = "";
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      reject(new Error("PTY smoke timed out"));
    }, 10_000);
    child.onData((data) => {
      output += data;
    });
    child.onExit((event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
  assert.equal(result.exitCode, 0);
  assert.match(output, /agencyai-pty-ok/);
  return {
    exitCode: result.exitCode,
    output: "agencyai-pty-ok",
  };
}

async function main() {
  const database = new Database(":memory:");
  database.exec(
    "create table native_smoke (id integer primary key, value text not null)",
  );
  database
    .prepare("insert into native_smoke (value) values (?)")
    .run("agencyai-sqlite-ok");
  const row = database
    .prepare("select value from native_smoke where id = 1")
    .get();
  database.close();
  assert.deepEqual(row, { value: "agencyai-sqlite-ok" });

  const ptyResult = await smokePty();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    electron: process.versions.electron,
    modules: process.versions.modules,
    architecture: process.arch,
    sqlite: row.value,
    pty: ptyResult.output,
    cwd: path.basename(process.cwd()),
  })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
